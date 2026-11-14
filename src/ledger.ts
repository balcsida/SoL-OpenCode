/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Append-only JSONL record of what a mechanism did.
 *
 * The caller derives the ledger path from the active OpenCode session.
 */
export type Ledger = (entry: Record<string, unknown>) => Promise<void>;

/** Owner-only, and never through a planted symlink: entries name tools, sizes, and content hashes. */
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;

export function createLedger(path: string): Ledger {
	return async (entry) => {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		const handle = await open(path, APPEND_FLAGS, 0o600);
		try {
			await handle.appendFile(`${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, "utf8");
		} finally {
			await handle.close();
		}
	};
}
