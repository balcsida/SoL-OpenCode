/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

/** The server plugin and its TUI companion talk over this contract. */

import { Rpc } from "@opencode/plugin/rpc";

export const SAVING_MECHANISMS = [
	"Action Fusion",
	"Observation Pack",
	"Evidence-Preserving Reducer",
	"Online Context Compact",
] as const;

export type SavingMechanism = (typeof SAVING_MECHANISMS)[number];

export interface Saving {
	readonly sessionID: string;
	readonly mechanism: SavingMechanism;
	readonly saving: string;
}

export function isSaving(value: unknown): value is Saving {
	if (typeof value !== "object" || value === null) return false;
	const { sessionID, mechanism, saving } = value as Record<string, unknown>;
	return (
		typeof sessionID === "string" &&
		typeof saving === "string" &&
		(SAVING_MECHANISMS as readonly unknown[]).includes(mechanism)
	);
}

export const SOL_RPC = Rpc.define({
	id: "sol-opencode",
	methods: {
		status: {
			input: { type: "object", properties: {}, additionalProperties: false },
			output: {
				type: "object",
				properties: { mechanisms: { type: "array", items: { type: "string" } } },
				required: ["mechanisms"],
				additionalProperties: false,
			},
		},
	},
	events: {
		saving: {
			schema: {
				type: "object",
				properties: {
					sessionID: { type: "string" },
					mechanism: { type: "string", enum: [...SAVING_MECHANISMS] },
					saving: { type: "string" },
				},
				required: ["sessionID", "mechanism", "saving"],
				additionalProperties: false,
			},
		},
	},
});
