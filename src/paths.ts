/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * OpenCode exposes no public API for its global directories, so these mirror
 * `packages/util/src/global-roots.ts` and `global.ts` at OpenCode v2.0.18:
 * XDG roots with an `opencode` suffix, and `OPENCODE_CONFIG_DIR` overriding the
 * global config directory.
 */
export const PLUGIN_DIRECTORY_NAME = "sol-opencode";

const SAFE_SESSION_ID = /^[a-z0-9][a-z0-9._-]*$/iu;

export function openCodeConfigDirectory(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	return env.OPENCODE_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
}

export function openCodeDataDirectory(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode");
}

/** Session-scoped archive root, the counterpart of SoL-Pi's `<sessionDir>/sol-pi/<sessionId>/`. */
export function sessionRoot(sessionID: string, dataDirectory = openCodeDataDirectory()): string {
	if (!SAFE_SESSION_ID.test(sessionID)) throw new Error("SoL-OpenCode requires a safe OpenCode session id");
	return join(dataDirectory, PLUGIN_DIRECTORY_NAME, sessionID);
}

/** Directory where OpenCode's `shell` tool writes full command output for one project. */
export function openCodeShellOutputDirectory(projectID: string, dataDirectory = openCodeDataDirectory()): string {
	return join(dataDirectory, "shell", projectID);
}
