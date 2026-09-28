/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

/**
 * A zero-spend stand-in for the OpenCode v2.0.18 Promise plugin context. It
 * implements only the members SoL-OpenCode calls and reproduces the host
 * behaviour the mechanisms depend on:
 *
 * - `execute.before` sees the raw input and may rewrite it; the executor then
 *   receives `event.input` (core/src/tool.ts:271).
 * - Built-in tools fail with a typed `Tool.Error`, which reaches
 *   `execute.after` with `status: "error"`; a plugin tool that rejects is a
 *   defect that skips `execute.after` (plugin/src/promise/adapter.ts:615).
 * - Request hooks run in registration order on one mutable event.
 */

import type { SolContext, ToolResult } from "../src/context.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Callback = (event: any) => unknown;

export class FakeToolFailure extends Error {
	readonly _tag = "Tool.Error";
	readonly metadata: Record<string, unknown> | undefined;
	constructor(options: { message: string; metadata?: Record<string, unknown> }) {
		super(options.message);
		this.metadata = options.metadata;
	}
}

export interface FakeToolContext {
	readonly sessionID: string;
	readonly agent: string;
	readonly messageID: string;
	readonly id: string;
	readonly signal: AbortSignal;
	readonly progress: (update: Record<string, unknown>) => Promise<void>;
}

export interface FakeTool {
	name: string;
	description: string;
	input: unknown;
	options?: Record<string, unknown>;
	execute: (input: any, context: FakeToolContext) => Promise<ToolResult>;
}

export interface CallInfo {
	readonly sessionID: string;
	readonly id: string;
	readonly agent?: string;
	readonly messageID?: string;
}

export type CallOutcome =
	| { readonly status: "completed"; readonly result: ToolResult; readonly executedInput: unknown }
	| { readonly status: "error"; readonly error: { readonly message: string }; readonly executedInput: unknown }
	| { readonly status: "defect"; readonly error: unknown };

export interface FakeModel {
	readonly providerID: string;
	readonly id: string;
	readonly limit: { readonly context: number; readonly output: number; readonly input?: number };
}

class Subscription {
	readonly queue: unknown[] = [];
	wake: (() => void) | undefined;
	closed = false;
}

export class FakeOpenCode {
	readonly tools = new Map<string, FakeTool & { readonly builtin: boolean }>();
	readonly toolHooks: Record<"execute.before" | "execute.after", Callback[]> = {
		"execute.before": [],
		"execute.after": [],
	};
	readonly sessionHooks = new Map<string, { callback: Callback; providerID: string | undefined }[]>();
	readonly storage = new Map<string, unknown>();
	readonly subscriptions = new Set<Subscription>();
	models: FakeModel[] = [];
	options: Record<string, unknown> = {};
	generateText: (input: { prompt: string; model?: { providerID: string; id: string } }) => Promise<{ text: string }> =
		async () => {
			throw new Error("generate.text is not configured in this test");
		};
	sessionGenerate: (input: { sessionID: string; prompt: string }) => Promise<{ text: string }> = async () => {
		throw new Error("session.generate is not configured in this test");
	};
	sessionContext: (input: { sessionID: string }) => Promise<unknown[]> = async () => [];

	readonly directory: string;
	readonly projectID: string;

	constructor(directory: string, projectID = "prj_test") {
		this.directory = directory;
		this.projectID = projectID;
	}

	seedTool(tool: FakeTool): void {
		this.tools.set(tool.name, { ...tool, builtin: true });
	}

	ctx(): SolContext {
		const fake = this;
		const context = {
			location: {
				directory: this.directory,
				project: { id: this.projectID, directory: this.directory, canonical: this.directory },
			},
			get options() {
				return fake.options;
			},
			tool: {
				transform: async (callback: (editor: unknown) => void) => {
					const added: string[] = [];
					callback({
						list: () => [...fake.tools.values()].map((tool) => ({ ...tool, id: tool.name })),
						get: (id: string) => {
							const tool = fake.tools.get(id);
							return tool ? { ...tool, id: tool.name } : undefined;
						},
						namespace: () => {},
						add: (tool: FakeTool) => {
							fake.tools.set(tool.name, { ...tool, builtin: false });
							added.push(tool.name);
						},
						update: (id: string, update: (tool: FakeTool) => void) => {
							const tool = fake.tools.get(id);
							if (!tool) return;
							const draft = { ...tool };
							update(draft);
							fake.tools.set(id, draft);
						},
						remove: (id: string) => fake.tools.delete(id),
					});
					return {
						dispose: async () => {
							for (const name of added) fake.tools.delete(name);
						},
					};
				},
				reload: async () => {},
				list: async () => [...fake.tools.values()].map((tool) => ({ ...tool, id: tool.name })),
				hook: async (name: "execute.before" | "execute.after", callback: Callback) => {
					fake.toolHooks[name].push(callback);
					return {
						dispose: async () => {
							fake.toolHooks[name] = fake.toolHooks[name].filter((item) => item !== callback);
						},
					};
				},
			},
			session: {
				hook: async (name: string, callback: Callback, options?: { providerID?: string }) => {
					const hooks = fake.sessionHooks.get(name) ?? [];
					const entry = { callback, providerID: options?.providerID };
					hooks.push(entry);
					fake.sessionHooks.set(name, hooks);
					return {
						dispose: async () => {
							fake.sessionHooks.set(
								name,
								(fake.sessionHooks.get(name) ?? []).filter((item) => item !== entry),
							);
						},
					};
				},
				context: (input: { sessionID: string }) => fake.sessionContext(input),
				generate: (input: { sessionID: string; prompt: string }) => fake.sessionGenerate(input),
			},
			generate: {
				text: (input: { prompt: string; model?: { providerID: string; id: string } }) => fake.generateText(input),
			},
			model: {
				list: async () => fake.models,
			},
			storage: {
				get: async (key: string) => structuredClone(fake.storage.get(key)),
				set: async (key: string, value: unknown) => {
					fake.storage.set(key, structuredClone(value));
				},
				remove: async (key: string) => {
					fake.storage.delete(key);
				},
				scan: async (options: { prefix: string }) => ({
					entries: [...fake.storage.entries()]
						.filter(([key]) => key.startsWith(options.prefix))
						.map(([key, value]) => ({ key, value })),
				}),
			},
			event: {
				subscribe: (options?: { signal?: AbortSignal }) => fake.subscribe(options?.signal),
			},
		};
		return context as unknown as SolContext;
	}

