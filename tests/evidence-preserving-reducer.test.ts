/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { register as registerActionFusion } from "../src/action-fusion/index.ts";
import { DEFAULT_CONFIG, type SolPiConfig } from "../src/config.ts";
import type { ToolResult } from "../src/context.ts";
import {
	DIAGNOSTIC_COMMAND,
	loadReducerConfig,
	REDUCER_RECEIPT_PREFIX,
	REDUCER_RECEIPT_SCHEMA,
	register,
} from "../src/evidence-preserving-reducer/index.ts";
import { archivePath } from "../src/evidence-preserving-reducer/archive.ts";
import { containsLikelySecret } from "../src/evidence-preserving-reducer/config.ts";
import { journalPath } from "../src/evidence-preserving-reducer/journal.ts";
import { sessionRoot } from "../src/paths.ts";
import { shellResult, shellTool, writeTool } from "./fake-builtins.ts";
import { type CallOutcome, contextEvent, FakeOpenCode } from "./fake-opencode.ts";

const SESSION = "ses_reducer";
const cleanupPaths: string[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0)) cleanup();
	await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
	const value = await mkdtemp(join(tmpdir(), "evidence-preserving-reducer-test-"));
	cleanupPaths.push(value);
	return value;
}

interface ModelReceipt {
	schema: string;
	source_sha256: string;
	status: "success" | "failure";
	uncertain: boolean;
	evidence: { kind: string; quote: string }[];
}

function sourceHash(prompt: string): string {
	const match = prompt.match(/source_sha256=([a-f0-9]{64})/u);
	if (!match?.[1]) throw new Error("request omitted source hash");
	return match[1];
}

function receiptModel(receipt: (prompt: string) => ModelReceipt) {
	const calls: { prompt: string; model?: { providerID: string; id: string } }[] = [];
	const generate = async (input: { prompt: string; model?: { providerID: string; id: string } }) => {
		calls.push(input);
		return { text: JSON.stringify(receipt(input.prompt)) };
	};
	return { calls, generate };
}

function failureReceipt(quote: string) {
	return (prompt: string): ModelReceipt => ({
		schema: REDUCER_RECEIPT_SCHEMA,
		source_sha256: sourceHash(prompt),
		status: "failure",
		uncertain: false,
		evidence: [{ kind: "failure", quote }],
	});
}

async function setup(
	options: { config?: Partial<SolPiConfig>; timeoutMs?: number; actionFusion?: boolean; shell?: Parameters<typeof shellTool>[0] } = {},
) {
	const dataHome = await temporaryDirectory();
	vi.stubEnv("XDG_DATA_HOME", dataHome);
	const directory = await temporaryDirectory();
	const fake = new FakeOpenCode(directory);
	const config = { ...DEFAULT_CONFIG, evidencePreservingReducer: true, ...options.config };
	if (options.actionFusion) {
		fake.seedTool(writeTool(directory));
		fake.seedTool(shellTool(options.shell ?? (async () => ({ output: "", exit: 0 }))));
		cleanups.push(await registerActionFusion(fake.ctx(), config));
		// The agent loop offers the agent its tools before any tool call.
		const tool = { description: "tool", input: { type: "object", properties: {} } };
		await fake.runSessionHook("context", contextEvent(SESSION, [], { tools: { write: tool, shell: tool } }));
	}
	await register(fake.ctx(), config, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }, fake.report);
	return { dataHome, directory, fake };
}

/** Deliver a finished shell call to the execute.after hooks. */
async function shellCall(fake: FakeOpenCode, command: string, run: Parameters<typeof shellResult>[0], sessionID = SESSION) {
	fake.seedTool({
		name: "shell",
		description: "shell",
		input: {},
		execute: async () => shellResult(run),
	});
	const outcome = await fake.callTool("shell", { command }, { sessionID, id: "call-1" });
	return completed(outcome);
}

function completed(outcome: CallOutcome): ToolResult {
	if (outcome.status !== "completed") throw new Error(`expected completed, got ${outcome.status}`);
	return outcome.result;
}

function texts(result: ToolResult): string[] {
	const content = result.content;
	if (typeof content === "string") return [content];
	return (content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : []));
}

