/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const queueTails = new Map<string, Promise<void>>();

/**
 * OpenCode's `FSUtil.windowsPath` (util/src/fs-util.ts at v2.0.18): on Windows,
 * Git Bash, MSYS, Cygwin, and WSL drive paths become native drive paths before
 * the built-in `edit` and `write` tools touch the filesystem.
 */
export function windowsPath(filePath: string, platform: NodeJS.Platform = process.platform): string {
	if (platform !== "win32") return filePath;
	return filePath
		.replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive: string) => `${drive.toUpperCase()}:/`)
		.replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:/`)
		.replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:/`)
		.replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:/`);
}

/**
 * Resolve a tool path exactly as OpenCode's `FileAccess.resolvePath` does
 * (core/src/file-access.ts:73), so the queue and hash guard address the file
 * the built-in mutation wrote. Unlike Pi, OpenCode does not strip `@`, decode
 * `file://` URLs, or normalize Unicode spaces, so neither does this.
 */
export function resolveToolPath(
	directory: string,
	filePath: string,
	home = homedir(),
	platform: NodeJS.Platform = process.platform,
): string {
	const normalized = windowsPath(filePath, platform);
	if (normalized === "~") return resolve(directory, home);
	if (normalized.startsWith("~/") || (platform === "win32" && normalized.startsWith("~\\"))) {
		return resolve(directory, join(home, normalized.slice(2)));
	}
	return resolve(directory, normalized);
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

async function canonicalQueueKey(filePath: string): Promise<string> {
	const resolvedPath = resolve(filePath);
	let current = resolvedPath;
	const missingSegments: string[] = [];

	while (true) {
		try {
			return resolve(await realpath(current), ...missingSegments);
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
			const parent = dirname(current);
			if (parent === current) return resolvedPath;
			missingSegments.unshift(basename(current));
			current = parent;
		}
	}
}

/**
 * Take one slot of the fused queue for a canonical file path and resolve with
 * the function that releases it. The queue belongs to SoL-OpenCode and is not
 * OpenCode's own file-mutation lock.
 */
export async function acquireFusedFileQueue(filePath: string): Promise<() => void> {
	const key = await canonicalQueueKey(filePath);
	const previous = queueTails.get(key) ?? Promise.resolve();
	let releaseOwned!: () => void;
	const owned = new Promise<void>((resolveOwned) => {
		releaseOwned = resolveOwned;
	});
	const tail = previous.then(() => owned);
	queueTails.set(key, tail);

	await previous;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		releaseOwned();
		if (queueTails.get(key) === tail) queueTails.delete(key);
	};
}

/** Serialize fused operations for one canonical file path. */
export async function withFusedFileQueue<T>(filePath: string, work: () => Promise<T>): Promise<T> {
	const release = await acquireFusedFileQueue(filePath);
	try {
		return await work();
	} finally {
		release();
	}
}