	/** Run one tool call the way OpenCode's tool registry does. */
	async callTool(name: string, input: unknown, call: CallInfo): Promise<CallOutcome> {
		const base = {
			sessionID: call.sessionID,
			agent: call.agent ?? "build",
			messageID: call.messageID ?? "msg_test",
			id: call.id,
		};
		const before = { tool: name, ...base, input: structuredClone(input) };
		for (const hook of this.toolHooks["execute.before"]) await hook(before);
		const tool = this.tools.get(before.tool);
		if (!tool) return { status: "error", error: { message: `No tool named "${before.tool}"` }, executedInput: before.input };

		const executedInput = before.input;
		let result: ToolResult;
		try {
			result = await tool.execute(executedInput, {
				...base,
				signal: new AbortController().signal,
				progress: async () => {},
			});
		} catch (error) {
			if (!tool.builtin || !(error instanceof FakeToolFailure)) return { status: "defect", error };
			const after = { tool: before.tool, ...base, input: executedInput, status: "error" as const, error };
			for (const hook of this.toolHooks["execute.after"]) await hook(after);
			return { status: "error", error: after.error, executedInput };
		}
		const after = { tool: before.tool, ...base, input: executedInput, status: "completed" as const, result };
		for (const hook of this.toolHooks["execute.after"]) await hook(after);
		return { status: "completed", result: after.result, executedInput };
	}

	/** Run every registered hook of one request kind on a single mutable event. */
	async runSessionHook<T extends { model?: { providerID: string } }>(name: string, event: T): Promise<T> {
		for (const hook of this.sessionHooks.get(name) ?? []) {
			if (hook.providerID && hook.providerID !== event.model?.providerID) continue;
			await hook.callback(event);
		}
		return event;
	}

	emit(event: unknown): void {
		for (const subscription of this.subscriptions) {
			subscription.queue.push(event);
			subscription.wake?.();
		}
	}

	/** Let queued event handlers run. */
	async settle(): Promise<void> {
		for (let index = 0; index < 5; index++) await new Promise<void>((resolve) => setImmediate(resolve));
	}

	private subscribe(signal: AbortSignal | undefined): AsyncIterable<any> {
		const subscription = new Subscription();
		this.subscriptions.add(subscription);
		const close = () => {
			subscription.closed = true;
			this.subscriptions.delete(subscription);
			subscription.wake?.();
		};
		signal?.addEventListener("abort", close, { once: true });
		return {
			[Symbol.asyncIterator]: () => ({
				next: async () => {
					while (subscription.queue.length === 0 && !subscription.closed) {
						await new Promise<void>((resolve) => {
							subscription.wake = resolve;
						});
						subscription.wake = undefined;
					}
					if (subscription.queue.length > 0) return { done: false, value: subscription.queue.shift() };
					return { done: true, value: undefined };
				},
				return: async () => {
					close();
					return { done: true, value: undefined };
				},
			}),
		};
	}
}

/* Plain LLM messages in the shape `toLLMMessages` produces (core/src/session/runner/to-llm-message.ts). */

export function userMessage(text: string, id = `msg_user_${text.length}`) {
	return { id, role: "user" as const, content: [{ type: "text" as const, text }] };
}

export function assistantMessage(id: string, parts: readonly unknown[]) {
	return { id, role: "assistant" as const, content: [...parts] };
}

export function textPart(text: string) {
	return { type: "text" as const, text };
}

export function toolCallPart(id: string, name: string, input: unknown) {
	return { type: "tool-call" as const, id, name, input };
}

export function toolResultMessage(id: string, name: string, text: string) {
	return {
		role: "tool" as const,
		content: [{ type: "tool-result" as const, id, name, result: { type: "text" as const, value: text } }],
	};
}

export function toolErrorMessage(id: string, name: string, message: string) {
	return {
		role: "tool" as const,
		content: [
			{
				type: "tool-result" as const,
				id,
				name,
				result: { type: "error" as const, value: { error: { message }, content: [] } },
			},
		],
	};
}

export function contextEvent(sessionID: string, messages: unknown[], extra: Record<string, unknown> = {}) {
	return {
		sessionID,
		agent: "build",
		model: { providerID: "test", id: "test-model" },
		system: [{ type: "text", text: "You are a coding agent." }],
		messages,
		options: {},
		tools: {} as Record<string, { description: string; input: Record<string, unknown> }>,
		...extra,
	};
}