async function journal(sessionID = SESSION): Promise<Record<string, unknown>[]> {
	const path = journalPath(loadReducerConfig(sessionRoot(sessionID)));
	return (await readFile(path, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const SIGNAL = "ERROR test target failed";
const BODY = `${SIGNAL}\n${"diagnostic output\n".repeat(400)}`;

describe("evidence-preserving reducer", () => {
	it("registers evidence_recall and one execute.after hook without a credential of its own", async () => {
		const { fake } = await setup();
		expect([...fake.tools.keys()]).toEqual(["evidence_recall"]);
		expect(fake.toolHooks["execute.after"]).toHaveLength(1);
	});

	it("keeps the diagnostic command trigger generic", () => {
		expect(DIAGNOSTIC_COMMAND.test("pytest -q")).toBe(true);
		expect(DIAGNOSTIC_COMMAND.test("lake build")).toBe(true);
		expect(DIAGNOSTIC_COMMAND.test("cargo test --all")).toBe(true);
		expect(DIAGNOSTIC_COMMAND.test("rg test src")).toBe(false);
	});

	it("sends the log to the configured route through ctx.experimental.generate.text", async () => {
		const { fake } = await setup({
			config: { evidencePreservingReducerProvider: "test-provider", evidencePreservingReducerModel: "test-reducer" },
		});
		const model = receiptModel(failureReceipt(SIGNAL));
		fake.generateText = model.generate;
		await shellCall(fake, "pytest -q", { output: BODY, exit: 1 });

		expect(model.calls).toHaveLength(1);
		expect(model.calls[0]?.model).toEqual({ providerID: "test-provider", id: "test-reducer" });
		expect(model.calls[0]?.prompt).toMatch(/^You are a lossless test\/build output reducer\./u);
		expect(model.calls[0]?.prompt).toContain("is_error=true");
		expect(model.calls[0]?.prompt).toContain(`<untrusted_log>\n${BODY}\n</untrusted_log>`);
		expect(fake.rpcEvents).toHaveLength(1);
		expect(fake.rpcEvents[0]).toMatchObject({
			name: "saving",
			data: { sessionID: SESSION, mechanism: "Evidence-Preserving Reducer" },
		});
		expect((fake.rpcEvents[0]?.data as { saving: string }).saving).toMatch(/removed from future prompts$/u);
	});

	it("accepts only verified exact quotes and keeps SoL-Pi's on-disk identifiers", async () => {
		const { dataHome, fake } = await setup();
		fake.generateText = receiptModel(failureReceipt(SIGNAL)).generate;
		const result = await shellCall(fake, "pytest -q", { output: `prefix\n${BODY}`, exit: 1 });

		const [receipt, notice] = texts(result);
		expect(receipt).toMatch(new RegExp(`^${REDUCER_RECEIPT_PREFIX}\\n`, "u"));
		expect(receipt).toMatch(/status=failure/u);
		expect(receipt).toMatch(/line=2/u);
		expect(receipt).toContain("reducer_provider=openai");
		expect(receipt).toContain("reducer_model=gpt-5.6-luna");
		expect(receipt).toContain("reducer_total_tokens=unavailable");
		expect(receipt).toMatch(/authority=Sol retains diagnosis/u);
		expect(receipt).toMatch(/readback=call evidence_recall with \{"source_sha256":"[a-f0-9]{64}","offset":0\}/u);
		expect(notice).toBe("Exited with code 1");
		expect(Buffer.byteLength(receipt!)).toBeLessThan(Buffer.byteLength(BODY));
		expect(result.metadata).toMatchObject({ exit: 1, evidencePreservingReducer: { schema: REDUCER_RECEIPT_SCHEMA } });
		expect(result.output).toMatchObject({ output: `prefix\n${BODY}` });

		const events = await journal();
		expect(events.map((event) => event.kind)).toEqual(["candidate", "provider_response", "applied"]);
		expect(events[0]).toMatchObject({ type: "sol-pi-evidence-preserving-reducer-v1", schema: "sol-pi-evidence-preserving-reducer/1" });
		const sourcePath = String(events[0]?.sourcePath);
		expect(sourcePath.startsWith(join(dataHome, "opencode", "sol-opencode", SESSION))).toBe(true);
		expect(await readFile(sourcePath, "utf8")).toBe(`prefix\n${BODY}`);
		expect((await stat(sourcePath)).mode & 0o777).toBe(0o600);
	});

	it("recalls the archived original page by page", async () => {
		const { fake } = await setup();
		fake.generateText = receiptModel(failureReceipt(SIGNAL)).generate;
		const result = await shellCall(fake, "pytest -q", { output: BODY, exit: 1 });
		const hash = texts(result)[0]?.match(/source_sha256=([a-f0-9]{64})/u)?.[1];

		let offset = 0;
		let recalled = "";
		for (;;) {
			const page = completed(await fake.callTool("evidence_recall", { source_sha256: hash, offset }, { sessionID: SESSION, id: "r" }));
			const output = page.content as string;
			recalled += output.slice(output.indexOf("\n", output.indexOf("\n") + 1) + 1);
			const details = page.metadata as { eof: boolean; nextOffset: number };
			offset = details.nextOffset;
			if (details.eof) break;
		}
		expect(recalled).toBe(BODY);

		const unknown = completed(
			await fake.callTool("evidence_recall", { source_sha256: "0".repeat(64) }, { sessionID: SESSION, id: "r2" }),
		);
		expect(unknown.content).toBe(`Unknown evidence source: ${"0".repeat(64)}`);
	});

	it.each([false, true])("reduces the command output of a fused write (command failed: %s)", async (failed) => {
		const { fake } = await setup({
			actionFusion: true,
			shell: async () => ({ output: BODY, exit: failed ? 1 : 0 }),
		});
		fake.generateText = receiptModel((prompt) => ({
			schema: REDUCER_RECEIPT_SCHEMA,
			source_sha256: sourceHash(prompt),
			status: failed ? "failure" : "success",
			uncertain: false,
			evidence: [{ kind: failed ? "failure" : "summary", quote: SIGNAL }],
		})).generate;

		const result = completed(
			await fake.callTool(
				"write",
				{ path: "target.ts", content: "export {};\n", then_run: { command: "npm test" } },
				{ sessionID: SESSION, id: "write-1" },
			),
		);
		const [confirmation, fused] = texts(result);
		expect(confirmation).toBe("Created file successfully: target.ts");
		expect(fused).toMatch(failed ? /^\[then_run:failed\]\nsol_pi_evidence_receipt_v1\n/u : /^\[then_run:succeeded\]\nsol_pi_evidence_receipt_v1\n/u);
		expect(fused).toContain(`status=${failed ? "failure" : "success"}`);
		expect(fused).not.toContain("diagnostic output");
		expect(result.metadata).toMatchObject({ thenRun: { command: "npm test" }, evidencePreservingReducer: {} });
	});

	it.each(["invented", "model-error"] as const)("fails open on %s", async (mode) => {
		const { dataHome, fake } = await setup();
		fake.generateText =
			mode === "invented"
				? receiptModel(failureReceipt("a quote that is not in the log")).generate
				: async () => {
						throw new Error("provider exploded");
					};
		const result = await shellCall(fake, "pytest -q", { output: BODY, exit: 1 });

		expect(texts(result)).toEqual([BODY, "Exited with code 1"]);
		expect((await journal()).at(-1)).toMatchObject({
			kind: "fallback",
			reason: mode === "invented" ? "unverifiable-quote" : "model-call-exception",
		});
	});

	it("fails open when OpenCode cannot select the configured reducer model", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const { dataHome, fake } = await setup();
		let calls = 0;
		fake.generateText = async () => {
			calls++;
			throw Object.assign(new Error("Model unavailable: openai/gpt-5.6-luna"), { _tag: "Generate.ModelSelectionError" });
		};
		const result = await shellCall(fake, "pytest -q", { output: BODY, exit: 1 });
		expect(texts(result)[0]).toBe(BODY);
		expect(fake.rpcEvents).toEqual([]);
		expect((await journal()).at(-1)).toMatchObject({ kind: "fallback", reason: "reducer-model-unavailable" });

		// The next call would fail the same way: later logs are neither archived nor sent, and the user is told once.
		const entries = (await journal()).length;
		const later = `${BODY}later run\n`;
		expect(texts(await shellCall(fake, "pytest -q", { output: later, exit: 1 }))[0]).toBe(later);
		expect(calls).toBe(1);
		expect((await journal()).length).toBe(entries);
		expect(logged.mock.calls.map(([line]) => String(line))).toEqual([
			expect.stringContaining("Reducer model is unavailable: openai/"),
		]);

		// The user may have signed in to the provider meanwhile, so the model is tried again later.
		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
		await shellCall(fake, "pytest -q", { output: later, exit: 1 });
		expect(calls).toBe(2);
	});

	it("keeps a log that looks like it carries a credential away from the reducer model", () => {
		// Assembled here so that no token-shaped literal sits in the repository.
		const word = (length: number) => "a1B2c3D4".repeat(8).slice(0, length);
		const credentials = [
			"API_KEY=whatever",
			"Authorization: Basic dXNlcjpwYXNz",
			"client_secret: x",
			'"secret_key": "abc"',
			'password = "hunter2"',
			'"password": "hunter2"',
			"login(user, password='hunter2')",
			'private_key = "MIIEvQIBADANBg"',
			"DB_PASSWD=hunter2",
			"MYSQL_ROOT_PASSWORD=hunter2x",
			"Server=db;User Id=app;Password=p@ssw0rd;",
			`DefaultEndpointsProtocol=https;AccountName=a;AccountKey=${word(24)}==`,
			`//registry.npmjs.org/:_authToken=${word(12)}`,
			`curl -H "X-Auth: Bearer ${word(24)}"`,
			`AWS_SESSION_TOKEN=${word(24)}`,
			`SIGNING_KEY=${word(12)}`,
			"mysql --user root --password hunter2 app",
			"deploy --token=abcd1234",
			`GET /download?file=a&token=${word(12)}`,
			`https://storage.example/blob?sv=1&sig=${word(20)}`,
			"jdbc:mysql://db/app?user=app&password=hunter2",
			`fatal: unable to access 'https://x-access-token:${word(20)}@github.com/o/r.git/'`,
			`postgres://app:${word(8)}@db.internal:5432/app`,
			`redis://:${word(8)}@cache:6379`,
			"-----BEGIN OPENSSH PRIVATE KEY-----",
			"-----BEGIN PRIVATE KEY-----",
			"-----BEGIN PGP PRIVATE KEY BLOCK-----",
			`${"AK"}IA${"ABCDEFGHIJKLMNOP"}`,
			`gh${"p_"}${word(36)}`,
			`gh${"s_"}${word(36)}`,
			`github_${"pat_"}${word(30)}`,
			`glp${"at-"}${word(20)}`,
			`s${"k-"}ant-api03-${word(40)}`,
			`s${"k-"}proj-${word(40)}`,
			`sk_${"live_"}${word(24)}`,
			`xox${"b-"}123456789012-${word(12)}`,
			`AI${"za"}${word(35)}`,
			`ya${"29."}${word(40)}`,
			`np${"m_"}${word(36)}`,
			`h${"f_"}${word(34)}`,
			`ey${"J"}${word(20)}.ey${"J"}${word(40)}.${word(30)}`,
		];
		for (const credential of credentials) {
			expect(containsLikelySecret(`building\n  ${credential}\ndone\n`), credential).toBe(true);
		}

		// What a test or build log prints all the time. Refusing these would switch the reducer off for whole projects.
		const ordinary = [
			"error: unexpected token `}` at src/main.rs:3:1",
			"SyntaxError: Unexpected token ':' in JSON at position 4",
			"tests/test_password.py::test_reset PASSED",
			"tests/test_auth.py::TestPassword::test_reset FAILED",
			"assert password == expected",
			">       password = make_password(raw)",
			"    def login(self, password: str) -> bool:",
			"error TS2322: Type '{ password: string; }' is not assignable to type 'Credentials'.",
			'    user = User(name="x", password=password)',
			"ERROR 1045 (28000): Access denied for user 'root'@'localhost' (using password: YES)",
			'FATAL: password authentication failed for user "app"',
			"  <Table rowKey={row.id} sortKey={sortKey} csrfToken={token} />",
			"usage: deploy --token <token> [--password <password>]",
			"GET http://localhost:3000/@scope/pkg 404",
			"Cloning git+ssh://git@github.com:org/repo.git",
			"   Compiling task-runner v0.1.0 (/work/disk-usage-report)",
			"see https://example.com/docs?key=1&page=2",
			"make: *** [Makefile:12: check] Error 2",
			"KEY=abc",
			"error[E0308]: mismatched types: expected `Token`, found `Key`",
			"eyJ is the start of a base64 JSON object",
		];
		for (const line of ordinary) expect(containsLikelySecret(`${line}\n`), line).toBe(false);
	});

	it("scans a log built to stall the credential patterns in linear time", () => {
		const size = 600_000;
		const stallers = ["a", "A", ":", "/", "-", " ", "\n", "://", "://a:", "secret", "password ", 'password="', "bearer ", "KEY=", "Password=", "?key=", "--token ", " eyJ", "-eyJ", `eyJ${"a".repeat(511)}`, "-----BEGIN ", "sk-", " gh", "AKIA", `://${"a".repeat(255)}`];
		for (const staller of stallers) {
			const text = staller.repeat(Math.ceil(size / staller.length));
			const started = performance.now();
			containsLikelySecret(text);
			// A quadratic pattern takes minutes here; a linear one takes milliseconds.
			expect(performance.now() - started, JSON.stringify(staller.slice(0, 12))).toBeLessThan(2_000);
		}
	});

	it("leaves a runaway full-output file on disk instead of reading it", async () => {
		const { dataHome, fake } = await setup();
		const shellDirectory = join(dataHome, "opencode", "shell", fake.projectID);
		await mkdir(shellDirectory, { recursive: true });
		const huge = join(shellDirectory, "sh_0123456789ab.out");
		await writeFile(huge, "");
		// Past the limit of three bytes per accepted character; a real runaway log is gigabytes.
		await truncate(huge, 4 * 1024 ** 2);
		let calls = 0;
		fake.generateText = async () => {
			calls++;
			return { text: "{}" };
		};
		const inline = `${"diagnostic tail\n".repeat(300)}${SIGNAL}\n\n[showing lines 301-900 of 900; full output saved to ${huge}]`;
		const result = await shellCall(fake, "pytest -q", { output: inline, exit: 1, truncated: true });
		expect(texts(result)[0]).toBe(inline);
		expect(calls).toBe(0);
		expect((await journal()).at(-1)).toMatchObject({ kind: "fallback", reason: "source-over-max-chars" });

		// A command that is not a build or a test is not even looked at, however its output was saved.
		const entries = (await journal()).length;
		expect(texts(await shellCall(fake, "cat big.log", { output: inline, exit: 0, truncated: true }))[0]).toBe(inline);
		expect((await journal()).length).toBe(entries);
	});

	it("archives a log once, whole, and refuses an archive that no longer matches it", async () => {
		const { fake } = await setup();
		const model = receiptModel(failureReceipt(SIGNAL));
		fake.generateText = model.generate;
		// A preview cut inside a surrogate pair is stored as U+FFFD; the same log must still match its archive.
		const body = `${BODY}cut \ud83d`;
		for (let run = 0; run < 2; run++) {
			expect(texts(await shellCall(fake, "pytest -q", { output: body, exit: 1 }))[0]).toContain(REDUCER_RECEIPT_PREFIX);
		}
		const root = loadReducerConfig(sessionRoot(SESSION)).storeRoot;
		const hash = sourceHash(model.calls[0]!.prompt);
		const path = archivePath(root, hash);
		expect(await readdir(join(path, ".."))).toEqual([`${hash}.txt`]);
		if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);

		await writeFile(path, "truncated");
		expect(texts(await shellCall(fake, "pytest -q", { output: body, exit: 1 }))[0]).toBe(body);
		expect((await journal()).at(-1)).toMatchObject({
			kind: "fallback",
			reason: "reducer-exception",
			errorMessage: expect.stringContaining("integrity failure"),
		});
	});

	it.skipIf(process.platform === "win32")("tells the model the error code of a failed readback, not the path on this machine", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const { dataHome, fake } = await setup();
		const model = receiptModel(failureReceipt(SIGNAL));
		fake.generateText = model.generate;
		await shellCall(fake, "pytest -q", { output: BODY, exit: 1 });
		const hash = sourceHash(model.calls[0]!.prompt);
		const path = archivePath(loadReducerConfig(sessionRoot(SESSION)).storeRoot, hash);
		await rm(path);
		await symlink(join(dataHome, "elsewhere"), path);

		const outcome = completed(await fake.callTool("evidence_recall", { source_sha256: hash }, { sessionID: SESSION, id: "r1" }));
		expect(outcome.content).toBe(`evidence_recall failed for ${hash}: ELOOP`);
		expect(JSON.stringify(outcome)).not.toContain(dataHome);
		expect(String(logged.mock.calls.at(-1)?.[0])).toContain(dataHome);
		for (const offset of [-1, 0.5]) {
			const refused = completed(
				await fake.callTool("evidence_recall", { source_sha256: hash, offset }, { sessionID: SESSION, id: "r2" }),
			);
			expect(refused.content).toBe(`evidence_recall failed for ${hash}: offset must be a non-negative integer`);
		}
	});

	it("removes a deleted session's archive and journal", async () => {
		const { dataHome, fake } = await setup();
		fake.generateText = receiptModel(failureReceipt(SIGNAL)).generate;
		await shellCall(fake, "pytest -q", { output: BODY, exit: 1 });
		await shellCall(fake, "pytest -q", { output: BODY, exit: 1 }, "ses_other");
		const sessions = join(dataHome, "opencode", "sol-opencode");
		expect((await readdir(sessions)).sort()).toEqual(["ses_other", SESSION]);

		fake.emit({ type: "session.deleted", data: { sessionID: SESSION } });
		await vi.waitFor(async () => expect(await readdir(sessions)).toEqual(["ses_other"]));
	});

	it("fails open when the reducer call times out", async () => {
		const { dataHome, fake } = await setup({ timeoutMs: 20 });
		fake.generateText = () => new Promise(() => {});
		const result = await shellCall(fake, "pytest -q", { output: BODY, exit: 1 });
		expect(texts(result)[0]).toBe(BODY);
		expect((await journal()).at(-1)).toMatchObject({ kind: "fallback", reason: "model-call-timeout" });
	});

	it("fails open for a session id that cannot name a storage directory", async () => {
		const { fake } = await setup();
		let calls = 0;
		fake.generateText = async () => {
			calls++;
			return { text: "{}" };
		};
		const result = await shellCall(fake, "pytest -q", { output: BODY, exit: 1 }, "../escape");
		expect(texts(result)[0]).toBe(BODY);
		expect(calls).toBe(0);
	});

	it("reads only OpenCode's own shell output files for a truncated result", async () => {
		const { dataHome, fake } = await setup();
		const shellDirectory = join(dataHome, "opencode", "shell", fake.projectID);
		await mkdir(shellDirectory, { recursive: true });
		const fullBody = `${SIGNAL}\n${"complete diagnostic line\n".repeat(600)}`;
		const safe = join(shellDirectory, "sh_0123456789ab.out");
		await writeFile(safe, fullBody);
		const outside = join(await temporaryDirectory(), "sh_0123456789ab.out");
		await writeFile(outside, "ERROR outside file\n".repeat(600));
		const linked = join(shellDirectory, "sh_aaaaaaaaaaaa.out");
		await symlink(outside, linked);
		const model = receiptModel(failureReceipt(SIGNAL));
		fake.generateText = model.generate;

		const tail = `${"diagnostic tail\n".repeat(300)}${SIGNAL}`;
		const notice = (path: string) => `${tail}\n\n[showing lines 301-900 of 900; full output saved to ${path}]`;

		await shellCall(fake, "pytest -q", { output: notice(safe), exit: 1, truncated: true });
		expect(model.calls.at(-1)?.prompt).toContain(`<untrusted_log>\n${fullBody}\n</untrusted_log>`);

		for (const path of [outside, linked]) {
			await shellCall(fake, "pytest -q", { output: notice(path), exit: 1, truncated: true });
			expect(model.calls.at(-1)?.prompt).toContain(`<untrusted_log>\n${notice(path)}\n</untrusted_log>`);
		}

		// Without OpenCode's truncated flag a notice inside the log is just text.
		await shellCall(fake, "pytest -q", { output: notice(safe), exit: 1 });
		expect(model.calls.at(-1)?.prompt).toContain(`<untrusted_log>\n${notice(safe)}\n</untrusted_log>`);
	});

	it("does not delegate small, non-diagnostic, secret-looking, or background output", async () => {
		const { dataHome, fake } = await setup();
		let calls = 0;
		fake.generateText = async () => {
			calls++;
			return { text: "{}" };
		};
		expect(texts(await shellCall(fake, "pytest -q", { output: "ERROR short", exit: 1 }))[0]).toBe("ERROR short");
		expect(texts(await shellCall(fake, "cat build.log", { output: BODY, exit: 0 }))[0]).toBe(BODY);
		const secret = `${BODY}API_KEY=sk-not-a-real-key\n`;
		expect(texts(await shellCall(fake, "pytest -q", { output: secret, exit: 1 }))[0]).toBe(secret);
		expect((await journal()).at(-1)).toMatchObject({ kind: "fallback", reason: "likely-secret" });

		fake.seedTool({
			name: "shell",
			description: "shell",
			input: {},
			execute: async () => ({
				output: { output: "Command moved to the background", truncated: false, status: "running" },
				content: [{ type: "text", text: BODY }],
				metadata: { status: "running" },
			}),
		});
		completed(await fake.callTool("shell", { command: "pytest -q", background: true }, { sessionID: SESSION, id: "bg" }));
		expect(calls).toBe(0);
	});
});
