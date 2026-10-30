/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type SolPiConfig } from "../src/config.ts";
import type { LLMMessage, ToolResult } from "../src/context.ts";
import { messageText } from "../src/messages.ts";
import { register as registerObservationPack } from "../src/observation-pack/index.ts";
import { DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE, POST_COMPACTION_PLAN_REMINDER, register } from "../src/online-context-compact/index.ts";
import { messageTokens } from "../src/online-context-compact/projection.ts";
import { loadSession } from "../src/online-context-compact/store.ts";
import {
	assistantMessage,
	contextEvent,
	FakeOpenCode,
	textPart,
	toolCallPart,
	toolResultMessage,
	userMessage,
} from "./fake-opencode.ts";

const SESSION = "ses_occ";
const KEEP = 2_000;
const cleanups: (() => void | Promise<void>)[] = [];
const roots: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0)) await cleanup();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Step = { id: string; goal: string; status: "pending" | "in_progress" | "completed" };

const PLAN: Step[] = [
	{ id: "inspect", goal: "inspect the implementation", status: "in_progress" },
	{ id: "change", goal: "make the change", status: "pending" },
	{ id: "verify", goal: "verify the change", status: "pending" },
];

function completedFirst(): Step[] {
	return [
		{ ...PLAN[0]!, status: "completed" },
		{ ...PLAN[1]!, status: "in_progress" },
		PLAN[2]!,
	];
}

function completedSecond(): Step[] {
	return [
		{ ...PLAN[0]!, status: "completed" },
		{ ...PLAN[1]!, status: "completed" },
		{ ...PLAN[2]!, status: "in_progress" },
	];
}

function allCompleted(): Step[] {
	return PLAN.map((step) => ({ ...step, status: "completed" as const }));
}

/** A session as OpenCode runs it: history, requests through the context hook, and native compaction. */
class Scenario {
	readonly fake: FakeOpenCode;
	readonly history: LLMMessage[] = [];
	private turn = 0;
	private compacted = 0;

	constructor(fake: FakeOpenCode) {
		this.fake = fake;
		fake.models = [{ providerID: "test", id: "test-model", limit: { context: 1_000_000, output: 8_000 } }];
	}

	/** One assistant step that read a file of `bytes` bytes. */
	work(bytes: number): void {
		this.turn++;
		const call = `call_read_${this.turn}`;
		this.history.push(
			assistantMessage(`msg_a${this.turn}`, [textPart(`step ${this.turn}`), toolCallPart(call, "read", { path: `f${this.turn}.ts` })]) as LLMMessage,
			toolResultMessage(call, "read", `${this.turn}:${"x".repeat(bytes)}`) as LLMMessage,
		);
	}

	async request(): Promise<LLMMessage[]> {
		const event = contextEvent(SESSION, [...this.history]);
		await this.fake.runSessionHook("context", event);
		return event.messages as LLMMessage[];
	}

	async plan(steps: Step[], id: string, progress?: Record<string, string[]>): Promise<ToolResult> {
		const outcome = await this.fake.callTool("update_plan", { steps, ...(progress ? { progress } : {}) }, { sessionID: SESSION, id });
		if (outcome.status !== "completed") throw new Error(`update_plan ${outcome.status}`);
		this.turn++;
		this.history.push(
			assistantMessage(`msg_a${this.turn}`, [toolCallPart(id, "update_plan", { steps })]) as LLMMessage,
			toolResultMessage(id, "update_plan", String(outcome.result.content)) as LLMMessage,
		);
		return outcome.result;
	}

	/**
	 * OpenCode runs the requested compaction before its next step: history now
	 * starts at the compaction's checkpoint, the steered reminder is admitted as
	 * a user message, and `session.compaction.ended` reports the summary.
	 */
	async compactNatively(summary = "SUMMARY: inspected src/a.ts; next make the change", reason = "manual"): Promise<void> {
		this.compacted++;
		const admitted = this.fake.synthetics.splice(0).map((item, index) => userMessage(item.text, `msg_synthetic_${this.compacted}_${index}`));
		this.history.splice(
			0,
			this.history.length,
			userMessage(`<conversation-checkpoint>\n<summary>\n${summary}\n</summary>\n</conversation-checkpoint>`, `msg_compaction_${this.compacted}`) as LLMMessage,
			...(admitted as LLMMessage[]),
		);
		this.fake.emit({ type: "session.compaction.ended", data: { sessionID: SESSION, reason, text: summary } });
		await this.fake.settle();
	}

