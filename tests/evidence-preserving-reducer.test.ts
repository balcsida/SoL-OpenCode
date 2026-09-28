/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
import { journalPath } from "../src/evidence-preserving-reducer/journal.ts";
import { sessionRoot } from "../src/paths.ts";
import { shellResult, shellTool, writeTool } from "./fake-builtins.ts";
import { type CallOutcome, FakeOpenCode } from "./fake-opencode.ts";

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
	}
	await register(fake.ctx(), config, options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs });
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

	it("sends the log to the configured route through ctx.generate.text", async () => {
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
		const { dataHome, fake } = await setup();
		fake.generateText = async () => {
			throw Object.assign(new Error("Model unavailable: openai/gpt-5.6-luna"), { _tag: "Generate.ModelSelectionError" });
		};
		const result = await shellCall(fake, "pytest -q", { output: BODY, exit: 1 });
		expect(texts(result)[0]).toBe(BODY);
		expect((await journal()).at(-1)).toMatchObject({ kind: "fallback", reason: "reducer-model-unavailable" });
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
