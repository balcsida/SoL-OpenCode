/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { Plugin } from "@opencode/plugin";
import { loadSolPiConfig, type SolPiConfig } from "./config.ts";
import type { Cleanup, SolContext } from "./context.ts";
import { register as registerActionFusion } from "./action-fusion/index.ts";
import { register as registerEvidencePreservingReducer } from "./evidence-preserving-reducer/index.ts";
import { register as registerObservationPack } from "./observation-pack/index.ts";
import { register as registerOnlineContextCompact } from "./online-context-compact/index.ts";
import { SOL_RPC, type Saving, type SavingMechanism } from "./rpc.ts";
import type { ReportSaving } from "./savings.ts";

export const PLUGIN_ID = "sol-opencode";

type Mechanism = (ctx: SolContext, config: SolPiConfig, report: ReportSaving) => Promise<Cleanup | void>;

/**
 * Register the enabled mechanisms in SoL-Pi's order. Hooks of one kind run in
 * registration order, so ObservationPack projects the request before Online
 * Context Compact measures it.
 */
export async function registerConfiguredFeatures(ctx: SolContext, config: SolPiConfig): Promise<Cleanup> {
	const mechanisms: [boolean, SavingMechanism, Mechanism][] = [
		[config.actionFusion, "Action Fusion", registerActionFusion],
		[config.observationPack, "Observation Pack", registerObservationPack],
		[
			config.evidencePreservingReducer,
			"Evidence-Preserving Reducer",
			(context, loaded, report) => registerEvidencePreservingReducer(context, loaded, {}, report),
		],
		[
			config.onlineContextCompact,
			"Online Context Compact",
			(context, loaded, report) => registerOnlineContextCompact(context, loaded, {}, report),
		],
	];
	const labels = mechanisms.flatMap(([enabled, label]) => (enabled ? [label] : []));
	const cleanups: Cleanup[] = [];
	// The TUI channel is best effort: a mechanism must never fail because of it.
	const log = (error: unknown): void => {
		console.error(`[sol-opencode] saving event failed: ${error instanceof Error ? error.message : String(error)}`);
	};
	let report: ReportSaving = () => {};
	try {
		const registration = await ctx.rpc.register(SOL_RPC, { status: async () => ({ mechanisms: labels }) });
		report = (saving: Saving) => {
			try {
				void registration.events.emit("saving", { ...saving }).catch(log);
			} catch (error) {
				log(error);
			}
		};
		// Cleanups run in reverse, so the channel is disposed last.
		cleanups.push(() => registration.dispose());
	} catch (error) {
		console.error(`[sol-opencode] TUI channel unavailable: ${error instanceof Error ? error.message : String(error)}`);
	}
	for (const [enabled, , register] of mechanisms) {
		if (!enabled) continue;
		const cleanup = await register(ctx, config, report);
		if (cleanup) cleanups.push(cleanup);
	}
	return async () => {
		for (const cleanup of cleanups.reverse()) await cleanup();
	};
}

export default Plugin.define({
	id: PLUGIN_ID,
	async setup(ctx) {
		const { config } = loadSolPiConfig({ projectDirectory: ctx.location.directory, options: ctx.options });
		return registerConfiguredFeatures(ctx, config);
	},
});
