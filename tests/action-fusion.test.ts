/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertUnchangedBeforeCommand, register, withFusedFileQueue } from "../src/action-fusion/index.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { ToolResult } from "../src/context.ts";
import { editTool, type ShellHandler, shellTool, writeTool } from "./fake-builtins.ts";
import { type CallOutcome, contextEvent, FakeOpenCode, FakeToolFailure } from "./fake-opencode.ts";

const SESSION = "ses_fusion";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

function text(result: ToolResult): string {
	const content = result.content;
	if (typeof content === "string") return content;
	return (content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function completed(outcome: CallOutcome): ToolResult {
	if (outcome.status !== "completed") throw new Error(`expected completed, got ${outcome.status}`);
	return outcome.result;
}

const tempDirs: string[] = [];
const cleanups: (() => void)[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "sol-opencode-then-run-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(
	shell: ShellHandler = async () => ({ output: "", exit: 0 }),
	options: { onWrite?: (path: string, content: string) => Promise<void> | void; withShell?: boolean } = {},
) {
	const dir = await createTempDir();
	const fake = new FakeOpenCode(dir);
	fake.seedTool(editTool(dir));
	fake.seedTool(writeTool(dir, options.onWrite));
	if (options.withShell !== false) fake.seedTool(shellTool(shell));
	cleanups.push(await register(fake.ctx(), { ...DEFAULT_CONFIG, actionFusion: true }));
	return { dir, fake };
}

function call(id: string) {
	return { sessionID: SESSION, id, messageID: "msg_1", agent: "build" };
}

describe("action fusion then_run", () => {
	it("advertises an optional then_run object on edit and write for every request kind", async () => {
		const { fake } = await setup();
		for (const kind of ["context", "generate", "compaction"]) {
			const event = contextEvent(SESSION, [], {
				tools: {
					edit: { description: "edit", input: { type: "object", properties: { path: {}, oldString: {}, newString: {} }, required: ["path"] } },
					write: { description: "write", input: { type: "object", properties: { path: {}, content: {} }, required: ["path", "content"] } },
					read: { description: "read", input: { type: "object", properties: { path: {} } } },
				},
			});
			const originalWrite = event.tools.write;
			await fake.runSessionHook(kind, event);

			const write = event.tools.write?.input as { properties: Record<string, unknown>; required: string[] };
			const edit = event.tools.edit?.input as { properties: Record<string, unknown>; required: string[] };
			expect(Object.keys(write.properties)).toEqual(["path", "content", "then_run"]);
			expect(Object.keys(edit.properties)).toEqual(["path", "oldString", "newString", "then_run"]);
			expect(write.required).toEqual(["path", "content"]);
			expect(write.properties.then_run).toMatchObject({
				type: "object",
				description: expect.stringContaining("optional timeout in milliseconds"),
				properties: { command: { type: "string" }, timeout: { type: "integer", minimum: 0 } },
				required: ["command"],
			});
			expect(event.tools.read?.input).toEqual({ type: "object", properties: { path: {} } });
			expect(originalWrite?.input).toEqual({ type: "object", properties: { path: {}, content: {} }, required: ["path", "content"] });
		}
	});

	it("removes then_run before the built-in write runs, then runs it after the content is visible", async () => {
		const commands: string[] = [];
		let dir = "";
		const { fake, dir: directory } = await setup(async (input) => {
			commands.push(input.command);
			expect(await readFile(join(dir, "written.txt"), "utf8")).toBe("new content\n");
			return { output: "write check passed\n", exit: 0 };
		});
		dir = directory;

		const outcome = await fake.callTool(
			"write",
			{ path: "written.txt", content: "new content\n", then_run: { command: "check write" } },
			call("write-1"),
		);

		expect(outcome.status === "completed" && outcome.executedInput).toEqual({ path: "written.txt", content: "new content\n" });
		const result = completed(outcome);
		expect(commands).toEqual(["check write"]);
		expect(text(result)).toContain("Created file successfully: written.txt");
		expect(text(result)).toContain("[then_run:succeeded]\nwrite check passed");
		expect(result.output).toMatchObject({ operation: "write", resource: "written.txt" });
		expect(result.metadata).toMatchObject({ thenRun: { status: "succeeded", exit: 0 } });
	});

	it("runs edit then_run after the edited content is visible", async () => {
		let dir = "";
		const { fake, dir: directory } = await setup(async () => {
			expect(await readFile(join(dir, "edited.txt"), "utf8")).toBe("after\n");
			return { output: "edit check passed", exit: 0 };
		});
		dir = directory;
		await writeFile(join(dir, "edited.txt"), "before\n");

		const result = completed(
			await fake.callTool(
				"edit",
				{ path: "edited.txt", oldString: "before", newString: "after", then_run: { command: "check edit" } },
				call("edit-1"),
			),
		);
		expect(text(result)).toContain("[then_run:succeeded]\nedit check passed");
	});

	it("leaves a mutation without then_run untouched", async () => {
		let shellCalls = 0;
		const { fake, dir } = await setup(async () => {
			shellCalls++;
			return { output: "", exit: 0 };
		});
		const result = completed(await fake.callTool("write", { path: "plain.txt", content: "plain\n" }, call("write-plain")));

		expect(shellCalls).toBe(0);
		expect(result).toEqual({
			output: { operation: "write", target: join(dir, "plain.txt"), resource: "plain.txt", existed: false },
			content: "Created file successfully: plain.txt",
		});
		expect(await readFile(join(dir, "plain.txt"), "utf8")).toBe("plain\n");
	});

	it("keeps a successful mutation and reports a non-zero exit as a failed command", async () => {
		const { fake, dir } = await setup(async () => ({ output: "validation failed", exit: 7 }));
		const result = completed(
			await fake.callTool("write", { path: "preserved.txt", content: "keep me\n", then_run: { command: "exit 7" } }, call("write-2")),
		);

		expect(text(result)).toContain("[then_run:failed]\nvalidation failed");
		expect(text(result)).toContain("Exited with code 7");
		expect(result.metadata).toMatchObject({ thenRun: { status: "failed", exit: 7 } });
		expect(await readFile(join(dir, "preserved.txt"), "utf8")).toBe("keep me\n");
	});

	it("reports a timed-out command as failed", async () => {
		const { fake } = await setup(async () => ({ output: "partial", exit: undefined, timeout: true }));
		const result = completed(
			await fake.callTool("write", { path: "slow.txt", content: "x", then_run: { command: "sleep 99", timeout: 10 } }, call("w-t")),
		);
		expect(text(result)).toContain("[then_run:failed]\npartial");
		expect(text(result)).toContain("Timed out before completion");
	});

	it("skips then_run and keeps the typed error when the mutation fails", async () => {
		let shellCalls = 0;
		const { fake } = await setup(async () => {
			shellCalls++;
			return { output: "", exit: 0 };
		});
		const outcome = await fake.callTool(
			"edit",
			{ path: "missing.txt", oldString: "before", newString: "after", then_run: { command: "must not run" } },
			call("edit-2"),
		);

		expect(outcome.status).toBe("error");
		if (outcome.status !== "error") return;
		expect(outcome.error).toBeInstanceOf(FakeToolFailure);
		expect(outcome.error.message).toBe(
			"Unable to edit missing.txt\n\n[then_run:skipped] The file mutation did not complete successfully; the command was not run.",
		);
		expect(shellCalls).toBe(0);
	});

	it("keeps the file queue locked from the mutation through then_run", async () => {
		const thenRunStarted = deferred();
		const finishThenRun = deferred();
		const events: string[] = [];
		const { fake } = await setup(
			async () => {
				events.push("then_run:start");
				thenRunStarted.resolve();
				await finishThenRun.promise;
				events.push("then_run:end");
				return { output: "", exit: 0 };
			},
			{ onWrite: (_path, content) => void events.push(`write:${content}`) },
		);

		const first = fake.callTool("write", { path: "ordered.txt", content: "first", then_run: { command: "block" } }, call("write-3"));
		await thenRunStarted.promise;
		const second = fake.callTool("write", { path: "ordered.txt", content: "second" }, call("write-4"));
		await delay(20);
		expect(events).toEqual(["write:first", "then_run:start"]);

		finishThenRun.resolve();
		await Promise.all([first, second]);
		expect(events).toEqual(["write:first", "then_run:start", "then_run:end", "write:second"]);
	});

	it("passes the command, a millisecond timeout, and the call identity to OpenCode's shell tool", async () => {
		const seen: unknown[] = [];
		const { fake } = await setup(async (input, context) => {
			seen.push({ input, context: { sessionID: context.sessionID, agent: context.agent, messageID: context.messageID, id: context.id } });
			return { output: "", exit: 0 };
		});

		await fake.callTool(
			"write",
			{ path: "timeout.txt", content: "content\n", then_run: { command: "check with timeout", timeout: 12_000 } },
			call("write-timeout"),
		);
		expect(seen).toEqual([
			{
				input: { command: "check with timeout", timeout: 12_000 },
				context: { sessionID: SESSION, agent: "build", messageID: "msg_1", id: "write-timeout" },
			},
		]);
	});

	it("reports an invalid then_run without running it or undoing the mutation", async () => {
		let shellCalls = 0;
		const { fake, dir } = await setup(async () => {
			shellCalls++;
			return { output: "", exit: 0 };
		});
		for (const thenRun of [{ command: "" }, { command: "ok", timeout: 1.5 }, { command: "ok", shell: "zsh" }, "npm test"]) {
			const result = completed(
				await fake.callTool("write", { path: "invalid.txt", content: "kept\n", then_run: thenRun }, call("write-invalid")),
			);
			expect(text(result)).toMatch(/\[then_run:skipped\] invalid then_run: .+; the command was not run\./u);
			expect(result.metadata).toMatchObject({ thenRun: { status: "skipped" } });
		}
		expect(shellCalls).toBe(0);
		expect(await readFile(join(dir, "invalid.txt"), "utf8")).toBe("kept\n");
	});

	it("skips the command when OpenCode's shell tool is unavailable", async () => {
		const { fake } = await setup(undefined, { withShell: false });
		const result = completed(
			await fake.callTool("write", { path: "no-shell.txt", content: "x", then_run: { command: "npm test" } }, call("write-ns")),
		);
		expect(text(result)).toContain("[then_run:skipped] the shell tool is unavailable; the command was not run.");
	});

	it("reports a rejected shell call, such as a declined permission, as a failed command", async () => {
		const { fake } = await setup(async () => {
			throw new Error("The user declined this tool call");
		});
		const result = completed(
			await fake.callTool("write", { path: "declined.txt", content: "x", then_run: { command: "rm -rf /" } }, call("write-d")),
		);
		expect(text(result)).toContain("[then_run:failed]\nThe user declined this tool call");
	});

	it("releases the queue and aborts the command when the session is interrupted", async () => {
		let aborted = false;
		const started = deferred();
		const { fake } = await setup(
			(_input, context) =>
				new Promise((resolve) => {
					started.resolve();
					context.signal.addEventListener("abort", () => {
						aborted = true;
						resolve({ output: "cancelled", exit: 130 });
					});
				}),
		);

		const first = fake.callTool("write", { path: "interrupted.txt", content: "a", then_run: { command: "hang" } }, call("w-i1"));
		await started.promise;
		fake.emit({ type: "session.execution.interrupted", data: { sessionID: SESSION } });
		await first;
		expect(aborted).toBe(true);
		expect(completed(await fake.callTool("write", { path: "interrupted.txt", content: "b" }, call("w-i2")))).toBeTruthy();
	});

	it("releases a queue slot whose execute.after never ran once the session goes idle", async () => {
		const { fake, dir } = await setup();
		// A call that dies between execute.before and execute.after holds its slot.
		const before = { tool: "write", sessionID: SESSION, agent: "build", messageID: "m", id: "w-dead", input: { path: "held.txt", content: "x" } };
		for (const hook of fake.toolHooks["execute.before"]) await hook(before);

		const blocked = fake.callTool("write", { path: "held.txt", content: "after\n" }, call("w-next"));
		await delay(20);
		await expect(readFile(join(dir, "held.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

		fake.emit({ type: "session.idle", data: { sessionID: SESSION } });
		completed(await blocked);
		expect(await readFile(join(dir, "held.txt"), "utf8")).toBe("after\n");
	});

	it("serializes direct uses of the fused queue", async () => {
		const events: string[] = [];
		const firstStarted = deferred();
		const releaseFirst = deferred();
		const queuePath = join(tmpdir(), "sol-opencode-action-fusion-queue");
		const first = withFusedFileQueue(queuePath, async () => {
			events.push("first:start");
			firstStarted.resolve();
			await releaseFirst.promise;
			events.push("first:end");
		});
		await firstStarted.promise;
		const second = withFusedFileQueue(queuePath, async () => {
			events.push("second");
		});
		await delay(20);
		expect(events).toEqual(["first:start"]);
		releaseFirst.resolve();
		await Promise.all([first, second]);
		expect(events).toEqual(["first:start", "first:end", "second"]);
	});

	it("skips the command when the target changes after mutation", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "changed-before-command.txt");
		await writeFile(filePath, "mutation result\n");

		await expect(
			assertUnchangedBeforeCommand(filePath, async () => {
				await writeFile(filePath, "external change\n");
			}),
		).rejects.toThrow("[then_run:skipped] target content changed after the fused mutation");
	});
});
