/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLedger } from "../src/ledger.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "sol-opencode-ledger-"));
	roots.push(directory);
	return directory;
}

describe("ledger", () => {
	it("appends JSON lines to an owner-only file in owner-only directories", async () => {
		const directory = await root();
		const path = join(directory, "session", "mechanism", "ledger.jsonl");
		const ledger = createLedger(path);
		await ledger({ action: "first" });
		await ledger({ action: "second" });
		const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		expect(lines.map((line) => line.action)).toEqual(["first", "second"]);
		if (process.platform === "win32") return;
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await stat(join(directory, "session"))).mode & 0o777).toBe(0o700);
		expect((await stat(join(directory, "session", "mechanism"))).mode & 0o777).toBe(0o700);
	});

	it.skipIf(process.platform === "win32")("refuses to append through a symlink", async () => {
		const directory = await root();
		const victim = join(directory, "victim.txt");
		await writeFile(victim, "untouched\n");
		const path = join(directory, "ledger.jsonl");
		await symlink(victim, path);
		await expect(createLedger(path)({ action: "x" })).rejects.toMatchObject({ code: "ELOOP" });
		expect(await readFile(victim, "utf8")).toBe("untouched\n");
	});
});
