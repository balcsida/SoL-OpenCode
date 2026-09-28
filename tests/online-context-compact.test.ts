/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type SolPiConfig } from "../src/config.ts";
import type { LLMMessage, ToolResult } from "../src/context.ts";
import { messageText } from "../src/messages.ts";
import { POST_COMPACTION_PLAN_REMINDER, register, SUMMARY_MAX_OUTPUT_TOKENS } from "../src/online-context-compact/index.ts";
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

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
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

class Scenario {
	readonly fake: FakeOpenCode;
	readonly history: LLMMessage[] = [];
	readonly generated: { messages: LLMMessage[]; options: Record<string, unknown> }[] = [];
	summary: string | Error = "SUMMARY: inspected src/a.ts; next make the change";
	private turn = 0;

	constructor(fake: FakeOpenCode) {
		this.fake = fake;
		fake.models = [{ providerID: "test", id: "test-model", limit: { context: 1_000_000, output: 8_000 } }];
		// OpenCode's session.generate: the session transcript plus the prompt, through the generate hooks.
		fake.sessionGenerate = async ({ sessionID, prompt }) => {
			const event = contextEvent(sessionID, [...this.history, userMessage(prompt, "msg_prompt")]);
			await fake.runSessionHook("generate", event);
			this.generated.push({ messages: event.messages as LLMMessage[], options: event.options });
			if (this.summary instanceof Error) throw this.summary;
			return { text: this.summary };
		};
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

	async stored() {
		return loadSession(this.fake.ctx().storage, SESSION);
	}
}

async function setup(config: Partial<SolPiConfig> = {}, fake = new FakeOpenCode("/tmp/occ-project")): Promise<Scenario> {
	const scenario = new Scenario(fake);
	cleanups.push(await register(fake.ctx(), { ...DEFAULT_CONFIG, onlineContextCompact: true, ...config }, { keepRecentTokens: KEEP }));
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
	it("registers update_plan and its request, generate, and prompt hooks", async () => {
		const { fake } = await setup();
		expect([...fake.tools.keys()]).toEqual(["update_plan"]);
		for (const hook of ["context", "generate", "prompt"]) expect(fake.sessionHooks.get(hook)).toHaveLength(1);
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

	it("compacts an economic boundary in the outgoing request only", async () => {
		const scenario = await setup({ cacheWriteReadRatio: 1 });
		await atBoundary(scenario);
		const history = structuredClone(scenario.history);

		const projected = await scenario.request();

		expect(scenario.generated).toHaveLength(1);
		const summaryRequest = scenario.generated[0]!;
		const prompt = summaryRequest.messages.at(-1)!;
		expect(messageText(prompt)).toMatch(/^<sol-opencode-compaction nonce="[0-9a-f-]{36}"\/>/u);
		expect(summaryRequest.options.maxTokens).toBe(SUMMARY_MAX_OUTPUT_TOKENS);
		// The summary sees the archived prefix only; the kept tail is not sent.
		const kept = projected.slice(1);
		const prefix = summaryRequest.messages.slice(0, -1);
		expect([...prefix, ...kept]).toEqual(scenario.history);

		expect(projected[0]?.role).toBe("user");
		expect(messageText(projected[0]!)).toContain("<summary>\nSUMMARY: inspected src/a.ts; next make the change\n</summary>");
		expect(messageText(projected[0]!).endsWith(POST_COMPACTION_PLAN_REMINDER)).toBe(true);
		expect(kept.at(-1)).toBe(scenario.history.at(-1));
		expect(kept[0]?.id).toMatch(/^msg_a\d+$/u);
		expect(scenario.history).toEqual(history);

		const stored = await scenario.stored();
		expect(stored.checkpoint).toMatchObject({ keptMessageID: kept[0]?.id, archivedMessages: prefix.length });
		expect(stored.state).toMatchObject({ nativeCompactionCount: 1, epoch: 1, plan: [] });
		expect(stored.lastDecision).toMatchObject({ compact: true, compacted: true, reason: "economic" });
	});

	it("keeps applying the checkpoint to later requests while history grows", async () => {
		const scenario = await setup({ cacheWriteReadRatio: 1 });
		await atBoundary(scenario);
		const first = await scenario.request();
		scenario.work(100);
		const second = await scenario.request();

		expect(scenario.generated).toHaveLength(1);
		expect(second[0]).toEqual(first[0]);
		expect(second.slice(1, first.length)).toEqual(first.slice(1));
		expect(second.length).toBe(first.length + 2);
		expect(second.length).toBeLessThan(scenario.history.length);
	});

	it("declines a compaction that the cache write/read ratio makes uneconomic", async () => {
		const scenario = await setup();
		// One short step before the boundary predicts a short horizon.
		await atBoundary(scenario, 20_000, 1);
		const projected = await scenario.request();

		expect(scenario.generated).toHaveLength(0);
		expect(projected).toEqual(scenario.history);
		expect((await scenario.stored()).lastDecision).toMatchObject({ compact: false, reason: "deferred_economic" });
	});

	it("compacts under window pressure even when not economic", async () => {
		const scenario = await setup();
		scenario.fake.models = [{ providerID: "test", id: "test-model", limit: { context: 20_000, output: 4_000 } }];
		await atBoundary(scenario);
		await scenario.request();
		expect((await scenario.stored()).lastDecision).toMatchObject({ compact: true, compacted: true, reason: "window_protection" });
	});

	it("does not compact when no cut leaves older conversation to summarize", async () => {
		const scenario = await setup({ cacheWriteReadRatio: 1 });
		await atBoundary(scenario, 100);
		// A large provider-counted size makes compaction attractive, but the
		// history is shorter than the retained tail.
		scenario.fake.emit({
			type: "session.step.ended",
			data: { sessionID: SESSION, tokens: { input: 50_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } },
		});
		await scenario.fake.settle();
		const projected = await scenario.request();
		expect(scenario.generated).toHaveLength(0);
		expect(projected).toEqual(scenario.history);
		expect((await scenario.stored()).lastDecision).toMatchObject({ compact: false, reason: "native_not_compactable" });
	});

	it("fails open when the summary cannot be generated", async () => {
		const scenario = await setup({ cacheWriteReadRatio: 1 });
		scenario.summary = new Error("provider unavailable");
		await atBoundary(scenario);
		const projected = await scenario.request();

		expect(projected).toEqual(scenario.history);
		const stored = await scenario.stored();
		expect(stored.checkpoint).toBeUndefined();
		expect(stored.state.nativeCompactionCount).toBe(0);
		expect(stored.lastDecision).toMatchObject({ compact: true, compacted: false, summaryFailed: true });
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

	it("folds the previous summary into the next compaction", async () => {
		const scenario = await setup({ cacheWriteReadRatio: 1 });
		await atBoundary(scenario);
		await scenario.request();
		await scenario.plan(PLAN.map((step) => ({ ...step, status: "pending" as const })).map((step, index) => (index === 0 ? { ...step, status: "in_progress" as const } : step)), "plan-2");
		for (let index = 0; index < 4; index++) {
			scenario.work(6_000);
			await scenario.request();
		}
		await scenario.plan(completedFirst(), "plan-3");
		scenario.summary = "SUMMARY 2";
		const projected = await scenario.request();

		expect(scenario.generated).toHaveLength(2);
		expect(messageText(scenario.generated[1]!.messages[0]!)).toContain("SUMMARY: inspected src/a.ts");
		expect(messageText(projected[0]!)).toContain("<summary>\nSUMMARY 2\n</summary>");
		expect((await scenario.stored()).state.nativeCompactionCount).toBe(2);
	});

	it("retires its checkpoint when OpenCode compacts natively", async () => {
		const scenario = await setup({ cacheWriteReadRatio: 1 });
		await atBoundary(scenario);
		await scenario.request();
		scenario.fake.emit({ type: "session.compaction.ended", data: { sessionID: SESSION, reason: "auto", text: "", recent: "" } });
		await scenario.fake.settle();

		const stored = await scenario.stored();
		expect(stored.checkpoint).toBeUndefined();
		expect(stored.state).toMatchObject({ nativeCompactionCount: 2, cacheDebtTokens: 0 });
		expect(await scenario.request()).toEqual(scenario.history);
	});

	it("drops a checkpoint whose kept message is no longer in the request", async () => {
		const scenario = await setup({ cacheWriteReadRatio: 1 });
		await atBoundary(scenario);
		const projected = await scenario.request();
		const keptID = projected[1]?.id;
		scenario.history.splice(scenario.history.findIndex((message) => message.id === keptID));
		expect(await scenario.request()).toEqual(scenario.history);
		expect((await scenario.stored()).checkpoint).toBeUndefined();
	});

	it("restores its state and checkpoint after a plugin restart", async () => {
		const scenario = await setup({ cacheWriteReadRatio: 1 });
		await atBoundary(scenario);
		const projected = await scenario.request();

		const restarted = new FakeOpenCode("/tmp/occ-project");
		for (const [key, value] of scenario.fake.storage) restarted.storage.set(key, value);
		const resumed = await setup({ cacheWriteReadRatio: 1 }, restarted);
		resumed.history.push(...scenario.history);
		expect(await resumed.request()).toEqual(projected);
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

	it("leaves generate requests it did not start untouched", async () => {
		const scenario = await setup();
		scenario.history.push(userMessage("hi", "msg_user") as LLMMessage);
		const event = contextEvent(SESSION, [...scenario.history, userMessage("Summarize this project", "p")]);
		await scenario.fake.runSessionHook("generate", event);
		expect(event.messages).toHaveLength(2);
		expect(event.options).toEqual({});
	});
});
