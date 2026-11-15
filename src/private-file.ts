/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";

const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/**
 * Publish an owner-only file under `path` in one step. The bytes are written
 * and flushed under a temporary name first, so a crash or a full disk never
 * leaves a truncated file under the real name, where it would be mistaken for
 * a tampered object from then on.
 */
export async function publishPrivateFile(path: string, data: string | Buffer): Promise<void> {
	const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		const handle = await open(temporary, CREATE_FLAGS, 0o600);
		try {
			await handle.writeFile(data);
			// Best effort: not every filesystem can flush.
			await handle.sync().catch(() => {});
		} finally {
			await handle.close();
		}
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
}
