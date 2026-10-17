/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { formatSavingsBytes, formatSavingsCount } from "../src/savings.ts";

describe("savings formatting", () => {
	it("rounds and groups counts", () => {
		expect(formatSavingsCount(1234.4, "x")).toBe("1,234 x");
	});

	it("scales bytes to B, KiB, and MiB", () => {
		const suffix = " removed from future prompts";
		expect(formatSavingsBytes(512)).toBe(`512 B${suffix}`);
		expect(formatSavingsBytes(2048)).toBe(`2 KiB${suffix}`);
		expect(formatSavingsBytes(1.5 * 1024 * 1024)).toBe(`1.5 MiB${suffix}`);
	});
});
