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

export const PLUGIN_ID = "sol-opencode";

type Mechanism = (ctx: SolContext, config: SolPiConfig) => Promise<Cleanup | void>;

/**
 * Register the enabled mechanisms in SoL-Pi's order. Hooks of one kind run in
 * registration order, so ObservationPack projects the request before Online
 * Context Compact measures it.
 */
export async function registerConfiguredFeatures(ctx: SolContext, config: SolPiConfig): Promise<Cleanup> {
	const mechanisms: [boolean, Mechanism][] = [
		[config.actionFusion, registerActionFusion],
		[config.observationPack, registerObservationPack],
		[config.evidencePreservingReducer, (context, loaded) => registerEvidencePreservingReducer(context, loaded)],
	];
	const cleanups: Cleanup[] = [];
	for (const [enabled, register] of mechanisms) {
		if (!enabled) continue;
		const cleanup = await register(ctx, config);
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
