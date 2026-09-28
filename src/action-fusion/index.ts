/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */
/**
 * Action Fusion - fuse a file mutation and its follow-up command into one turn.
 *
 * Base rollouts repeatedly showed the same pair of turns: edit or write a
 * file, then run a command to test, build, or start it. Action Fusion lets the
 * built-in `edit` and `write` tools take an optional `then_run` object, runs
 * that command through OpenCode's `shell` tool after the mutation succeeds,
 * and returns one combined observation.
 *
 * OpenCode's built-in tools stay untouched. A Promise plugin that wrapped their
 * executors would turn their typed failures into defects, so the mechanism is
 * built from hooks instead:
 *
 * - request hooks advertise `then_run` in the live `edit`/`write` schemas;
 * - `execute.before` removes `then_run` from the raw input and takes the
 *   per-file fused queue before the built-in mutation runs;
 * - `execute.after` checks that the file is unchanged, runs the command, and
 *   appends its output, then releases the queue.
 */

import type { SolPiConfig } from "../config.ts";
import type { RequestHookEvent, SolContext, ToolError, ToolExecuteAfter, ToolExecuteBefore } from "../context.ts";
import { acquireFusedFileQueue, resolveToolPath } from "./file-queue.ts";
import {
	assertUnchangedBeforeCommand,
	type CommandOutcome,
	commandOutcome,
	createThenRunSchema,
	errorText,
	MUTATION_FAILED_SKIP,
	outcomeText,
	type ParsedThenRun,
	parseThenRun,
	THEN_RUN_SKIPPED,
	type ThenRunInput,
} from "./then-run.ts";

export const FUSED_TOOLS = ["edit", "write"] as const;
export const SHELL_TOOL = "shell";

const THEN_RUN_DESCRIPTIONS: Record<(typeof FUSED_TOOLS)[number], string> = {
	edit: "Command to run next on this file after the edit succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in milliseconds. Skipped if the edit fails; a non-zero exit is reported but keeps the edit.",
	write: "Command to run next on this file after the write succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in milliseconds. Skipped if the write fails; a non-zero exit is reported but keeps the write.",
};

interface PendingCall {
	readonly sessionID: string;
	readonly absolutePath: string | undefined;
	readonly thenRun: ParsedThenRun | undefined;
	readonly release: () => void;
	readonly abort: AbortController;
}

function isFusedTool(name: string): name is (typeof FUSED_TOOLS)[number] {
	return (FUSED_TOOLS as readonly string[]).includes(name);
}

function callKey(event: { readonly sessionID: string; readonly id: string }): string {
	return `${event.sessionID}\0${event.id}`;
}

export async function register(ctx: SolContext, _config: SolPiConfig): Promise<() => void> {
	const pending = new Map<string, PendingCall>();

	const advertise = (event: RequestHookEvent): void => {
		for (const name of FUSED_TOOLS) {
			const tool = event.tools[name];
			if (tool) event.tools[name] = { ...tool, input: withThenRun(tool.input, THEN_RUN_DESCRIPTIONS[name]) };
		}
	};
	// The same tools on every request kind keep the provider's cached prefix stable.
	await ctx.session.hook("context", advertise);
	await ctx.session.hook("generate", advertise);
	await ctx.session.hook("compaction", advertise);

	await ctx.tool.hook("execute.before", async (event) => {
		const before = event as ToolExecuteBefore;
		if (!isFusedTool(before.tool)) return;
		const input = before.input;
		if (typeof input !== "object" || input === null || Array.isArray(input)) return;

		let thenRun: ParsedThenRun | undefined;
		if (Object.hasOwn(input, "then_run")) {
			const { then_run: requested, ...rest } = input as Record<string, unknown>;
			before.input = rest;
			if (requested !== undefined && requested !== null) thenRun = parseThenRun(requested);
		}

		const path = (input as { path?: unknown }).path;
		const absolutePath = typeof path === "string" ? resolveToolPath(ctx.location.directory, path) : undefined;
		// Every edit/write takes the fused queue, as in SoL-Pi, so a plain
		// mutation of the same file waits for a running then_run command.
		const release = absolutePath ? await acquireFusedFileQueue(absolutePath) : () => {};
		pending.set(callKey(before), {
			sessionID: before.sessionID,
			absolutePath,
			thenRun,
			release,
			abort: new AbortController(),
		});
	});

	await ctx.tool.hook("execute.after", async (event) => {
		const after = event as ToolExecuteAfter;
		const key = callKey(after);
		const call = pending.get(key);
		if (!call) return;
		try {
			if (!call.thenRun) return;
			if (after.status === "error") {
				after.error = withMessage(after.error, `${after.error.message}\n\n${MUTATION_FAILED_SKIP}`);
				return;
			}
			const outcome = await fusedOutcome(ctx, after, call);
			const content = after.result.content;
			const base = content === undefined ? [] : typeof content === "string" ? [{ type: "text" as const, text: content }] : [...content];
			after.result = {
				...after.result,
				content: [...base, { type: "text", text: outcomeText(outcome) }],
				metadata: {
					...after.result.metadata,
					thenRun: {
						status: outcome.status,
						...(call.thenRun.ok ? { command: call.thenRun.value.command } : {}),
						...(outcome.exit === undefined ? {} : { exit: outcome.exit }),
						...(outcome.truncated ? { truncated: true } : {}),
					},
				},
			};
		} finally {
			// Stay tracked until the command settles so an interruption can abort it.
			if (pending.get(key) === call) pending.delete(key);
			call.release();
		}
	});

	// A tool call that is interrupted, or dies before execute.after, must not
	// hold the queue or keep its command running.
	const releaseSession = (sessionID: string): void => {
		for (const [key, call] of pending) {
			if (call.sessionID !== sessionID) continue;
			call.abort.abort();
			call.release();
			pending.delete(key);
		}
	};
	const subscription = new AbortController();
	void (async () => {
		for await (const event of ctx.event.subscribe({ signal: subscription.signal })) {
			const type = (event as { type?: string }).type;
			const sessionID = (event as { data?: { sessionID?: unknown } }).data?.sessionID;
			if (typeof sessionID !== "string") continue;
			if (type === "session.execution.interrupted" || type === "session.idle" || type === "session.deleted") {
				releaseSession(sessionID);
			}
		}
	})().catch((error: unknown) => console.error(`[actionfusion] event subscription ended: ${errorText(error)}`));

	return () => {
		subscription.abort();
		for (const call of pending.values()) {
			call.abort.abort();
			call.release();
		}
		pending.clear();
	};
}

