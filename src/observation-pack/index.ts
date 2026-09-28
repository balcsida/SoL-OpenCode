/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */
/**
 * ObservationPack - keep large tool results reachable without replaying them.
 *
 * A large tool result is sent in full for its first few provider requests, then
 * replaced with a short, stable placeholder for every later request. The
 * original bytes are archived by observation id outside the provider context,
 * and the agent pulls exact pages back with the registered `obs_recall` tool.
 *
 * The mechanism never edits history. It rewrites only the outgoing request in
 * `ctx.session.hook("context")`, so the stored session stays intact and recall
 * keeps working after compaction or a restart.
 */

import { join } from "node:path";
import type { SolPiConfig } from "../config.ts";
import type { ContextHookEvent, LLMContentPart, SolContext, ToolResult } from "../context.ts";
import { createLedger, type Ledger } from "../ledger.ts";
import { isToolResultPart, toolResultText, withContent, withToolResultText } from "../messages.ts";
import { sessionRoot } from "../paths.ts";
import { errorMessage, recallPage, toolFailure } from "../recall.ts";
import {
	createObservation,
	ensureStored,
	estimateTokens,
	FULL_SENDS,
	isObservationId,
	observationPath,
	placeholderFor,
} from "./observation.ts";

export const RECALL_TOOL = "obs_recall";

const RECALL_INPUT = {
	type: "object",
	properties: {
		id: { type: "string", description: "Observation id from a placeholder" },
		offset: { type: "integer", minimum: 0, description: "Byte offset, default 0" },
	},
	required: ["id"],
	additionalProperties: false,
} as const;

export async function register(ctx: SolContext, _config: SolPiConfig): Promise<void> {
	const sentCounts = new Map<string, number>();
	const ledgers = new Map<string, Ledger>();
	const ledgerFor = (root: string): Ledger => {
		let ledger = ledgers.get(root);
		if (!ledger) {
			ledger = createLedger(join(root, "observation-pack", "ledger.jsonl"));
			ledgers.set(root, ledger);
		}
		return ledger;
	};

	await ctx.tool.transform((editor) => {
		editor.add({
			name: RECALL_TOOL,
			// A direct tool, like SoL-Pi's; plugin tools otherwise live only in the Code Mode catalog.
			options: { codemode: false },
			description:
				"Read a stored large tool result by observation id and byte offset. Use it when a placeholder replaced a large tool result and you need its exact text; continue with the returned next_offset.",
			input: RECALL_INPUT,
			execute: async (input, context) => {
				const { id, offset = 0 } = input as { id: string; offset?: number };
				return recall(ledgerFor, context.sessionID, id, offset);
			},
		});
	});

	await ctx.session.hook("context", (event) => projectObservations(event, sentCounts, ledgerFor));
}

async function recall(
	ledgerFor: (root: string) => Ledger,
	sessionID: string,
	id: string,
	offset: number,
): Promise<ToolResult> {
	if (!isObservationId(id)) return toolFailure(`Unknown observation id: ${id}`);
	try {
		const root = sessionRoot(sessionID);
		const recalled = await recallPage(RECALL_TOOL, id, observationPath(root, id), offset);
		if (!recalled) return toolFailure(`Unknown observation id: ${id}`);
		await ledgerFor(root)({ event: "recall", ...recalled.page });
		return { content: recalled.text, metadata: { ...recalled.page } };
	} catch (error) {
		// Fail closed: an unreadable or tampered object is never returned.
		return toolFailure(`obs_recall failed for ${id}: ${errorMessage(error)}`, {
			code: error instanceof Error && "code" in error ? error.code : undefined,
		});
	}
}

export async function projectObservations(
	event: ContextHookEvent,
	sentCounts: Map<string, number>,
	ledgerFor: (root: string) => Ledger,
): Promise<void> {
	let root: string;
	try {
		root = sessionRoot(event.sessionID);
	} catch (error) {
		console.error(`[observationpack] fail-open for session: ${errorMessage(error)}`);
		return;
	}
	const messages = event.messages;
	// How many provider requests each message has already been part of,
	// counted by the assistant messages that follow it.
	const priorAssistantCounts = new Array<number>(messages.length);
	let assistantCount = 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		priorAssistantCounts[index] = assistantCount;
		if (messages[index]?.role === "assistant") assistantCount += 1;
	}

	const requestIndex = assistantCount + 1;
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		if (!message) continue;
		let content: LLMContentPart[] | undefined;

		for (let partIndex = 0; partIndex < message.content.length; partIndex += 1) {
			const part = message.content[partIndex];
			if (!part || !isToolResultPart(part)) continue;
			const text = toolResultText(part);
			if (text === undefined) continue;

			try {
				const observation = createObservation({ toolCallId: part.id, toolName: part.name, text }, root);
				if (!observation) continue;
				await ensureStored(observation);

				const sendCountKey = `${root}\0${observation.id}`;
				const previousSends = sentCounts.get(sendCountKey) ?? priorAssistantCounts[index] ?? 0;
				if (previousSends < FULL_SENDS) {
					await ledgerFor(root)({
						event: "full",
						id: observation.id,
						request: requestIndex,
						tool: observation.toolName,
						originalBytes: observation.bytes,
						originalLines: observation.lines,
						originalTokens: observation.tokens,
						contentHash: observation.contentHash,
					});
					sentCounts.set(sendCountKey, previousSends + 1);
					continue;
				}

				const placeholder = placeholderFor(observation);
				const placeholderTokens = estimateTokens(placeholder);
				await ledgerFor(root)({
					event: "placeholder",
					id: observation.id,
					request: requestIndex,
					sendNumber: previousSends + 1,
					tool: observation.toolName,
					originalBytes: observation.bytes,
					originalLines: observation.lines,
					originalTokens: observation.tokens,
					placeholderBytes: Buffer.byteLength(placeholder, "utf8"),
					placeholderTokens,
					removedTokens: Math.max(0, observation.tokens - placeholderTokens),
				});
				content ??= [...message.content];
				content[partIndex] = withToolResultText(part, placeholder);
				sentCounts.set(sendCountKey, previousSends + 1);
			} catch (error) {
				// Fail open: a packing failure must never cost the agent its observation.
				console.error(`[observationpack] fail-open for tool result: ${errorMessage(error)}`);
			}
		}

		if (content) messages[index] = withContent(message, content);
	}
}

export {
	createObservation,
	FULL_SENDS,
	type Observation,
	PLACEHOLDER_EXCERPT_BYTES,
	placeholderFor,
	THRESHOLD_BYTES,
} from "./observation.ts";
