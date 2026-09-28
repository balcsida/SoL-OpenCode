/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveToolPath, windowsPath } from "../src/action-fusion/file-queue.ts";

/**
 * Expected values follow OpenCode v2.0.18 `FileAccess.resolvePath`
 * (core/src/file-access.ts:73) and `FSUtil.windowsPath` (util/src/fs-util.ts:258),
 * which the built-in `edit` and `write` tools use.
 */
describe("action fusion paths", () => {
	const directory = resolve("/workspace/project");
	const home = resolve("/home/user");

	it("resolves relative and absolute paths against the location directory", () => {
		expect(resolveToolPath(directory, "src/app.ts", home, "linux")).toBe(join(directory, "src", "app.ts"));
		expect(resolveToolPath(directory, "../other/app.ts", home, "linux")).toBe(resolve(directory, "../other/app.ts"));
		expect(resolveToolPath(directory, "/etc/hosts", home, "linux")).toBe("/etc/hosts");
	});

	it("expands a leading ~ like OpenCode", () => {
		expect(resolveToolPath(directory, "~", home, "linux")).toBe(home);
		expect(resolveToolPath(directory, "~/notes.md", home, "linux")).toBe(join(home, "notes.md"));
		expect(resolveToolPath(directory, "~other/notes.md", home, "linux")).toBe(join(directory, "~other", "notes.md"));
	});

	it("keeps @ prefixes, file:// URLs, and Unicode spaces literal, as OpenCode's built-ins do", () => {
		expect(resolveToolPath(directory, "@src/app.ts", home, "linux")).toBe(join(directory, "@src", "app.ts"));
		expect(resolveToolPath(directory, "file:///tmp/x.ts", home, "linux")).toBe(resolve(directory, "file:///tmp/x.ts"));
		expect(resolveToolPath(directory, "my\u00A0file.ts", home, "linux")).toBe(join(directory, "my\u00A0file.ts"));
	});

	it("converts shell drive paths only on Windows", () => {
		expect(windowsPath("/c/src/app.ts", "win32")).toBe("C:/src/app.ts");
		expect(windowsPath("/c:/src/app.ts", "win32")).toBe("C:/src/app.ts");
		expect(windowsPath("/cygdrive/d/app.ts", "win32")).toBe("D:/app.ts");
		expect(windowsPath("/mnt/e/app.ts", "win32")).toBe("E:/app.ts");
		expect(windowsPath("/c", "win32")).toBe("C:/");
		expect(windowsPath("/c/src/app.ts", "linux")).toBe("/c/src/app.ts");
		expect(windowsPath("/usr/lib", "win32")).toBe("/usr/lib");
	});
});
