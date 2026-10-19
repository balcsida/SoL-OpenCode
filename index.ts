/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

// OpenCode resolves a local plugin directory through `<dir>/server` or
// `<dir>/index`, not package.json exports, so the checkout root re-exports
// the plugin for `"plugins": [{ "package": "/path/to/SoL-OpenCode" }]`.
// `tui.tsx` beside it is the TUI entry that shows the savings toasts.
export { default } from "./src/index.ts";
