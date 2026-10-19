/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

// OpenCode's TUI loads a local plugin directory's TUI entry from `<dir>/tui` and compiles this JSX itself with
// host-provided OpenTUI. Its types are not installed here, so the JSX namespace below stands in for them.
import { Plugin } from "@opencode/plugin/tui";
import { createDefinition, sidebarLines } from "./src/tui.ts";

declare global {
	namespace JSX {
		// Solid's element union: a renderable, a nested list or accessor, text, or nothing.
		type Element = object | string | number | boolean | null | undefined;
		interface IntrinsicElements {
			box: object;
			text: object;
			b: object;
		}
	}
}

export default Plugin.define(
	createDefinition((context, state) =>
		context.ui.slot({
			append: "sidebar.content",
			// A fragment keeps the condition reactive: `status` fills `mechanisms` after the slot is mounted.
			render: (props) => (
				<>
					{state.mechanisms.length > 0 && (
						<box>
							<text fg={context.theme.text.base}>
								<b>SoL-OpenCode</b>
							</text>
							{sidebarLines(state, props.sessionID).map((line) => (
								<text fg={context.theme.text.muted}>{line}</text>
							))}
						</box>
					)}
				</>
			),
		}),
	),
);
