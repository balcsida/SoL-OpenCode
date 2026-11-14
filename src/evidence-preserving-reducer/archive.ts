/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { publishPrivateFile } from "../private-file.ts";
import { isRecord, type ReducerConfig, sha256 } from "./config.ts";

export interface ArchiveObject {
	readonly hash: string;
	readonly bytes: number;
	readonly chars: number;
	readonly lines: number;
	readonly path: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * Archived logs live under SoL-OpenCode's session-derived runtime directory.
 */
export function archiveRoot(config: ReducerConfig): string {
	return config.storeRoot;
}

export function isSourceHash(value: unknown): value is string {
	return typeof value === "string" && SHA256_PATTERN.test(value);
}

export function archivePath(root: string, hash: string): string {
	return join(root, "objects", hash.slice(0, 2), `${hash}.txt`);
}

/**
 * Store the raw log under its own content hash.
 *
 * Every quote in a receipt is checked against this archive, and the receipt
 * points the frontier agent back at it for exact readback. An existing object
 * with the same name but different bytes is an integrity failure, not a cache
 * hit.
 */
export async function archiveBody(root: string, body: string): Promise<ArchiveObject> {
	const hash = sha256(body);
	const path = archivePath(root, hash);
	await mkdir(join(root, "objects", hash.slice(0, 2)), { recursive: true, mode: 0o700 });
	let existing: FileHandle | undefined;
	try {
		existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		// Compared as bytes: the hash is of the UTF-8 encoding, which is what the file holds.
		if (createHash("sha256").update(await existing.readFile()).digest("hex") !== hash) {
			throw new Error(`Reducer archive integrity failure: ${path}`);
		}
	} catch (error) {
		if (!isRecord(error) || error.code !== "ENOENT") throw error;
		await publishPrivateFile(path, body);
	} finally {
		await existing?.close();
	}
	return {
		hash,
		bytes: Buffer.byteLength(body, "utf8"),
		chars: body.length,
		lines: body.length === 0 ? 0 : body.split("\n").length,
		path,
	};
}
