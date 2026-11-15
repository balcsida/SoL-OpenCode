/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */
/**
 * Evidence-Preserving Reducer - delegate the first read of a long build or test
 * log to the configured reducer model, then verify what comes back.
 *
 * In build and test trajectories only a few lines of a long log change the next
 * decision. This mechanism archives the raw log, sends it to the reducer
 * provider/model selected in the SoL-Pi config through `ctx.experimental.generate.text`,
 * and accepts the resulting receipt only when every quoted line is found byte for
 * byte in the archive. A receipt that cannot be checked is discarded and the
 * original output reaches the frontier agent untouched.
 *
 * Delegation therefore never requires trusting a fluent summary. Provider
 * selection and authentication remain with OpenCode; storage and run identity
 * come from the session.
 */

import { rm, rmdir } from "node:fs/promises";
import type { SolPiConfig } from "../config.ts";
import type { Cleanup, GenerateApi, SolContext, ToolExecuteAfter, ToolResult } from "../context.ts";
import { failOpen, subscribeSessionEvents } from "../hooks.ts";
import { openCodeShellOutputDirectory, sessionRoot } from "../paths.ts";
import { errorMessage, failureReason, recallPage, toolFailure } from "../recall.ts";
import { formatSavingsBytes, type ReportSaving } from "../savings.ts";
import { archiveBody, archivePath, archiveRoot, isSourceHash } from "./archive.ts";
import { type CompletedToolCall, reducibleToolResult } from "./candidate.ts";
import {
	containsLikelySecret,
	DIAGNOSTIC_COMMAND,
	isRecord,
	loadReducerConfig,
	REDUCER_RECEIPT_SCHEMA,
	type ReducerConfig,
	type ReducerConfigOptions,
	sha256,
} from "./config.ts";
import { createJournal, type Journal } from "./journal.ts";
import { callReducer, type ProviderResult } from "./provider.ts";
import { RECALL_TOOL, receiptText, validateReceipt } from "./receipt.ts";

export interface ReducerDependencies {
	readonly generate: GenerateApi;
	readonly shellOutputDirectory: string;
	readonly report: ReportSaving;
	/** OpenCode has no such reducer model, so the next call would fail the same way. */
	readonly onModelUnavailable?: (message: string) => void;
}

/** How long reduction stays off after OpenCode could not select the reducer model. */
const MODEL_RETRY_MS = 10 * 60_000;

/** A UTF-16 code unit is at most three bytes of UTF-8, so a file past this is past `maxChars` too. */
const MAX_UTF8_BYTES_PER_CHAR = 3;

function errorName(error: unknown): string | undefined {
	return isRecord(error) && typeof error.name === "string" ? error.name : undefined;
}

