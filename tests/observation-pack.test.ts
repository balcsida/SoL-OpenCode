/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { LLMMessage, ToolResultPart } from "../src/context.ts";
import { toolResultText } from "../src/messages.ts";
import { FULL_SENDS, register, THRESHOLD_BYTES } from "../src/observation-pack/index.ts";
import {
	assistantMessage,
	contextEvent,
	FakeOpenCode,
	toolCallPart,
	toolErrorMessage,
	toolResultMessage,
	userMessage,
} from "./fake-opencode.ts";

const roots: string[] = [];
const SESSION_ID = "ses_a";

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
	const value = await mkdtemp(join(tmpdir(), "observationpack-test-"));
	roots.push(value);
	return value;
}

async function setup(): Promise<{ fake: FakeOpenCode; dataHome: string }> {
	const dataHome = await temporaryDirectory();
	vi.stubEnv("XDG_DATA_HOME", dataHome);
	const fake = new FakeOpenCode(await temporaryDirectory());
	await register(fake.ctx(), { ...DEFAULT_CONFIG, observationPack: true });
	return { fake, dataHome };
}

async function restart(fake: FakeOpenCode): Promise<FakeOpenCode> {
	const resumed = new FakeOpenCode(fake.directory);
	await register(resumed.ctx(), { ...DEFAULT_CONFIG, observationPack: true });
	return resumed;
}

function repeatPastThreshold(line: string): string {
	return line.repeat(Math.ceil((THRESHOLD_BYTES + 1) / Buffer.byteLength(line, "utf8")));
}

function resultPart(message: unknown): ToolResultPart {
	const part = (message as LLMMessage).content.find((item) => item.type === "tool-result");
	if (!part || part.type !== "tool-result") throw new Error("expected tool result");
	return part;
}

function resultText(message: unknown): string {
	const part = resultPart(message);
	const text = toolResultText(part);
	if (text !== undefined) return text;
	return JSON.stringify(part.result.value);
}

function observationId(toolName: string, toolCallId: string, text: string): string {
	const contentHash = createHash("sha256").update(text).digest("hex");
	return `obs_${createHash("sha256").update(`${toolName}\0${toolCallId}\0${contentHash}`).digest("hex").slice(0, 24)}`;
}

function objectsDirectory(dataHome: string, sessionID = SESSION_ID): string {
	return join(dataHome, "opencode", "sol-opencode", sessionID, "observation-pack", "objects");
}

function observationPath(dataHome: string, id: string, sessionID = SESSION_ID): string {
	return join(objectsDirectory(dataHome, sessionID), `${id}.txt`);
}

async function projectMessages(fake: FakeOpenCode, messages: unknown[], sessionID = SESSION_ID): Promise<unknown[]> {
	const event = contextEvent(sessionID, [...messages]);
	await fake.runSessionHook("context", event);
	return event.messages;
}

async function project(fake: FakeOpenCode, message: unknown, count: number, sessionID = SESSION_ID): Promise<string[]> {
	const projected: string[] = [];
	for (let index = 0; index < count; index += 1) {
		const messages = await projectMessages(fake, [message], sessionID);
		projected.push(resultText(messages[0]));
	}
	return projected;
}

async function recall(fake: FakeOpenCode, id: string, offset = 0, sessionID = SESSION_ID) {
	const outcome = await fake.callTool("obs_recall", { id, offset }, { sessionID, id: `recall-${offset}` });
	if (outcome.status !== "completed") throw new Error(`recall ${outcome.status}`);
	return outcome.result;
}

function captureConsoleErrors(): string[] {
	const errors: string[] = [];
	vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
		errors.push(values.map(String).join(" "));
	});
	return errors;
}

