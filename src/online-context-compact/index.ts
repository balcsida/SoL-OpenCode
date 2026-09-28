/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */
/**
 * Online Context Compact - compact at completed plan steps when it pays.
 *
 * The agent keeps its plan current with `update_plan`. A newly completed step
 * is a candidate compaction point; at the next provider request the economic
 * gate (SoL-Pi's `decideCompaction`, driven by `cacheWriteReadRatio`) and the
 * window-pressure check decide whether compacting now is worth the cache write.
 *
 * OpenCode v2.0.18 gives plugins no way to request its own compaction, so a
 * selected boundary is compacted in the outgoing request: the older messages
 * are summarized once through `ctx.session.generate` (the session's model and
 * cached prefix), and every later request carries that summary in their place.
 * Persisted history is never changed, and the run simply continues: there is
 * no abort and no continuation turn to schedule.
 */

import { randomUUID } from "node:crypto";
import type { SolPiConfig } from "../config.ts";
import type { Cleanup, ContextHookEvent, GenerateHookEvent, LLMMessage, SolContext, ToolResult } from "../context.ts";
import { errorMessage, toolFailure } from "../recall.ts";
import { type CompactionDecision, DEFAULT_COMPACTION_ECONOMICS, decideCompaction } from "./economics.ts";
import { analyzePlanTransition, formatPlanSnapshot, parsePlanSteps } from "./plan.ts";
import {
	applyCheckpoint,
	type CutPoint,
	findCutPoint,
	fixedTokens,
	isSummaryPrompt,
	requestTokens,
	summaryPrompt,
	tokenEstimate,
} from "./projection.ts";
import {
	type OnlineState,
	type ProgressSummary,
	recordBoundary,
	recordCompaction,
	recordCorrection,
	recordProviderRequest,
} from "./state.ts";
import { type Checkpoint, loadSession, saveSession, storageKey } from "./store.ts";
import { type PlanUpdateInput, registerOnlineTools } from "./tools.ts";

export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
export const DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE = 1_000;
export const SUMMARY_MAX_OUTPUT_TOKENS = 4_096;

export interface OnlineContextCompactOptions {
	readonly keepRecentTokens?: number;
}

interface SessionRuntime {
	state: OnlineState;
	checkpoint: Checkpoint | undefined;
	lastDecision: Record<string, unknown> | undefined;
	pendingBoundary: { readonly toolCallId: string } | undefined;
	/** Provider-counted size of the latest completed step, like Pi's getContextUsage(). */
	reportedTokens: number | undefined;
	busy: boolean;
	lock: Promise<void>;
}

interface PendingSummary {
	readonly nonce: string;
	readonly messages: readonly LLMMessage[];
}

export function resolveKeepRecentTokens(value: number | undefined): number {
	const resolved = value ?? DEFAULT_KEEP_RECENT_TOKENS;
	if (!Number.isSafeInteger(resolved) || resolved < 1) {
		throw new Error("Online Context Compact keepRecentTokens must be a positive safe integer");
	}
	return resolved;
}

function validPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function progressSummary(input: PlanUpdateInput, completedStepId: string): ProgressSummary | undefined {
	const step = input.steps.find((item) => item.id === completedStepId);
	if (!step || !input.progress) return;
	return {
		stepId: step.id,
		goal: step.goal,
		filesChanged: [...input.progress.files_changed],
		verification: [...input.progress.verification],
		decisions: [...input.progress.decisions],
		nextWork: input.steps.filter((item) => item.status !== "completed").map((item) => item.goal),
	};
}

function stepTokens(tokens: unknown): number | undefined {
	if (typeof tokens !== "object" || tokens === null) return undefined;
	const value = tokens as { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown; write?: unknown } };
	const parts = [value.input, value.cache?.read, value.cache?.write, value.output, value.reasoning];
	if (!parts.every((part) => part === undefined || typeof part === "number")) return undefined;
	const total = (parts as (number | undefined)[]).reduce<number>((sum, part) => sum + (part ?? 0), 0);
	return total > 0 ? total : undefined;
}

