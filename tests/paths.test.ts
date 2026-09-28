/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	openCodeConfigDirectory,
	openCodeDataDirectory,
	openCodeShellOutputDirectory,
	sessionRoot,
} from "../src/paths.ts";

describe("OpenCode directories", () => {
	it("mirrors OpenCode's XDG roots", () => {
		expect(openCodeConfigDirectory({}, "/home/u")).toBe(join("/home/u", ".config", "opencode"));
		expect(openCodeDataDirectory({}, "/home/u")).toBe(join("/home/u", ".local", "share", "opencode"));
		expect(openCodeConfigDirectory({ XDG_CONFIG_HOME: "/xdg/config" }, "/home/u")).toBe("/xdg/config/opencode");
		expect(openCodeDataDirectory({ XDG_DATA_HOME: "/xdg/data" }, "/home/u")).toBe("/xdg/data/opencode");
	});

	it("lets OPENCODE_CONFIG_DIR replace the global config directory", () => {
		expect(openCodeConfigDirectory({ OPENCODE_CONFIG_DIR: "/custom", XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe(
			"/custom",
		);
	});

	it("derives a session root and rejects unsafe session ids", () => {
		expect(sessionRoot("ses_0123abc", "/data/opencode")).toBe("/data/opencode/sol-opencode/ses_0123abc");
		expect(() => sessionRoot("../escape", "/data/opencode")).toThrow("safe OpenCode session id");
		expect(() => sessionRoot("", "/data/opencode")).toThrow("safe OpenCode session id");
	});

	it("locates OpenCode's shell output directory for a project", () => {
		expect(openCodeShellOutputDirectory("prj_1", "/data/opencode")).toBe("/data/opencode/shell/prj_1");
	});
});
