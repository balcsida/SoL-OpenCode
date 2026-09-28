/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

/**
 * Helpers for the `@opencode/ai` LLM messages that request hooks receive.
 *
 * OpenCode lowers each completed tool call to a `role: "tool"` message holding
 * one `tool-result` part whose `result` is `{ type: "text", value }` for a
 * single text item or `{ type: "content", value: Content[] }` otherwise; a
 * failed call is `{ type: "error" }` (core/src/session/runner/to-llm-message.ts).
 * After the hooks run, OpenCode rebuilds every message with
 * `Message.make({ ...message, content })` (core/src/session/model-request.ts),
 * so replacements may be plain objects with the same fields.
 */

import type { LLMContentPart, LLMMessage, ToolResultPart } from "./context.ts";

interface TextItem {
	readonly type: "text";
	readonly text: string;
}

function isTextItem(value: unknown): value is TextItem {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { type?: unknown }).type === "text" &&
		typeof (value as { text?: unknown }).text === "string"
	);
}

export function isToolResultPart(part: LLMContentPart): part is ToolResultPart {
	return part.type === "tool-result";
}

/**
 * The joined text of a successful, locally executed, text-only tool result;
 * `undefined` for errors, JSON, media, or provider-hosted results.
 */
export function toolResultText(part: ToolResultPart): string | undefined {
	if (part.providerExecuted === true) return undefined;
	const result = part.result;
	if (result.type === "text") return typeof result.value === "string" ? result.value : undefined;
	if (result.type !== "content") return undefined;
	const items = result.value as readonly unknown[];
	if (items.length === 0 || !items.every(isTextItem)) return undefined;
	return (items as readonly TextItem[]).map((item) => item.text).join("\n");
}

/** Same part, same result kind, with its text replaced. */
export function withToolResultText(part: ToolResultPart, text: string): ToolResultPart {
	const result =
		part.result.type === "content"
			? { type: "content" as const, value: [{ type: "text" as const, text }] }
			: { type: "text" as const, value: text };
	return { ...part, result } as ToolResultPart;
}

/** A copy of `message` with new content; the rest of its fields are kept. */
export function withContent(message: LLMMessage, content: readonly LLMContentPart[]): LLMMessage {
	return { ...message, content } as unknown as LLMMessage;
}

/** A plain user text message that OpenCode rebuilds with `Message.make`. */
export function userTextMessage(text: string): LLMMessage {
	return { role: "user", content: [{ type: "text", text }] } as unknown as LLMMessage;
}

/** All text in a message, for token estimates and marker detection. */
export function messageText(message: LLMMessage): string {
	return message.content
		.map((part) => {
			if (part.type === "text" || part.type === "reasoning") return part.text;
			if (part.type === "tool-call") return `${part.name}${JSON.stringify(part.input) ?? ""}`;
			if (part.type === "tool-result") return JSON.stringify(part.result.value) ?? "";
			return "";
		})
		.join("\n");
}
