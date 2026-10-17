/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

// Type-only import: the runtime `@opencode/plugin/tui` pulls Solid and fails
// outside the TUI. The root `tui.tsx` wraps `createDefinition` with `Plugin.define`.
import type { Plugin } from "@opencode/plugin/tui";
import { isSaving, SOL_RPC, type Saving } from "./rpc.ts";

export const TUI_PLUGIN_ID = "sol-opencode-tui";

const TOAST_DURATION_MS = 4_000;

export interface SidebarState {
	mechanisms: string[];
	sessions: Record<string, Record<string, { count: number; last: string }>>;
}

export function tally(state: SidebarState, saving: Saving): void {
	const bySession = (state.sessions[saving.sessionID] ??= {});
	const entry = (bySession[saving.mechanism] ??= { count: 0, last: saving.saving });
	entry.count += 1;
	entry.last = saving.saving;
}

export function sidebarLines(state: SidebarState, sessionID: string): string[] {
	return state.mechanisms.map((m) => {
		const t = state.sessions[sessionID]?.[m];
		return t ? `${m} ×${t.count} · ${t.last}` : m;
	});
}

export type Sidebar = (context: Plugin.Context, state: SidebarState) => () => void;

export function createDefinition(sidebar?: Sidebar): Plugin.Definition {
	return {
		id: TUI_PLUGIN_ID,
		async setup(context) {
			const [state, update] = context.storage.memory<SidebarState>("sidebar", { initial: { mechanisms: [], sessions: {} } });
			const unmount = sidebar?.(context, state);
			const sol = context.client.rpc(SOL_RPC);
			const unsubscribe = sol.events.on("saving", (event) => {
				if (context.location && event.location?.directory !== context.location.directory) return;
				const saving: unknown = event.data;
				if (!isSaving(saving)) return;
				// shortcut: savings in child sessions are tallied under the child, not the root session; upgrade with context.data.session.root() if subagent savings should roll up.
				update((draft) => tally(draft, saving));
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
				update((draft) => {
					draft.mechanisms = mechanisms;
				});
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
			return () => {
				unmount?.();
				unsubscribe();
			};
		},
	};
}

export const definition = createDefinition();