function toolResultFor(messages: readonly LLMMessage[], toolCallId: string) {
	for (const message of messages) {
		for (const part of message.content) {
			if (part.type === "tool-result" && part.id === toolCallId) return part;
		}
	}
	return undefined;
}

export async function register(
	ctx: SolContext,
	config: SolPiConfig,
	options: OnlineContextCompactOptions = {},
): Promise<Cleanup> {
	const keepRecentTokens = resolveKeepRecentTokens(options.keepRecentTokens);
	const cacheWriteReadRatio = config.cacheWriteReadRatio;
	const sessions = new Map<string, Promise<SessionRuntime>>();
	const pendingSummaries = new Map<string, PendingSummary>();
	const windows = new Map<string, number | null>();

	const runtimeFor = (sessionID: string): Promise<SessionRuntime> => {
		let runtime = sessions.get(sessionID);
		if (!runtime) {
			runtime = loadSession(ctx.storage, sessionID).then((stored) => ({
				...stored,
				pendingBoundary: undefined,
				reportedTokens: undefined,
				busy: false,
				lock: Promise.resolve(),
			}));
			sessions.set(sessionID, runtime);
		}
		return runtime;
	};
	const withLock = async <T>(runtime: SessionRuntime, work: () => Promise<T>): Promise<T> => {
		const previous = runtime.lock;
		let release!: () => void;
		runtime.lock = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await work();
		} finally {
			release();
		}
	};
	const save = (sessionID: string, runtime: SessionRuntime) =>
		saveSession(ctx.storage, sessionID, runtime).catch((error: unknown) =>
			console.error(`[online-context-compact] state save failed: ${errorMessage(error)}`),
		);

	const contextWindow = async (model: ContextHookEvent["model"]): Promise<number | null> => {
		const key = `${model.providerID}/${model.id}`;
		if (!windows.has(key)) {
			try {
				const listed = await ctx.model.list();
				const found = listed.data.find((item) => item.providerID === model.providerID && item.id === model.id);
				windows.set(key, validPositiveInteger(found?.limit.context) ? found.limit.context : null);
			} catch {
				return null;
			}
		}
		return windows.get(key) ?? null;
	};

	await registerOnlineTools(ctx, {
		updatePlan: async (input) => {
			const runtime = await runtimeFor(input.sessionID);
			return withLock(runtime, async (): Promise<ToolResult> => {
				if (input.signal?.aborted) return toolFailure("Plan update was aborted");
				const steps = parsePlanSteps(input.steps);
				if (!steps || steps.length === 0) return toolFailure("Plan must contain at least one valid step");

				const transition = analyzePlanTransition(runtime.state.plan, steps);
				const completedIds = transition.completedSteps.map((step) => step.id);
				if (completedIds.length > 0) {
					runtime.state = recordBoundary(runtime.state, steps, progressSummary(input, completedIds[0] ?? ""));
					runtime.pendingBoundary ??= { toolCallId: input.toolCallId };
				} else if (JSON.stringify(runtime.state.plan) !== JSON.stringify(steps)) {
					runtime.state = { ...runtime.state, plan: [...steps] };
				}
				await save(input.sessionID, runtime);

				return {
					content: [formatPlanSnapshot(steps), ...transition.advice].join("\n"),
					metadata: {
						boundary: completedIds.length > 0,
						completed_step_ids: completedIds,
						progress_recorded: completedIds.length > 0 && input.progress !== undefined,
						task_status: "active",
						plan: steps,
					},
				};
			});
		},
	});

	/** SoL-Pi's turn_end decision, taken at the request that carries the update_plan result. */
	const decide = async (
		event: ContextHookEvent,
		runtime: SessionRuntime,
		writeTokens: number,
	): Promise<{ decision: CompactionDecision; cut: CutPoint | undefined } | undefined> => {
		const boundary = runtime.pendingBoundary;
		runtime.pendingBoundary = undefined;
		if (!boundary) return undefined;
		const result = toolResultFor(event.messages, boundary.toolCallId);
		if (!result || result.result.type === "error") return undefined;

		const archiveTokens = Math.max(0, writeTokens - fixedTokens(event) - keepRecentTokens);
		const state = runtime.state;
		const priced = decideCompaction({
			writeTokens,
			archiveTokens,
			memoTokens: DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE,
			contextTokens: writeTokens,
			completedBoundaryRequestCounts: state.completedBoundaryRequestCounts,
			remainingBoundaries: state.plan.filter((step) => step.status !== "completed").length,
			averageContextTokenIncrement:
				state.positiveContextDeltaCount === 0 ? null : state.positiveContextDeltaTotal / state.positiveContextDeltaCount,
			contextWindowTokens: await contextWindow(event.model),
			priorCompactionCount: state.nativeCompactionCount,
			carriedDebtTokens: state.cacheDebtTokens,
			cacheDebtRepaymentTokens: state.cacheDebtRepaymentTokens,
			cacheWriteReadRatio,
			economics: DEFAULT_COMPACTION_ECONOMICS,
		});
		const cut = priced.compact ? findCutPoint(event.messages, keepRecentTokens) : undefined;
		const decision: CompactionDecision =
			priced.compact && !cut ? { ...priced, compact: false, reason: "native_not_compactable" } : priced;
		return { decision, cut };
	};

	const compact = async (
		event: ContextHookEvent,
		runtime: SessionRuntime,
		decision: CompactionDecision,
		cut: CutPoint,
	): Promise<boolean> => {
		const nonce = randomUUID();
		pendingSummaries.set(event.sessionID, { nonce, messages: event.messages.slice(0, cut.index) });
		let summary: string;
		try {
			summary = (await ctx.session.generate({ sessionID: event.sessionID, prompt: summaryPrompt(nonce) })).text.trim();
		} catch (error) {
			console.error(`[online-context-compact] summary failed; request left unchanged: ${errorMessage(error)}`);
			return false;
		} finally {
			pendingSummaries.delete(event.sessionID);
		}
		if (!summary) return false;

		runtime.checkpoint = {
			keptMessageID: cut.messageID,
			summary,
			archivedMessages: cut.index,
			createdAt: Date.now(),
		};
		runtime.state = recordCompaction(runtime.state, {
			debtTokens: decision.writeTokens * (decision.incrementalCacheCostRatio ?? 0),
			repaymentTokens: Math.max(0, decision.archiveTokens - decision.memoTokens),
		});
		runtime.reportedTokens = undefined;
		applyCheckpoint(event, runtime.checkpoint);
		return true;
	};

	// Registered after ObservationPack, so the estimate sees the packed request.
	await ctx.session.hook("context", async (event) => {
		const runtime = await runtimeFor(event.sessionID);
		await withLock(runtime, async () => {
			if (applyCheckpoint(event, runtime.checkpoint) === "stale") runtime.checkpoint = undefined;

			const estimated = requestTokens(event);
			const reported = runtime.reportedTokens;
			const writeTokens = validPositiveInteger(reported) ? Math.max(reported, estimated) : estimated;
			const selected = await decide(event, runtime, writeTokens);
			let compacted = false;
			if (selected) {
				compacted = selected.decision.compact && selected.cut ? await compact(event, runtime, selected.decision, selected.cut) : false;
				runtime.lastDecision = {
					...selected.decision,
					compacted,
					summaryFailed: selected.decision.compact && !compacted,
					at: Date.now(),
				};
			}
			runtime.state = recordProviderRequest(runtime.state, compacted ? requestTokens(event) : writeTokens);
			await save(event.sessionID, runtime);
		});
	});

	// The summary request reuses the primary request's projected prefix exactly,
	// so the provider's prompt cache covers it, and drops the kept tail.
	await ctx.session.hook("generate", (event: GenerateHookEvent) => {
		const pending = pendingSummaries.get(event.sessionID);
		if (!pending) return;
		const prompt = event.messages.at(-1);
		if (!prompt || !isSummaryPrompt(prompt, pending.nonce)) return;
		event.messages = [...pending.messages, prompt];
		event.options.maxTokens = SUMMARY_MAX_OUTPUT_TOKENS;
	});

	// SoL-Pi treated a steering message or a `CORRECTION:` prompt as a correction.
	// OpenCode delivers every prompt as "steer" by default, so a prompt counts
	// only when it arrives while the session is running.
	await ctx.session.hook("prompt", async (event) => {
		const runtime = await runtimeFor(event.sessionID);
		const text = event.prompt.text ?? "";
		if (!text.startsWith("CORRECTION:") && !(runtime.busy && event.delivery === "steer")) return;
		await withLock(runtime, async () => {
			runtime.pendingBoundary = undefined;
			runtime.state = recordCorrection(runtime.state);
			await save(event.sessionID, runtime);
		});
	});

	const subscription = new AbortController();
	const handleEvent = async (type: string, sessionID: string, data: Record<string, unknown>) => {
		if (type === "session.deleted") {
			sessions.delete(sessionID);
			await ctx.storage.remove(storageKey(sessionID));
			return;
		}
		if (!sessions.has(sessionID)) {
			// Nothing to update for a session this instance has not seen, except
			// an OpenCode compaction, which must retire a stored checkpoint.
			if (type !== "session.compaction.ended" && type !== "session.revert.committed") return;
		}
		const runtime = await runtimeFor(sessionID);
		if (type === "session.execution.started") runtime.busy = true;
		else if (
			type === "session.idle" ||
			type === "session.execution.succeeded" ||
			type === "session.execution.failed" ||
			type === "session.execution.interrupted"
		) {
			runtime.busy = false;
		} else if (type === "session.step.ended") {
			runtime.reportedTokens = stepTokens(data.tokens);
		} else if (type === "session.compaction.ended") {
			// OpenCode compacted natively: its summary supersedes ours, and the
			// compaction carries no cache debt of SoL's making.
			await withLock(runtime, async () => {
				runtime.checkpoint = undefined;
				runtime.pendingBoundary = undefined;
				runtime.reportedTokens = undefined;
				runtime.state = recordCompaction(runtime.state, { debtTokens: 0, repaymentTokens: 0 });
				await save(sessionID, runtime);
			});
		} else if (type === "session.revert.committed") {
			await withLock(runtime, async () => {
				runtime.pendingBoundary = undefined;
				runtime.state = recordCorrection(runtime.state);
				await save(sessionID, runtime);
			});
		}
	};
	void (async () => {
		for await (const event of ctx.event.subscribe({ signal: subscription.signal })) {
			const type = (event as { type?: unknown }).type;
			const data = (event as { data?: unknown }).data;
			if (typeof type !== "string" || typeof data !== "object" || data === null) continue;
			const sessionID = (data as { sessionID?: unknown }).sessionID;
			if (typeof sessionID !== "string") continue;
			await handleEvent(type, sessionID, data as Record<string, unknown>).catch((error: unknown) =>
				console.error(`[online-context-compact] ${type} handling failed: ${errorMessage(error)}`),
			);
		}
	})().catch((error: unknown) => console.error(`[online-context-compact] event subscription ended: ${errorMessage(error)}`));

	return () => subscription.abort();
}

export { tokenEstimate };
export {
	type CompactionDecision,
	type CompactionEconomics,
	type CompactionReason,
	DEFAULT_COMPACTION_ECONOMICS,
	decideCompaction,
	estimateRemainingRequests,
} from "./economics.ts";
export {
	analyzePlanTransition,
	formatPlanSnapshot,
	parsePlanSteps,
	type PlanStatus,
	type PlanStep,
} from "./plan.ts";
export { BOUNDARY_COMPACTION_INSTRUCTIONS, POST_COMPACTION_PLAN_REMINDER } from "./projection.ts";
export {
	initialOnlineState,
	ONLINE_STATE_ENTRY,
	type OnlineState,
	parseOnlineState,
	type ProgressSummary,
} from "./state.ts";
export type { PlanProgress, PlanUpdateInput } from "./tools.ts";
