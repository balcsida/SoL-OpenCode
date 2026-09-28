/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */
import type { SolContext, ToolResult } from "../context.ts";
import { PLAN_STATUSES, type PlanStep } from "./plan.ts";

export const UPDATE_PLAN_TOOL = "update_plan";

export type PlanProgress = {
	readonly files_changed: readonly string[];
	readonly verification: readonly string[];
	readonly decisions: readonly string[];
};

export type PlanUpdateInput = {
	readonly toolCallId: string;
	readonly sessionID: string;
	readonly steps: readonly PlanStep[];
	readonly progress: PlanProgress | undefined;
	readonly signal: AbortSignal | undefined;
};

export type OnlineToolHandlers = {
	readonly updatePlan: (input: PlanUpdateInput) => Promise<ToolResult>;
};

const stringList = (maxItems: number) => ({
	type: "array",
	items: { type: "string", maxLength: 1000 },
	maxItems,
});

/** JSON Schema equivalent of SoL-Pi's TypeBox `update_plan` parameters. */
export const UPDATE_PLAN_INPUT = {
	type: "object",
	properties: {
		steps: {
			type: "array",
			minItems: 1,
			maxItems: 128,
			items: {
				type: "object",
				properties: {
					id: { type: "string", minLength: 1, maxLength: 16_384 },
					goal: { type: "string", minLength: 1, maxLength: 16_384 },
					status: { type: "string", enum: [...PLAN_STATUSES] },
				},
				required: ["id", "goal", "status"],
				additionalProperties: false,
			},
		},
		progress: {
			type: "object",
			properties: {
				files_changed: stringList(128),
				verification: stringList(64),
				decisions: stringList(64),
			},
			required: ["files_changed", "verification", "decisions"],
			additionalProperties: false,
		},
	},
	required: ["steps"],
	additionalProperties: false,
};

// SoL-Pi's promptSnippet and promptGuidelines have no OpenCode equivalent, so
// they are part of the description.
const DESCRIPTION = [
	"Replace the complete working plan. A newly completed step becomes a safe point where SoL-OpenCode may compact context if doing so is economical.",
	"Keep the working plan current:",
	"- Send the complete plan on every update_plan call.",
	"- Keep at most one step in_progress and mark finished steps completed.",
	"- When completing a step, include concise progress evidence when available.",
].join("\n");

export async function registerOnlineTools(ctx: SolContext, handlers: OnlineToolHandlers): Promise<void> {
	await ctx.tool.transform((editor) => {
		editor.add({
			name: UPDATE_PLAN_TOOL,
			description: DESCRIPTION,
			input: UPDATE_PLAN_INPUT,
			execute: async (input, context) => {
				const params = input as { steps: readonly PlanStep[]; progress?: PlanProgress };
				return handlers.updatePlan({
					toolCallId: context.id,
					sessionID: context.sessionID,
					steps: params.steps,
					progress: params.progress,
					signal: context.signal,
				});
			},
		});
	});
}
