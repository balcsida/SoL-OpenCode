/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import type { ToolResult } from "./context.ts";
import { countLines, readRecallChunk } from "./observation-pack/observation.ts";

const RECALL_MAX_BYTES = 16 * 1024;
const RECALL_MAX_LINES = 400;
const RECALL_HEADER_RESERVE_BYTES = 512;
const RECALL_HEADER_LINES = 2;

const RECALL_LIMITS = {
	maxBytes: RECALL_MAX_BYTES - RECALL_HEADER_RESERVE_BYTES,
	maxLines: RECALL_MAX_LINES - RECALL_HEADER_LINES,
};

export interface RecallPage {
	readonly id: string;
	readonly offset: number;
	readonly bytes: number;
	readonly lines: number;
	readonly nextOffset: number;
	readonly eof: boolean;
}

/**
 * Expected failures are returned as ordinary content with `metadata.error`,
 * so OpenCode records them as completed calls the agent can read, instead of
 * as tool errors.
 */
export function toolFailure(message: string, metadata: Record<string, unknown> = {}): ToolResult {
	return { content: message, metadata: { ...metadata, error: message } };
}

/** Read one bounded page of an archived object, byte for byte. */
export async function recallPage(
	tool: string,
	id: string,
	path: string,
	offset: number,
): Promise<{ readonly page: RecallPage; readonly text: string } | undefined> {
	// The model sends the offset, and a negative one would be read from the start under another label.
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
	let chunk;
	try {
		chunk = await readRecallChunk(path, offset, RECALL_LIMITS);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
	const header = [
		`[${tool} id=${id} offset=${offset} next_offset=${chunk.nextOffset} eof=${chunk.eof}]`,
		`[chunk_bytes=${chunk.bytes} chunk_lines=${chunk.lines}; use next_offset to continue]`,
	].join("\n");
	const text = `${header}\n${chunk.text}`;
	if (Buffer.byteLength(text, "utf8") > RECALL_MAX_BYTES || countLines(text) > RECALL_MAX_LINES) {
		throw new Error("Recall output exceeded its hard limit");
	}
	return {
		page: { id, offset, bytes: chunk.bytes, lines: chunk.lines, nextOffset: chunk.nextOffset, eof: chunk.eof },
		text,
	};
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** What the model is told about a failed read: a filesystem error's code, not its message, which names the absolute path. */
export function failureReason(error: unknown): string {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : errorMessage(error);
}
