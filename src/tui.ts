/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

// Type-only import: the runtime `@opencode/plugin/tui` pulls Solid and fails
// outside the TUI. The root `tui.ts` wraps this definition with `Plugin.define`.
import type { Plugin } from "@opencode/plugin/tui";
import { isSaving, SOL_RPC } from "./rpc.ts";

export const TUI_PLUGIN_ID = "sol-opencode-tui";

const TOAST_DURATION_MS = 4_000;

export const definition: Plugin.Definition = {
	id: TUI_PLUGIN_ID,
	async setup(context) {
		const sol = context.client.rpc(SOL_RPC);
		const unsubscribe = sol.events.on("saving", (event) => {
			if (context.location && event.location?.directory !== context.location.directory) return;
			const saving: unknown = event.data;
			if (!isSaving(saving)) return;
			context.ui.toast.show({
				title: `⚡ SoL-OpenCode · ${saving.mechanism}`,
				message: `Money saved · ${saving.saving}`,
				variant: "success",
				duration: TOAST_DURATION_MS,
				sessionID: saving.sessionID,
			});
		});
		try {
			const { mechanisms } = (await sol.status({})) as { mechanisms: string[] };
			context.ui.toast.show({
				title: "SoL-OpenCode",
				message: mechanisms.length > 0 ? `Active: ${mechanisms.join(", ")}` : "Loaded with no mechanism enabled",
				variant: "info",
				duration: TOAST_DURATION_MS,
			});
		} catch (error) {
			context.ui.toast.show({
				title: "SoL-OpenCode",
				message: `The server plugin did not answer: ${error instanceof Error ? error.message : String(error)}`,
				variant: "warning",
				duration: TOAST_DURATION_MS,
			});
		}
		return unsubscribe;
	},
};

export default definition;