/** The reduced result, or `undefined` to leave the original untouched. */
export async function reduceToolResult(
	journal: Journal,
	config: ReducerConfig,
	call: CompletedToolCall & { readonly id: string; readonly sessionID: string },
	dependencies: ReducerDependencies,
): Promise<ToolResult | undefined> {
	const reducible = await reducibleToolResult(
		call,
		dependencies.shellOutputDirectory,
		config.maxChars * MAX_UTF8_BYTES_PER_CHAR,
	);
	if (!reducible || !DIAGNOSTIC_COMMAND.test(reducible.command)) return undefined;
	const { command, isError } = reducible;
	const body = await reducible.readBody();
	if (body === undefined || body.length > config.maxChars) {
		await journal("fallback", { reason: "source-over-max-chars", sourceChars: body?.length, maxChars: config.maxChars });
		return undefined;
	}
	if (Buffer.byteLength(body, "utf8") < config.minBytes) return undefined;
	if (containsLikelySecret(body)) {
		await journal("fallback", { reason: "likely-secret" });
		return undefined;
	}

	const archive = await archiveBody(archiveRoot(config), body);
	await journal("candidate", {
		toolCallId: call.id,
		commandSha256: sha256(command),
		isError,
		sourceSha256: archive.hash,
		sourceBytes: archive.bytes,
		sourceLines: archive.lines,
		sourcePath: archive.path,
	});

	let provider: ProviderResult;
	try {
		provider = await callReducer(config, command, isError, archive, body, dependencies.generate);
	} catch (error) {
		const name = errorName(error);
		await journal("fallback", {
			toolCallId: call.id,
			sourceSha256: archive.hash,
			reason:
				name === "AbortError"
					? "model-call-timeout"
					: name === "ReducerModelUnavailableError"
						? "reducer-model-unavailable"
						: "model-call-exception",
			errorMessage: errorMessage(error),
		});
		if (name === "ReducerModelUnavailableError") dependencies.onModelUnavailable?.(errorMessage(error));
		return undefined;
	}

	await journal("provider_response", {
		toolCallId: call.id,
		sourceSha256: archive.hash,
		provider: provider.provider,
		model: provider.model,
		stopReason: provider.stopReason,
		errorMessage: provider.errorMessage,
		usage: provider.usage,
	});
	if (!provider.ok) {
		await journal("fallback", {
			toolCallId: call.id,
			sourceSha256: archive.hash,
			reason: "model-response-error",
			stopReason: provider.stopReason,
			errorMessage: provider.errorMessage,
		});
		return undefined;
	}

	const checked = validateReceipt(provider.outputText, archive, body, isError);
	if (!checked.ok) {
		await journal("fallback", {
			toolCallId: call.id,
			sourceSha256: archive.hash,
			reason: checked.reason,
			usage: provider.usage,
		});
		return undefined;
	}
	const receipt = receiptText(command, archive, checked.value, provider);
	const receiptBytes = Buffer.byteLength(receipt, "utf8");
	if (receiptBytes >= archive.bytes) {
		await journal("fallback", {
			toolCallId: call.id,
			sourceSha256: archive.hash,
			reason: "receipt-not-smaller",
			receiptBytes,
			sourceBytes: archive.bytes,
			usage: provider.usage,
		});
		return undefined;
	}
	await journal("applied", {
		toolCallId: call.id,
		commandSha256: sha256(command),
		sourceSha256: archive.hash,
		sourceBytes: archive.bytes,
		receiptSha256: sha256(receipt),
		receiptBytes,
		evidenceCount: checked.value.evidence.length,
		uncertain: checked.value.uncertain,
		usage: provider.usage,
	});
	dependencies.report({
		sessionID: call.sessionID,
		mechanism: "Evidence-Preserving Reducer",
		saving: formatSavingsBytes(archive.bytes - receiptBytes),
	});
	return {
		...call.result,
		content: reducible.projectReceipt(receipt),
		metadata: {
			...(isRecord(call.result.metadata) ? call.result.metadata : {}),
			evidencePreservingReducer: {
				schema: REDUCER_RECEIPT_SCHEMA,
				sourceSha256: archive.hash,
				sourceBytes: archive.bytes,
				receiptSha256: sha256(receipt),
				receiptBytes,
				evidenceCount: checked.value.evidence.length,
				uncertain: checked.value.uncertain,
			},
		},
	};
}

const RECALL_INPUT = {
	type: "object",
	properties: {
		source_sha256: { type: "string", description: "source_sha256 from an evidence receipt" },
		offset: { type: "integer", minimum: 0, description: "Byte offset, default 0" },
	},
	required: ["source_sha256"],
	additionalProperties: false,
} as const;

