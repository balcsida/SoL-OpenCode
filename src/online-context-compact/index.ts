/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */
/**
 * Online Context Compact - compact at completed plan steps when it pays.
 *
 * The agent keeps its plan current with `update_plan`. A newly completed step
 * is a candidate compaction point; the economic gate (SoL-Pi's
 * `decideCompaction`, driven by `cacheWriteReadRatio`) and the window-pressure
 * check decide whether compacting now is worth the cache write.
 *
 * As SoL-Pi asks Pi for its native compaction, a selected boundary asks
 * OpenCode for its own compaction with `ctx.session.compact`, delivered as a
 * steer so it runs before the next model step of the running session. The
 * reminder to continue the plan follows it as a synthetic message. OpenCode
 * writes the summary, keeps its recent tail verbatim, and records the
 * compaction in the session's history; this mechanism only decides when.
 */

import type { SolPiConfig } from "../config.ts";
import type { Cleanup, ContextHookEvent, LLMMessage, SolContext, ToolResult } from "../context.ts";
import { errorMessage, toolFailure } from "../recall.ts";
import { formatSavingsCount, type ReportSaving } from "../savings.ts";
import { type CompactionDecision, DEFAULT_COMPACTION_ECONOMICS, decideCompaction } from "./economics.ts";
import { analyzePlanTransition, formatPlanSnapshot, parsePlanSteps } from "./plan.ts";
import { archivedTokens, findCutPoint, POST_COMPACTION_PLAN_REMINDER, requestTokens, tokenEstimate } from "./projection.ts";
import {
	type OnlineState,
	type ProgressSummary,
	recordBoundary,
	recordCompaction,
	recordCompletedPlanHandoff,
	recordCorrection,
	recordProviderRequest,
} from "./state.ts";
import { loadSession, saveSession, storageKey } from "./store.ts";
import { type PlanUpdateInput, registerOnlineTools } from "./tools.ts";

export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;
export const DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE = 1_000;

export interface OnlineContextCompactOptions {
	readonly keepRecentTokens?: number;
}

/** The last packed request the context hook saw for a session: what the next step would resend. */
interface ObservedRequest {
	readonly messages: readonly LLMMessage[];
	readonly model: ContextHookEvent["model"];
	/** The larger of the estimate and the provider-counted size, as SoL-Pi's contextTokens. */
	readonly writeTokens: number;
}