	async stored() {
		return loadSession(this.fake.ctx().storage, SESSION);
	}
}

async function setup(config: Partial<SolPiConfig> = {}, fake = new FakeOpenCode("/tmp/occ-project")): Promise<Scenario> {
	const scenario = new Scenario(fake);
	cleanups.push(await register(fake.ctx(), { ...DEFAULT_CONFIG, onlineContextCompact: true, ...config }, { keepRecentTokens: KEEP }, fake.report));
	return scenario;
}

/** A session with one completed plan step and enough history to compact. */
async function atBoundary(scenario: Scenario, bytes = 6_000, steps = 4): Promise<void> {
	scenario.history.push(userMessage("Implement the feature.", "msg_user") as LLMMessage);
	await scenario.request();
	await scenario.plan(PLAN, "plan-0");
	for (let index = 0; index < steps; index++) {
		scenario.work(bytes);
		await scenario.request();
	}
	await scenario.plan(completedFirst(), "plan-1", { files_changed: [], verification: ["read files"], decisions: [] });
}

describe("online context compact", () => {
	it("registers update_plan and its request and prompt hooks", async () => {
		const { fake } = await setup();
		expect([...fake.tools.keys()]).toEqual(["update_plan"]);
		for (const hook of ["context", "prompt"]) expect(fake.sessionHooks.get(hook)).toHaveLength(1);
		expect(fake.sessionHooks.get("generate")).toBeUndefined();
	});

	it("records the plan, returns its snapshot and advice, and reports an invalid plan as content", async () => {
		const scenario = await setup();
		const result = await scenario.plan(
			[
				{ id: "a", goal: "first", status: "in_progress" },
				{ id: "b", goal: "second", status: "in_progress" },
			],
			"plan-x",
		);
		expect(result.content).toBe(
			'<sol-pi-plan task_status="active">{"steps":[{"id":"a","goal":"first","status":"in_progress"},{"id":"b","goal":"second","status":"in_progress"}]}</sol-pi-plan>\nKeep at most one plan step in_progress.',
		);
		expect(result.metadata).toMatchObject({ boundary: false, task_status: "active" });
		expect((await scenario.stored()).state.plan).toHaveLength(2);

		const duplicate = await scenario.fake.callTool(
			"update_plan",
			{ steps: [{ id: "a", goal: "one", status: "pending" }, { id: "a", goal: "two", status: "pending" }] },
			{ sessionID: SESSION, id: "plan-dup" },
		);
		expect(duplicate.status === "completed" && duplicate.result.content).toBe("Plan must contain at least one valid step");
	});

	it("requests OpenCode's compaction at an economic boundary and reminds the agent to continue", async () => {
		const scenario = await setup({ cacheWriteReadRatio: 1 });
		await atBoundary(scenario);

		// The decision is taken in the update_plan call, before the next step.
		expect(scenario.fake.compactions).toEqual([{ sessionID: SESSION, delivery: "steer", id: "inbox_compact_1" }]);
		expect(scenario.fake.synthetics).toEqual([
			{ sessionID: SESSION, text: POST_COMPACTION_PLAN_REMINDER, description: "Online context compaction reminder", delivery: "steer" },
		]);
		let stored = await scenario.stored();
		expect(stored.lastDecision).toMatchObject({ compact: true, requested: true, reason: "economic" });
		expect(stored.state.nativeCompactionCount).toBe(0);
		expect(scenario.fake.rpcEvents).toEqual([]);

		await scenario.compactNatively();
		expect(messageText(scenario.history[0]!)).toContain("<conversation-checkpoint>");
		expect(messageText(scenario.history[1]!)).toBe(POST_COMPACTION_PLAN_REMINDER);
		expect(scenario.fake.rpcEvents).toHaveLength(1);
		expect(scenario.fake.rpcEvents[0]).toMatchObject({
			name: "saving",
			data: { sessionID: SESSION, mechanism: "Online Context Compact" },
		});
		expect((scenario.fake.rpcEvents[0]?.data as { saving: string }).saving).toMatch(/^[\d,]+ context tokens removed$/u);

		stored = await scenario.stored();
		// The plan survives compaction; the request that compacted is the cooldown's origin.
		expect(stored.state).toMatchObject({ nativeCompactionCount: 1, epoch: 1, plan: completedFirst(), lastContextTokens: null });
		expect(stored.state.lastCompactionRequestCount).toBe(stored.state.requestCount);
		expect(stored.lastDecision).toMatchObject({ compact: true, requested: true, compacted: true });
	});

	it("keeps the plan across compaction, so only a registered step completing is progress", async () => {
		const scenario = await setup({ cacheWriteReadRatio: 1 });
		await atBoundary(scenario);
		await scenario.compactNatively();
		expect(scenario.fake.compactions).toHaveLength(1);

		// After the reminder the model re-states the plan, then re-keys it.
		const restated = await scenario.plan(completedFirst(), "plan-2");
		expect(restated.metadata).toMatchObject({ boundary: false, completed_step_ids: [] });
		const rekeyed: Step[] = [
			{ id: "inspect-again", goal: "inspect the implementation (restated)", status: "completed" },
			{ id: "change-again", goal: "make the change", status: "in_progress" },
		];
		expect((await scenario.plan(rekeyed, "plan-3")).metadata).toMatchObject({ boundary: false });
		expect((await scenario.stored()).state).toMatchObject({ plan: rekeyed, completedBoundaryRequestCounts: [5] });

		for (let index = 0; index < 4; index++) {
			scenario.work(6_000);
			await scenario.request();
		}
		const progressed = await scenario.plan(rekeyed.map((step) => ({ ...step, status: "completed" })), "plan-4");
		expect(progressed.metadata).toMatchObject({ boundary: true, completed_step_ids: ["change-again"] });
		expect((await scenario.stored()).state.completedBoundaryRequestCounts).toEqual([5, 4]);
		expect(scenario.fake.compactions).toHaveLength(2);
	});

	it("cools down economic compaction for two requests after a compaction", async () => {
		const scenario = await setup({ cacheWriteReadRatio: 1 });
		await atBoundary(scenario);
		// A long checkpoint leaves enough older context to make the next cut pay.
		await scenario.compactNatively(`SUMMARY: ${"details ".repeat(4_000)}`);
		expect(scenario.fake.compactions).toHaveLength(1);

		scenario.work(20_000);
		await scenario.request();
		await scenario.plan(completedSecond(), "plan-2");
		expect(scenario.fake.compactions).toHaveLength(1);
		expect((await scenario.stored()).lastDecision).toMatchObject({
			compact: false,
			reason: "deferred_post_compaction_cooldown",
			requestsSinceLastCompaction: 1,
		});

		scenario.work(6_000);
		await scenario.request();
		scenario.work(6_000);
		await scenario.request();
		await scenario.plan(allCompleted(), "plan-3");
		expect(scenario.fake.compactions).toHaveLength(2);
		expect((await scenario.stored()).lastDecision).toMatchObject({
			compact: true,
			reason: "economic",
			requestsSinceLastCompaction: 3,
		});
	});

	it("starts a new task's horizon fresh once the plan is complete", async () => {
		const scenario = await setup();
		await atBoundary(scenario);
		await scenario.plan(allCompleted(), "plan-2");
		expect((await scenario.stored()).state.completedBoundaryRequestCounts).toEqual([5, 0]);

		await scenario.fake.runSessionHook("prompt", { sessionID: SESSION, messageID: "m", prompt: { text: "Now add the docs." }, delivery: "steer" });
		expect((await scenario.stored()).state).toMatchObject({ plan: [], completedBoundaryRequestCounts: [], epoch: 1 });
	});

	it("prices savings from the packed request, not the persisted history", async () => {
		const root = await mkdtemp(join(tmpdir(), "sol-opencode-occ-"));
		roots.push(root);
		vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
		const fake = new FakeOpenCode("/tmp/occ-project");
		await registerObservationPack(fake.ctx(), { ...DEFAULT_CONFIG, observationPack: true });
		const scenario = await setup({ cacheWriteReadRatio: 1 }, fake);

		scenario.history.push(userMessage("Inspect the diagnostic output.", "msg_user") as LLMMessage);
		await scenario.request();
		await scenario.plan(PLAN, "plan-0");
		scenario.work(200_000);
		// Sent in full twice, then packed; the packed result sits before the cut point.
		for (let index = 0; index < 2; index++) await scenario.request();
		for (let index = 0; index < 2; index++) {
			scenario.work(6_000);
			await scenario.request();
		}
		const projected = await scenario.request();
		expect(messageText(projected[4]!)).toContain("large tool result replaced");
		expect(messageTokens(scenario.history[4]!)).toBeGreaterThan(DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE);

		await scenario.plan(completedFirst(), "plan-1");
		expect(scenario.fake.compactions).toEqual([]);
		const decision = (await scenario.stored()).lastDecision;
		expect(decision).toMatchObject({ compact: false, reason: "non_positive_saving" });
		expect(Number(decision?.archiveTokens)).toBeLessThan(DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE);
	});

	it("requests one compaction at a time", async () => {
		const scenario = await setup({ cacheWriteReadRatio: 1 });
		await atBoundary(scenario);
		await scenario.request();
		await scenario.plan(completedSecond(), "plan-2");
		expect(scenario.fake.compactions).toHaveLength(1);
		expect((await scenario.stored()).lastDecision).toMatchObject({ compact: true, requested: true });
	});

	it("declines a compaction that the cache write/read ratio makes uneconomic", async () => {
		const scenario = await setup({ cacheWriteReadRatio: 100 });
		await atBoundary(scenario);
		expect(scenario.fake.compactions).toEqual([]);
		expect(scenario.fake.synthetics).toEqual([]);
		expect((await scenario.stored()).lastDecision).toMatchObject({ compact: false, reason: "deferred_economic" });
	});

	it("compacts under window pressure even when not economic", async () => {
		const scenario = await setup();
		scenario.fake.models = [{ providerID: "test", id: "test-model", limit: { context: 20_000, output: 4_000 } }];
		await atBoundary(scenario);
		expect(scenario.fake.compactions).toHaveLength(1);
		expect((await scenario.stored()).lastDecision).toMatchObject({ compact: true, requested: true, reason: "window_protection" });
	});

	it("does not request a compaction when no cut leaves older conversation to summarize", async () => {
		const scenario = await setup({ cacheWriteReadRatio: 1 });
		scenario.history.push(userMessage("Implement the feature.", "msg_user") as LLMMessage);
		await scenario.request();
		await scenario.plan(PLAN, "plan-0");
		// A large provider-counted size makes compaction attractive, but the
		// history is shorter than the retained tail.
		scenario.fake.emit({
			type: "session.step.ended",
			data: { sessionID: SESSION, tokens: { input: 50_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } },
		});
		await scenario.fake.settle();
		scenario.work(100);
		await scenario.request();
		await scenario.plan(completedFirst(), "plan-1");
		expect(scenario.fake.compactions).toEqual([]);
		expect((await scenario.stored()).lastDecision).toMatchObject({ compact: false, reason: "native_not_compactable" });
	});

	it("leaves a boundary undecided until a request has been observed", async () => {
		const scenario = await setup({ cacheWriteReadRatio: 1 });
		await scenario.plan(PLAN, "plan-0");
		const result = await scenario.plan(completedFirst(), "plan-1");
		expect(result.metadata).toMatchObject({ boundary: true });
		expect(scenario.fake.compactions).toEqual([]);
		expect((await scenario.stored()).lastDecision).toBeUndefined();
	});

	it("fails open when OpenCode rejects the compaction request", async () => {
		const scenario = await setup({ cacheWriteReadRatio: 1 });
		scenario.fake.compactError = new Error("session is closed");
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await atBoundary(scenario);
			expect(spy.mock.calls).toEqual([["[online-context-compact] compaction request failed; context left as is: session is closed"]]);
		} finally {
			spy.mockRestore();
		}
		expect(scenario.fake.synthetics).toEqual([]);
		expect(scenario.fake.rpcEvents).toEqual([]);
		const stored = await scenario.stored();
		expect(stored.state.nativeCompactionCount).toBe(0);
		expect(stored.lastDecision).toMatchObject({ compact: true, requested: false });
	});

	it("clears a selection whose compaction failed, so a later boundary can request again", async () => {
		const scenario = await setup({ cacheWriteReadRatio: 1 });
		await atBoundary(scenario);
		scenario.fake.emit({
			type: "session.compaction.failed",
			data: { sessionID: SESSION, reason: "manual", error: { type: "compaction.failed", message: "nothing to compact" } },
		});
		await scenario.fake.settle();
		let stored = await scenario.stored();
		expect(stored.state.nativeCompactionCount).toBe(0);
		expect(stored.lastDecision).toMatchObject({ compacted: false, compactionFailed: true });

		scenario.work(6_000);
		await scenario.request();
		await scenario.plan(completedSecond(), "plan-2");
		expect(scenario.fake.compactions).toHaveLength(2);
		stored = await scenario.stored();
		expect(stored.lastDecision).toMatchObject({ compact: true, requested: true });
		expect(stored.lastDecision).not.toHaveProperty("compactionFailed");
	});

	it("uses the provider-counted size of the last step when it exceeds the estimate", async () => {
		const scenario = await setup();
		scenario.history.push(userMessage("hi", "msg_user") as LLMMessage);
		await scenario.request();
		scenario.fake.emit({
			type: "session.step.ended",
			data: { sessionID: SESSION, tokens: { input: 900, output: 50, reasoning: 25, cache: { read: 4_000, write: 25 } } },
		});
		await scenario.fake.settle();
		await scenario.request();
		expect((await scenario.stored()).state.lastContextTokens).toBe(5_000);
	});

	it("compacts again after a native checkpoint once the next boundary pays", async () => {
		const scenario = await setup({ cacheWriteReadRatio: 1 });
		await atBoundary(scenario);
		await scenario.compactNatively();
		await scenario.request();
		await scenario.plan(PLAN.map((step, index) => ({ ...step, status: index === 0 ? ("in_progress" as const) : ("pending" as const) })), "plan-2");
		for (let index = 0; index < 4; index++) {
			scenario.work(6_000);
			await scenario.request();
		}
		await scenario.plan(completedFirst(), "plan-3");
		expect(scenario.fake.compactions).toHaveLength(2);
		await scenario.compactNatively("SUMMARY 2");
		expect(messageText(scenario.history[0]!)).toContain("SUMMARY 2");
		expect((await scenario.stored()).state.nativeCompactionCount).toBe(2);
	});

	it("counts OpenCode's own compaction without cache debt", async () => {
		const scenario = await setup({ cacheWriteReadRatio: 1 });
		scenario.history.push(userMessage("hi", "msg_user") as LLMMessage);
		await scenario.request();
		await scenario.compactNatively("auto summary", "auto");

		const stored = await scenario.stored();
		expect(stored.state).toMatchObject({ nativeCompactionCount: 1, cacheDebtTokens: 0 });
		expect(scenario.fake.rpcEvents).toEqual([]);
	});

	it("restores its state after a plugin restart", async () => {
		const scenario = await setup({ cacheWriteReadRatio: 1 });
		await atBoundary(scenario);
		await scenario.compactNatively();
		const stored = await scenario.stored();

		const restarted = new FakeOpenCode("/tmp/occ-project");
		for (const [key, value] of scenario.fake.storage) restarted.storage.set(key, value);
		const resumed = await setup({ cacheWriteReadRatio: 1 }, restarted);
		resumed.history.push(...scenario.history);
		// The restored plan makes a re-stated step no progress.
		expect((await resumed.plan(completedFirst(), "plan-r")).metadata).toMatchObject({ boundary: false });
		expect((await resumed.stored()).state).toMatchObject({ ...stored.state, plan: completedFirst() });
	});

	it("treats a CORRECTION: prompt or a steer during a run as a correction", async () => {
		const scenario = await setup({ cacheWriteReadRatio: 1 });
		await scenario.plan(PLAN, "plan-0");
		const prompt = (text: string, delivery = "steer") =>
			scenario.fake.runSessionHook("prompt", { sessionID: SESSION, messageID: "m", prompt: { text }, delivery });

		await prompt("please continue");
		expect((await scenario.stored()).state.plan).toHaveLength(3);

		scenario.fake.emit({ type: "session.execution.started", data: { sessionID: SESSION } });
		await scenario.fake.settle();
		await prompt("use the other approach");
		expect((await scenario.stored()).state).toMatchObject({ plan: [], epoch: 1 });

		await scenario.plan(PLAN, "plan-1");
		scenario.fake.emit({ type: "session.idle", data: { sessionID: SESSION } });
		await scenario.fake.settle();
		await prompt("CORRECTION: stop editing tests");
		expect((await scenario.stored()).state).toMatchObject({ plan: [], epoch: 2 });
	});

	it("resets the plan when a revert is committed and forgets a deleted session", async () => {
		const scenario = await setup();
		await scenario.plan(PLAN, "plan-0");
		scenario.fake.emit({ type: "session.revert.committed", data: { sessionID: SESSION } });
		await scenario.fake.settle();
		expect((await scenario.stored()).state).toMatchObject({ plan: [], epoch: 1 });

		scenario.fake.emit({ type: "session.deleted", data: { sessionID: SESSION } });
		await scenario.fake.settle();
		expect(scenario.fake.storage.has(`occ/${SESSION}`)).toBe(false);
	});
});
