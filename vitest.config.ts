/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// ./upstream/ is a read-only SoL-Pi reference clone with its own suite.
		include: ["tests/**/*.test.ts"],
	},
});
