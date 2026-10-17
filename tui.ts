/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

// OpenCode's TUI loads a local plugin directory's TUI entry from `<dir>/tui`.
import { Plugin } from "@opencode/plugin/tui";
import definition from "./src/tui.ts";

export default Plugin.define(definition);
