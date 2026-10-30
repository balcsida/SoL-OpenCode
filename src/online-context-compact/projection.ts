/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

/**
 * Sizing of the outgoing request, as the provider sees it after the earlier
 * hooks (ObservationPack) have projected it. Online Context Compact prices a
 * boundary from the last request it observed, as SoL-Pi prices Pi's cut from
 * its last observed projection.
 */

import type { LLMMessage, RequestHookEvent } from "../context.ts";
import { messageText } from "../messages.ts";

export const POST_COMPACTION_PLAN_REMINDER =
	"Online context compaction finished. The parent task is still active. " +
	"Continue the remaining work from the current plan. Preserve existing step IDs when updating progress.";

/** OpenCode's own summary checkpoint (core/src/session/runner/to-llm-message.ts). */
const NATIVE_CHECKPOINT_OPEN = "<conversation-checkpoint>";

export function tokenEstimate(text: string): number {
	return Math.ceil(Buffer.byteLength(text) / 4);
}

export function messageTokens(message: LLMMessage): number {
	return tokenEstimate(messageText(message));
}

/** The fixed prefix: system instructions and tool definitions. */
export function fixedTokens(event: RequestHookEvent): number {
	const system = event.system.map((part) => part.text).join("\n");
	return tokenEstimate(system) + tokenEstimate(JSON.stringify(event.tools));
}

export function requestTokens(event: RequestHookEvent): number {
	return fixedTokens(event) + event.messages.reduce((total, message) => total + messageTokens(message), 0);
}

function isNativeCheckpoint(message: LLMMessage): boolean {
	return message.role === "user" && messageText(message).startsWith(NATIVE_CHECKPOINT_OPEN);
}

function isCompactable(message: LLMMessage): boolean {
	return message.role !== "system";
}

/** A message the kept tail may start with: it has a session id and owns its tool results. */
function isBoundary(message: LLMMessage): message is LLMMessage & { readonly id: string } {
	return (
		typeof message.id === "string" &&
		message.id.length > 0 &&
		(message.role === "user" || message.role === "assistant") &&
		!isNativeCheckpoint(message)
	);
}

export interface CutPoint {
	readonly index: number;
	readonly messageID: string;
}

/**
 * Keep at least `keepRecentTokens` of recent conversation, starting at a user
 * or assistant message so no tool call is separated from its result. There
 * must be older conversation to summarize. This mirrors OpenCode's own split,
 * which keeps the newest messages within its `keep` budget verbatim beside the
 * summary; the port prices that tail at SoL-Pi's retained size.
 */
export function findCutPoint(messages: readonly LLMMessage[], keepRecentTokens: number): CutPoint | undefined {
	let kept = 0;
	for (let index = messages.length - 1; index > 0; index--) {
		const message = messages[index];
		if (!message) continue;
		kept += messageTokens(message);
		if (kept < keepRecentTokens || !isBoundary(message)) continue;
		if (!messages.slice(0, index).some(isCompactable)) return undefined;
		return { index, messageID: message.id };
	}
	return undefined;
}

/**
 * Tokens a compaction at `cut` removes: every non-system message before it,
 * at its projected size. An earlier checkpoint is folded into the new summary,
 * so it counts; mid-conversation system messages stay, so they do not.
 */
export function archivedTokens(messages: readonly LLMMessage[], cut: CutPoint): number {
	return messages
		.slice(0, cut.index)
		.reduce((total, message) => total + (message.role === "system" ? 0 : messageTokens(message)), 0);
}
