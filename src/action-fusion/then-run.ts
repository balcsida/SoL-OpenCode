/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ToolResult } from "../context.ts";

export const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
export const THEN_RUN_FAILED = "[then_run:failed]";
export const THEN_RUN_SKIPPED = "[then_run:skipped]";

export interface ThenRunInput {
	readonly command: string;
	/** Milliseconds, as OpenCode's `shell` tool takes them. */
	readonly timeout?: number;
}

export type ParsedThenRun = { readonly ok: true; readonly value: ThenRunInput } | { readonly ok: false; readonly reason: string };

export function createThenRunSchema(description: string) {
	return {
		type: "object",
		description,
		properties: {
			command: { type: "string", description: "Shell command to run" },
			timeout: {
				type: "integer",
				minimum: 0,
				description:
					"Timeout in milliseconds, as for the shell tool. Set to 0 to disable the timeout. Defaults to the shell tool's default.",
			},
		},
		required: ["command"],
		additionalProperties: false,
	};
}

/** Validate `then_run` by hand: it is removed before OpenCode decodes the tool input. */
export function parseThenRun(value: unknown): ParsedThenRun {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, reason: "then_run must be an object with a command" };
	}
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (key !== "command" && key !== "timeout") return { ok: false, reason: `unknown then_run key: ${key}` };
	}
	if (typeof record.command !== "string" || record.command.trim().length === 0) {
		return { ok: false, reason: "then_run.command must be a non-empty string" };
	}
	if (
		record.timeout !== undefined &&
		(typeof record.timeout !== "number" || !Number.isSafeInteger(record.timeout) || record.timeout < 0)
	) {
		return { ok: false, reason: "then_run.timeout must be a non-negative integer number of milliseconds" };
	}
	return {
		ok: true,
		value: record.timeout === undefined ? { command: record.command } : { command: record.command, timeout: record.timeout },
	};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function resultText(result: ToolResult): string {
	const content = result.content;
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	return content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n\n");
}

async function fileSha256(path: string): Promise<string> {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function assertUnchangedBeforeCommand(
	path: string,
	yieldForInterference: () => Promise<void> = () => new Promise<void>((resolve) => setImmediate(resolve)),
): Promise<void> {
	try {
		const mutationHash = await fileSha256(path);
		await yieldForInterference();
		const commandHash = await fileSha256(path);
		if (mutationHash !== commandHash) {
			throw new Error("target content changed after the fused mutation");
		}
	} catch (error) {
		throw new Error(`${THEN_RUN_SKIPPED} ${errorText(error)}; the command was not run.`);
	}
}

export interface CommandOutcome {
	readonly status: "succeeded" | "failed" | "skipped";
	readonly text: string;
	readonly exit?: number;
}

/**
 * Classify a result from OpenCode's `shell` tool. A non-zero exit, timeout, or
 * signal is a successful tool call there (core/src/shell/result.ts), so the
 * exit metadata decides whether the fused command failed.
 */
export function commandOutcome(result: ToolResult): CommandOutcome {
	const metadata = (result.metadata ?? {}) as Record<string, unknown>;
	const exit = typeof metadata.exit === "number" ? metadata.exit : undefined;
	const failed = (exit !== undefined && exit !== 0) || metadata.timeout === true || typeof metadata.signal === "string";
	return { status: failed ? "failed" : "succeeded", text: resultText(result), ...(exit === undefined ? {} : { exit }) };
}

export function outcomeText(outcome: CommandOutcome): string {
	const marker =
		outcome.status === "succeeded" ? THEN_RUN_SUCCEEDED : outcome.status === "failed" ? THEN_RUN_FAILED : THEN_RUN_SKIPPED;
	if (outcome.status === "skipped") return outcome.text;
	return outcome.text ? `${marker}\n${outcome.text}` : marker;
}

export const MUTATION_FAILED_SKIP = `${THEN_RUN_SKIPPED} The file mutation did not complete successfully; the command was not run.`;

export { errorText };