describe("observation pack", () => {
	it("registers obs_recall and one context hook", async () => {
		const { fake } = await setup();
		expect([...fake.tools.keys()]).toEqual(["obs_recall"]);
		expect(fake.sessionHooks.get("context")).toHaveLength(1);
		expect(fake.sessionHooks.get("generate")).toBeUndefined();
	});

	it("keeps the first two requests full and reuses one stable placeholder afterwards", async () => {
		const { fake, dataHome } = await setup();
		const body = `head line\n${repeatPastThreshold("middle line\n")}tail line\n`;
		const message = toolResultMessage("call-1", "shell", body);
		const history = structuredClone(message);
		const projected = await project(fake, message, 4);

		expect(FULL_SENDS).toBe(2);
		expect(projected[0]).toBe(body);
		expect(projected[1]).toBe(body);
		expect(projected[2]).not.toBe(body);
		expect(projected[2]).toBe(projected[3]);
		expect(projected[2]).toMatch(/^\[large tool result replaced/u);
		expect(projected[2]).toMatch(/head line/u);
		expect(projected[2]).toMatch(/tail line/u);
		expect(message).toEqual(history);

		const id = projected[2]?.match(/id: (obs_[a-f0-9]{24})/u)?.[1];
		expect(id).toBe(observationId("shell", "call-1", body));
		expect(await readFile(observationPath(dataHome, id!), "utf8")).toBe(body);
		const ledger = await readFile(join(objectsDirectory(dataHome), "..", "ledger.jsonl"), "utf8");
		expect(ledger.trim().split("\n").map((line) => JSON.parse(line).event)).toEqual([
			"full",
			"full",
			"placeholder",
			"placeholder",
		]);
	});

	it("changes only the outgoing request, never the history array's messages", async () => {
		const { fake } = await setup();
		const body = repeatPastThreshold("history line\n");
		const history = [
			userMessage("run it", "msg_user"),
			assistantMessage("msg_assistant", [toolCallPart("call-1", "shell", { command: "cat big" })]),
			toolResultMessage("call-1", "shell", body),
			assistantMessage("msg_a2", [{ type: "text", text: "read it" }]),
			assistantMessage("msg_a3", [{ type: "text", text: "still reading" }]),
		];
		const snapshot = structuredClone(history);
		const projected = await projectMessages(fake, history);

		expect(history).toEqual(snapshot);
		expect(projected[2]).not.toBe(history[2]);
		expect(resultText(projected[2])).toMatch(/^\[large tool result replaced/u);
		expect(projected[0]).toBe(history[0]);
		expect(projected[1]).toBe(history[1]);
	});

	it("counts requests already answered from the assistant messages that follow a result", async () => {
		const { fake } = await setup();
		const body = repeatPastThreshold("answered line\n");
		const answeredTwice = [
			toolResultMessage("call-1", "shell", body),
			assistantMessage("msg_a1", [{ type: "text", text: "one" }]),
			assistantMessage("msg_a2", [{ type: "text", text: "two" }]),
		];
		expect(resultText((await projectMessages(fake, answeredTwice))[0])).toMatch(/^\[large tool result replaced/u);
	});

	it("isolates objects and send counters by OpenCode session", async () => {
		const { fake, dataHome } = await setup();
		const body = `session isolation\n${repeatPastThreshold("separate bytes\n")}`;
		const message = toolResultMessage("call-1", "shell", body);
		const id = observationId("shell", "call-1", body);

		for (const sessionID of ["ses_a", "ses_b"]) {
			expect(await project(fake, message, 2, sessionID)).toEqual([body, body]);
			expect((await project(fake, message, 1, sessionID))[0]).toMatch(/^\[large tool result replaced/u);
		}

		expect(await readFile(observationPath(dataHome, id, "ses_a"), "utf8")).toBe(body);
		expect(await readFile(observationPath(dataHome, id, "ses_b"), "utf8")).toBe(body);
	});

	it("breaks the prefix once per observation without remutating older placeholders", async () => {
		const { fake } = await setup();
		const first = toolResultMessage("first", "shell", `first\n${"a".repeat(THRESHOLD_BYTES + 100)}\n`);
		const second = toolResultMessage("second", "shell", `second\n${"b".repeat(THRESHOLD_BYTES + 100)}\n`);
		const firstSends = await project(fake, first, 3);
		const oldPlaceholder = firstSends[2];
		expect(oldPlaceholder).toBeTruthy();

		const combined: string[][] = [];
		for (let index = 0; index < 3; index += 1) {
			combined.push((await projectMessages(fake, [first, second])).map(resultText));
		}

		expect(combined.map((request) => request[0])).toEqual([oldPlaceholder, oldPlaceholder, oldPlaceholder]);
		expect(combined[0]?.[1]).toBe(resultText(second));
		expect(combined[1]?.[1]).toBe(resultText(second));
		expect(combined[2]?.[1]).not.toBe(resultText(second));
	});

	it("recalls from durable storage after a plugin restart", async () => {
		const { fake } = await setup();
		const body = `durable observation\n${repeatPastThreshold("recall line\n")}`;
		const projected = await project(fake, toolResultMessage("call-1", "shell", body), 3);
		const id = projected[2]?.match(/id: (obs_[a-f0-9]{24})/u)?.[1];
		expect(id).toBeTruthy();

		const result = await recall(await restart(fake), id!);
		expect(result.content).toMatch(/durable observation/u);
		expect(result.content).toMatch(/recall line/u);
		expect(result).not.toHaveProperty("output");
	});

	it("fails storage closed when a same-size object holds different content", async () => {
		const { fake, dataHome } = await setup();
		const body = `expected\n${repeatPastThreshold("original bytes\n")}`;
		const id = observationId("shell", "call-1", body);
		await mkdir(objectsDirectory(dataHome), { recursive: true });
		await writeFile(observationPath(dataHome, id), "x".repeat(Buffer.byteLength(body, "utf8")));
		const errors = captureConsoleErrors();

		expect(await project(fake, toolResultMessage("call-1", "shell", body), 3)).toEqual([body, body, body]);
		expect(errors.some((error) => error.includes(id) && error.includes("hash mismatch"))).toBe(true);
	});

	it("accepts an existing same-content object as idempotent storage", async () => {
		const { fake, dataHome } = await setup();
		const body = `idempotent\n${repeatPastThreshold("same bytes\n")}`;
		const id = observationId("shell", "call-1", body);
		await mkdir(objectsDirectory(dataHome), { recursive: true });
		await writeFile(observationPath(dataHome, id), body);

		const projected = await project(fake, toolResultMessage("call-1", "shell", body), 3);
		expect(projected.slice(0, 2)).toEqual([body, body]);
		expect(projected[2]).toMatch(new RegExp(`id: ${id}`, "u"));
	});

	it("fails recall closed, without a defect, when an object path is replaced by a symlink", async () => {
		const { fake, dataHome } = await setup();
		const body = `stored\n${repeatPastThreshold("observation bytes\n")}`;
		const id = observationId("shell", "call-1", body);
		await project(fake, toolResultMessage("call-1", "shell", body), 3);
		const path = observationPath(dataHome, id);
		const target = join(dataHome, "symlink-target.txt");
		await writeFile(target, "target bytes must not be recalled");
		await rm(path);
		await symlink(target, path);

		const result = await recall(fake, id);
		expect(result.content).toMatch(/^obs_recall failed for obs_[a-f0-9]{24}:/u);
		expect(result.content).not.toMatch(/target bytes/u);
		expect(result.metadata).toMatchObject({ code: "ELOOP" });
	});

	it("reports unknown and malformed ids as content instead of throwing", async () => {
		const { fake } = await setup();
		expect((await recall(fake, "obs_000000000000000000000000")).content).toBe(
			"Unknown observation id: obs_000000000000000000000000",
		);
		expect((await recall(fake, "../../etc/passwd")).content).toBe("Unknown observation id: ../../etc/passwd");
	});

	it("returns the exact original bytes across paged recall", async () => {
		const { fake } = await setup();
		const body = `utf8: luna ☾\n${"0123456789abcdef\n".repeat(1_200)}final line`;
		const id = observationId("shell", "call-1", body);
		await project(fake, toolResultMessage("call-1", "shell", body), 3);

		let offset = 0;
		let recalled = "";
		for (;;) {
			const result = await recall(fake, id, offset);
			const output = result.content as string;
			const firstNewline = output.indexOf("\n");
			const secondNewline = output.indexOf("\n", firstNewline + 1);
			expect(secondNewline).not.toBe(-1);
			recalled += output.slice(secondNewline + 1);
			const details = result.metadata as { eof: boolean; nextOffset: number };
			offset = details.nextOffset;
			if (details.eof) break;
		}

		expect(Buffer.from(recalled, "utf8")).toEqual(Buffer.from(body, "utf8"));
	});

	it("fails storage open when the observation directory is a symlink", async () => {
		const { fake, dataHome } = await setup();
		const targetDirectory = await temporaryDirectory();
		await mkdir(join(objectsDirectory(dataHome), ".."), { recursive: true });
		await symlink(targetDirectory, objectsDirectory(dataHome), "dir");
		const body = `directory guard\n${repeatPastThreshold("must not escape\n")}`;
		const id = observationId("shell", "call-1", body);
		const errors = captureConsoleErrors();

		expect(await project(fake, toolResultMessage("call-1", "shell", body), 3)).toEqual([body, body, body]);
		expect(errors.some((error) => error.includes(id) && error.includes("not a regular directory"))).toBe(true);
		await expect(readFile(join(targetDirectory, `${id}.txt`))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("packs a multi-item content result and keeps its result kind", async () => {
		const { fake } = await setup();
		const output = repeatPastThreshold("builder output\n");
		const message = {
			role: "tool",
			content: [
				{
					type: "tool-result",
					id: "write-1",
					name: "write",
					result: {
						type: "content",
						value: [
							{ type: "text", text: "Wrote file successfully: target.ts" },
							{ type: "text", text: `[then_run:succeeded]\n${output}` },
						],
					},
				},
			],
		};
		const messages = [message, assistantMessage("a1", []), assistantMessage("a2", [])];
		const projected = resultPart((await projectMessages(fake, messages))[0]);
		expect(projected.result.type).toBe("content");
		expect(toolResultText(projected)).toMatch(/^\[large tool result replaced/u);
		expect(toolResultText(projected)).toMatch(/Wrote file successfully: target\.ts/u);
	});

	it("keeps a fused write below the threshold intact", async () => {
		const { fake } = await setup();
		const message = {
			role: "tool",
			content: [
				{
					type: "tool-result",
					id: "write-1",
					name: "write",
					result: {
						type: "content",
						value: [
							{ type: "text", text: "Wrote file successfully: target.ts" },
							{ type: "text", text: `[then_run:succeeded]\n${"builder output\n".repeat(400)}` },
						],
					},
				},
			],
		};
		const projected = await project(fake, message, 3);
		expect(projected[2]).toMatch(/Wrote file successfully: target\.ts/u);
		expect(projected[2]).toMatch(/\[then_run:succeeded\]/u);
	});

	it("passes through errors, media content, hosted results, and reducer receipts", async () => {
		const { fake } = await setup();
		const large = "x".repeat(THRESHOLD_BYTES + 100);
		const error = toolErrorMessage("call-e", "shell", large);
		const media = {
			role: "tool",
			content: [
				{
					type: "tool-result",
					id: "call-m",
					name: "read",
					result: {
						type: "content",
						value: [
							{ type: "text", text: large },
							{ type: "file", uri: "data:image/png;base64,AA==", mime: "image/png" },
						],
					},
				},
			],
		};
		const hosted = toolResultMessage("call-h", "web_search", large);
		(hosted.content[0] as { providerExecuted?: boolean }).providerExecuted = true;
		const receipt = toolResultMessage("call-r", "shell", `sol_pi_evidence_receipt_v1\n${large}`);
		const compoundReceipt = toolResultMessage(
			"call-w",
			"write",
			`Wrote file successfully: target.ts\n[then_run:succeeded]\nsol_pi_evidence_receipt_v1\n${large}`,
		);

		for (const message of [error, media, hosted, receipt, compoundReceipt]) {
			const original = resultText(message);
			expect(await project(fake, message, 3)).toEqual([original, original, original]);
		}
	});
});
