/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { ToolResult } from "../context.ts";
import { isRecord, recordValue } from "./config.ts";

/** Markers written by Action Fusion around a fused command's output. */
const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
const THEN_RUN_FAILED = "[then_run:failed]";

/** OpenCode's `shell` output file name (core/src/shell.ts: `sh_<12 hex>…​.out`). */
const SHELL_OUTPUT_FILE = /^sh_[0-9a-f]{12}.*\.out$/u;
/** OpenCode's notice when a shell result is truncated (core/src/shell.ts:247). */
const FULL_OUTPUT_NOTICE = /\[showing lines \d+-\d+ of \d+; full output saved to ([^\]\r\n]+)\]/gu;

type TextBlock = { readonly type: "text"; readonly text: string };
type Content = readonly (TextBlock | { readonly type: "file"; readonly uri: string; readonly mime: string })[];

export interface CompletedToolCall {
	readonly tool: string;
	readonly input: unknown;
	readonly result: ToolResult;
}

export interface ReducibleToolResult {
	readonly command: string;
	/** The log itself. Read only for a command worth reducing; nothing when the full output is past `maxBytes`. */
	readonly readBody: () => Promise<string | undefined>;
	readonly isError: boolean;
	/** Put the receipt back where the raw output was, leaving the rest of the result alone. */
	readonly projectReceipt: (receipt: string) => Content;
}

function contentBlocks(result: ToolResult): Content {
	const content = result.content;
	if (content === undefined) return [];
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content as Content;
}

function failedShell(metadata: unknown): boolean {
	const exit = recordValue(metadata, "exit");
	return (
		(typeof exit === "number" && exit !== 0) ||
		recordValue(metadata, "timeout") === true ||
		typeof recordValue(metadata, "signal") === "string"
	);
}

async function safeShellOutputPath(path: string, shellOutputDirectory: string): Promise<boolean> {
	if (!SHELL_OUTPUT_FILE.test(basename(path))) return false;
	try {
		const [candidate, root, status] = await Promise.all([realpath(path), realpath(shellOutputDirectory), lstat(path)]);
		return status.isFile() && !status.isSymbolicLink() && dirname(candidate) === root;
	} catch {
		return false;
	}
}

/**
 * Prefer the untruncated file OpenCode's shell wrote for a large result, so
 * evidence is checked against the exact bytes the command produced rather than
 * the tail preview.
 */
async function exactBodyFromInline(
	inline: string,
	truncated: boolean,
	shellOutputDirectory: string,
	maxBytes: number,
): Promise<string | undefined> {
	if (!truncated) return inline;
	// OpenCode appends the notice after the output, so the last one is its own.
	const candidate = [...inline.matchAll(FULL_OUTPUT_NOTICE)].at(-1)?.[1]?.trim();
	if (!candidate || !(await safeShellOutputPath(candidate, shellOutputDirectory))) return inline;
	try {
		const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const status = await handle.stat();
			if (!status.isFile()) return inline;
			// A runaway log is left on disk: reading it could exhaust memory, and it is past the reducer's limit anyway.
			return status.size > maxBytes ? undefined : await handle.readFile("utf8");
		} finally {
			await handle.close();
		}
	} catch {
		return inline;
	}
}

/**
 * Identify the log inside a tool result: either a foreground `shell` result,
 * or the command output appended to a fused `edit`/`write` by Action Fusion.
 */
export async function reducibleToolResult(
	call: CompletedToolCall,
	shellOutputDirectory: string,
	maxBytes = Number.POSITIVE_INFINITY,
): Promise<ReducibleToolResult | undefined> {
	const blocks = contentBlocks(call.result);
	if (call.tool === "shell") {
		const command = recordValue(call.input, "command");
		if (typeof command !== "string" || !command) return undefined;
		const metadata = call.result.metadata;
		if (recordValue(metadata, "status") === "running") return undefined;
		// The shell puts its output first and any exit notice after it.
		const output = recordValue(call.result.output, "output");
		const index = typeof output === "string" ? blocks.findIndex((block) => block.type === "text" && block.text === output) : -1;
		const block = blocks[index];
		if (!block || block.type !== "text") return undefined;
		return {
			command,
			readBody: () => exactBodyFromInline(block.text, recordValue(metadata, "truncated") === true, shellOutputDirectory, maxBytes),
			isError: failedShell(metadata),
			projectReceipt: (receipt) =>
				blocks.map((item, itemIndex) => (itemIndex === index ? { type: "text" as const, text: receipt } : item)),
		};
	}
	if (call.tool !== "write" && call.tool !== "edit") return undefined;
	const thenRun = recordValue(call.result.metadata, "thenRun");
	const command = recordValue(thenRun, "command");
	const status = recordValue(thenRun, "status");
	if (typeof command !== "string" || !command || (status !== "succeeded" && status !== "failed")) return undefined;
	const marker = status === "failed" ? THEN_RUN_FAILED : THEN_RUN_SUCCEEDED;
	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index];
		if (!block || block.type !== "text" || !block.text.startsWith(marker)) continue;
		const suffixStart = marker.length;
		const suffix = block.text.slice(suffixStart);
		if (!suffix.startsWith("\n")) return undefined;
		const inline = suffix.slice(1);
		return {
			command,
			readBody: () => exactBodyFromInline(inline, recordValue(thenRun, "truncated") === true, shellOutputDirectory, maxBytes),
			isError: status === "failed",
			projectReceipt: (receipt) =>
				blocks.map((item, itemIndex) =>
					itemIndex === index ? { type: "text" as const, text: `${block.text.slice(0, suffixStart)}\n${receipt}` } : item,
				),
		};
	}
	return undefined;
}

export { isRecord };