async function fusedOutcome(ctx: SolContext, after: ToolExecuteAfter, call: PendingCall): Promise<CommandOutcome> {
	const thenRun = call.thenRun;
	if (!thenRun) throw new Error("fusedOutcome requires then_run");
	if (!thenRun.ok) {
		return { status: "skipped", text: `${THEN_RUN_SKIPPED} invalid then_run: ${thenRun.reason}; the command was not run.` };
	}
	if (!call.absolutePath) {
		return { status: "skipped", text: `${THEN_RUN_SKIPPED} the mutation target is unknown; the command was not run.` };
	}
	try {
		await assertUnchangedBeforeCommand(call.absolutePath);
	} catch (error) {
		return { status: "skipped", text: errorText(error) };
	}
	return runCommand(ctx, thenRun.value, after, call.abort.signal);
}

/** Run the command through OpenCode's own `shell` tool: its shell, permissions, hooks, and limits. */
async function runCommand(
	ctx: SolContext,
	thenRun: ThenRunInput,
	after: ToolExecuteAfter,
	signal: AbortSignal,
): Promise<CommandOutcome> {
	const shell = (await ctx.tool.list()).find((tool) => tool.id === SHELL_TOOL);
	if (!shell) {
		return { status: "skipped", text: `${THEN_RUN_SKIPPED} the shell tool is unavailable; the command was not run.` };
	}
	try {
		const result = await shell.execute(
			{ command: thenRun.command, ...(thenRun.timeout === undefined ? {} : { timeout: thenRun.timeout }) },
			// The ids are OpenCode's own branded values from the hook event.
			{
				sessionID: after.sessionID,
				agent: after.agent,
				messageID: after.messageID,
				id: after.id,
				signal,
				progress: async () => {},
			} as unknown as Parameters<typeof shell.execute>[1],
		);
		return commandOutcome(result);
	} catch (error) {
		return { status: "failed", text: errorText(error) };
	}
}

/** Add `then_run` to an advertised JSON Schema object without touching the original. */
export function withThenRun<T>(schema: T, description: string): T {
	if (typeof schema !== "object" || schema === null) return schema;
	const properties = (schema as { properties?: unknown }).properties;
	if (typeof properties !== "object" || properties === null || "then_run" in properties) return schema;
	return { ...schema, properties: { ...properties, then_run: createThenRunSchema(description) } };
}

/** A copy of OpenCode's typed tool error with a new message, built by its own class. */
function withMessage(error: ToolError, message: string): ToolError {
	const ErrorClass = error.constructor as new (fields: Record<string, unknown>) => ToolError;
	return new ErrorClass({
		message,
		...(error.error === undefined ? {} : { error: error.error }),
		...(error.metadata === undefined ? {} : { metadata: error.metadata }),
	});
}

export {
	assertUnchangedBeforeCommand,
	THEN_RUN_FAILED,
	THEN_RUN_SKIPPED,
	THEN_RUN_SUCCEEDED,
	type ThenRunInput,
} from "./then-run.ts";
export { resolveToolPath, withFusedFileQueue } from "./file-queue.ts";
