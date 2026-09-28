/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

/**
 * The slice of the OpenCode v2 Promise plugin context this plugin uses, and the
 * hook event shapes it reads. Types come from `@opencode/plugin@2.0.18`
 * (`dist/promise/*.d.ts`); tests drive the mechanisms through a fake that
 * implements only these members.
 */

import type { Plugin } from "@opencode/plugin";
import type { SessionContext, SessionGenerate } from "@opencode/plugin/promise/session";
import type { Error as ToolErrorClass, Result } from "@opencode/plugin/promise/tool";

export type SolContext = Pick<
	Plugin.Context,
	"event" | "generate" | "location" | "model" | "options" | "session" | "storage" | "tool"
>;

export type Cleanup = () => Promise<void> | void;

/** `ctx.session.hook("context")` and `hook("generate")` events. */
export type ContextHookEvent = SessionContext;
export type GenerateHookEvent = SessionGenerate;
export type RequestHookEvent = ContextHookEvent | GenerateHookEvent;

/** One `@opencode/ai` LLM message as it appears in a request hook. */
export type LLMMessage = SessionContext["messages"][number];
export type LLMContentPart = LLMMessage["content"][number];
export type ToolResultPart = Extract<LLMContentPart, { readonly type: "tool-result" }>;
export type ToolCallPart = Extract<LLMContentPart, { readonly type: "tool-call" }>;

export type ToolResult = Result;
export type ToolError = ToolErrorClass;

/** `ctx.tool.hook("execute.before")` event (`dist/promise/tool.d.ts`). */
export interface ToolExecuteBefore {
	tool: string;
	readonly sessionID: string;
	readonly agent: string;
	readonly messageID: string;
	readonly id: string;
	input: unknown;
}

interface ToolExecuteBase {
	readonly tool: string;
	readonly sessionID: string;
	readonly agent: string;
	readonly messageID: string;
	readonly id: string;
	readonly input: unknown;
}

/** `ctx.tool.hook("execute.after")` event (`dist/promise/tool.d.ts`). */
export type ToolExecuteAfter = ToolExecuteBase &
	({ readonly status: "completed"; result: ToolResult } | { readonly status: "error"; error: ToolError });