interface SessionRuntime {
	state: OnlineState;
	lastDecision: Record<string, unknown> | undefined;
	observed: ObservedRequest | undefined;
	/** A compaction this mechanism requested and OpenCode has not finished. */
	selected: { readonly inboxID: string; readonly decision: CompactionDecision } | undefined;
	/** Provider-counted size of the latest completed step, like Pi's getContextUsage(). */
	reportedTokens: number | undefined;
	busy: boolean;
	lock: Promise<void>;
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

export async function register(
	ctx: SolContext,
	config: SolPiConfig,
	options: OnlineContextCompactOptions = {},
	report: ReportSaving = () => {},
): Promise<Cleanup> {
	const keepRecentTokens = resolveKeepRecentTokens(options.keepRecentTokens);
	const cacheWriteReadRatio = config.cacheWriteReadRatio;
	const sessions = new Map<string, Promise<SessionRuntime>>();
	const windows = new Map<string, number | null>();

	const runtimeFor = (sessionID: string): Promise<SessionRuntime> => {
		let runtime = sessions.get(sessionID);
		if (!runtime) {
			runtime = loadSession(ctx.storage, sessionID).then((stored) => ({
				...stored,
				observed: undefined,
				selected: undefined,
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

	/** SoL-Pi's turn_end decision, priced from the request that produced this plan update. */
	const decide = async (runtime: SessionRuntime, observed: ObservedRequest): Promise<CompactionDecision> => {
		// Price the prefix the summary would replace as projected: ObservationPack
		// placeholders count at their size, as in SoL-Pi's observed projection.
		const cut = findCutPoint(observed.messages, keepRecentTokens);
		const archiveTokens = cut ? archivedTokens(observed.messages, cut) : 0;
		const state = runtime.state;
		const priced = decideCompaction({
			writeTokens: observed.writeTokens,
			archiveTokens,
			memoTokens: DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE,
			contextTokens: observed.writeTokens,
			completedBoundaryRequestCounts: state.completedBoundaryRequestCounts,
			remainingBoundaries: state.plan.filter((step) => step.status !== "completed").length,
			averageContextTokenIncrement:
				state.positiveContextDeltaCount === 0 ? null : state.positiveContextDeltaTotal / state.positiveContextDeltaCount,
			contextWindowTokens: await contextWindow(observed.model),
			priorCompactionCount: state.nativeCompactionCount,
			requestsSinceLastCompaction:
				state.lastCompactionRequestCount === null ? null : state.requestCount - state.lastCompactionRequestCount,
			carriedDebtTokens: state.cacheDebtTokens,
			cacheDebtRepaymentTokens: state.cacheDebtRepaymentTokens,
			cacheWriteReadRatio,
			economics: DEFAULT_COMPACTION_ECONOMICS,
		});
		// A manual compaction that finds nothing to compact fails the running
		// session, so a boundary without a cut is never requested.
		return cut ? priced : { ...priced, compact: false, reason: "native_not_compactable" };
	};

	/** Ask OpenCode to compact before its next step, then remind the agent to continue the plan. */
	const requestCompaction = async (sessionID: string, runtime: SessionRuntime, decision: CompactionDecision): Promise<boolean> => {
		try {
			const item = await ctx.session.compact({ sessionID, delivery: "steer" });
			runtime.selected = { inboxID: item.id, decision };
		} catch (error) {
			console.error(`[online-context-compact] compaction request failed; context left as is: ${errorMessage(error)}`);
			return false;
		}
		try {
			await ctx.session.synthetic({
				sessionID,
				text: POST_COMPACTION_PLAN_REMINDER,
				description: "Online context compaction reminder",
				delivery: "steer",
			});
		} catch (error) {
			console.error(`[online-context-compact] plan reminder failed: ${errorMessage(error)}`);
		}
		return true;
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
					// A boundary is decided as soon as it is recorded, like SoL-Pi's turn_end:
					// the request that produced this call has been counted and observed.
					if (runtime.observed && !runtime.selected) {
						const decision = await decide(runtime, runtime.observed);
						const requested = decision.compact ? await requestCompaction(input.sessionID, runtime, decision) : false;
						runtime.lastDecision = { ...decision, requested, at: Date.now() };
					}
				} else {
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

	// Registered after ObservationPack, so the estimate sees the packed request.
	await ctx.session.hook("context", async (event) => {
		const runtime = await runtimeFor(event.sessionID);
		await withLock(runtime, async () => {
			const estimated = requestTokens(event);
			const reported = runtime.reportedTokens;
			const writeTokens = validPositiveInteger(reported) ? Math.max(reported, estimated) : estimated;
			runtime.observed = { messages: event.messages, model: event.model, writeTokens };
			runtime.state = recordProviderRequest(runtime.state, writeTokens);
			await save(event.sessionID, runtime);
		});
	});

	// SoL-Pi treated a steering message or a `CORRECTION:` prompt as a correction.
	// OpenCode delivers every prompt as "steer" by default, so a prompt counts
	// only when it arrives while the session is running.
	await ctx.session.hook("prompt", async (event) => {
		const runtime = await runtimeFor(event.sessionID);
		const text = event.prompt.text ?? "";
		const correction = text.startsWith("CORRECTION:") || (runtime.busy && event.delivery === "steer");
		await withLock(runtime, async () => {
			if (correction) {
				runtime.state = recordCorrection(runtime.state);
			} else {
				// A new task after a completed plan starts its own request horizon.
				const next = recordCompletedPlanHandoff(runtime.state);
				if (next === runtime.state) return;
				runtime.state = next;
			}
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
			// a compaction or revert, which the stored state must reflect.
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
			await withLock(runtime, async () => {
				// The selected boundary compaction carries SoL's cache debt. OpenCode's
				// own threshold compaction, or a user's, carries none.
				const selected = data.reason === "manual" ? runtime.selected : undefined;
				runtime.selected = undefined;
				runtime.observed = undefined;
				runtime.reportedTokens = undefined;
				const decision = selected?.decision;
				runtime.state = recordCompaction(runtime.state, {
					debtTokens: decision ? decision.postCompactionTokens * (decision.incrementalCacheCostRatio ?? 0) : 0,
					repaymentTokens: decision ? Math.max(0, decision.archiveTokens - decision.memoTokens) : 0,
				});
				if (decision) {
					runtime.lastDecision = { ...runtime.lastDecision, compacted: true };
					const summary = typeof data.text === "string" ? data.text : "";
					const removed = Math.max(0, decision.archiveTokens - tokenEstimate(summary));
					if (removed > 0) {
						report({
							sessionID,
							mechanism: "Online Context Compact",
							saving: formatSavingsCount(removed, "context tokens removed"),
						});
					}
				}
				await save(sessionID, runtime);
			});
		} else if (type === "session.compaction.failed") {
			await withLock(runtime, async () => {
				if (!runtime.selected || data.reason !== "manual") return;
				runtime.selected = undefined;
				runtime.lastDecision = { ...runtime.lastDecision, compacted: false, compactionFailed: true };
				await save(sessionID, runtime);
			});
		} else if (type === "session.revert.committed") {
			await withLock(runtime, async () => {
				runtime.observed = undefined;
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
export { POST_COMPACTION_PLAN_REMINDER } from "./projection.ts";
export {
	initialOnlineState,
	ONLINE_STATE_ENTRY,
	type OnlineState,
	parseOnlineState,
	type ProgressSummary,
} from "./state.ts";
export type { PlanProgress, PlanUpdateInput } from "./tools.ts";