export async function register(
	ctx: SolContext,
	config: SolPiConfig,
	options: Pick<ReducerConfigOptions, "timeoutMs"> = {},
	report: ReportSaving = () => {},
): Promise<Cleanup> {
	const reducerOptions: ReducerConfigOptions = {
		reducerModel: config.evidencePreservingReducerModel,
		reducerProvider: config.evidencePreservingReducerProvider,
		...options,
	};
	const states = new Map<string, { config: ReducerConfig; journal: Journal }>();
	const stateFor = (root: string) => {
		let state = states.get(root);
		if (!state) {
			const reducerConfig = loadReducerConfig(root, reducerOptions);
			state = { config: reducerConfig, journal: createJournal(reducerConfig) };
			states.set(root, state);
		}
		return state;
	};

	await ctx.tool.transform((editor) => {
		editor.add({
			name: RECALL_TOOL,
			// A direct tool; plugin tools otherwise live only in the Code Mode catalog.
			options: { codemode: false },
			description:
				"Read the archived original of a log that an evidence receipt reduced, by source_sha256 and byte offset. Use it when exact context beyond the receipt's verified quotes is needed; continue with the returned next_offset.",
			input: RECALL_INPUT,
			execute: async (input, context) => {
				const { source_sha256: hash, offset = 0 } = input as { source_sha256: unknown; offset?: number };
				if (!isSourceHash(hash)) return toolFailure(`Unknown evidence source: ${hash}`);
				try {
					const root = archiveRoot(stateFor(sessionRoot(context.sessionID)).config);
					const recalled = await recallPage(RECALL_TOOL, hash, archivePath(root, hash), offset);
					if (!recalled) return toolFailure(`Unknown evidence source: ${hash}`);
					return { content: recalled.text, metadata: { ...recalled.page } };
				} catch (error) {
					console.error(`[evidence-preserving-reducer] ${RECALL_TOOL} failed for ${hash}: ${errorMessage(error)}`);
					return toolFailure(`${RECALL_TOOL} failed for ${hash}: ${failureReason(error)}`);
				}
			},
		});
	});

	let retryModelAt = 0;
	const dependencies: ReducerDependencies = {
		generate: ctx.experimental.generate,
		shellOutputDirectory: openCodeShellOutputDirectory(ctx.location.project.id),
		report,
		onModelUnavailable: (message) => {
			// Said where the user can find it, instead of archiving and sending every later log for nothing.
			retryModelAt = Date.now() + MODEL_RETRY_MS;
			console.error(`[evidence-preserving-reducer] ${message}. No log is reduced for the next ${MODEL_RETRY_MS / 60_000} minutes.`);
		},
	};
	await ctx.tool.hook("execute.after", failOpen("evidence-preserving-reducer execute.after", async (event) => {
		const after = event as ToolExecuteAfter;
		if (after.status !== "completed" || Date.now() < retryModelAt) return;
		let root: string;
		try {
			root = sessionRoot(after.sessionID);
		} catch {
			return;
		}
		const state = stateFor(root);
		try {
			const reduced = await reduceToolResult(state.journal, state.config, after, dependencies);
			if (reduced) after.result = reduced;
		} catch (error) {
			// Fail open: any reducer failure leaves the original result unchanged.
			await state.journal("fallback", { toolCallId: after.id, reason: "reducer-exception", errorMessage: errorMessage(error) });
		}
	}));

	// A deleted session takes its archived logs and its journal with it.
	return subscribeSessionEvents(ctx, "evidence-preserving-reducer", ["session.deleted"], async (type, sessionID) => {
		if (type !== "session.deleted") return;
		const root = sessionRoot(sessionID);
		states.delete(root);
		await rm(loadReducerConfig(root).storeRoot, { recursive: true, force: true });
		// The session root goes too once no other mechanism keeps anything in it.
		await rmdir(root).catch(() => {});
	});
}

export type { ArchiveObject } from "./archive.ts";
export {
	DIAGNOSTIC_COMMAND,
	loadReducerConfig,
	REDUCER_EVENT_SCHEMA,
	REDUCER_EVENT_TYPE,
	REDUCER_RECEIPT_PREFIX,
	REDUCER_RECEIPT_SCHEMA,
	type ReducerConfig,
	type ReducerConfigOptions,
} from "./config.ts";
export { RECALL_TOOL, validateReceipt } from "./receipt.ts";
