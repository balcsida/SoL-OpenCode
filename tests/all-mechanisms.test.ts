/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import plugin, { PLUGIN_ID, registerConfiguredFeatures } from "../src/index.ts";
import { editTool, shellTool, writeTool } from "./fake-builtins.ts";
import { FakeOpenCode } from "./fake-opencode.ts";

const ALL_ENABLED = {
	version: 1,
	actionFusion: true,
	observationPack: true,
	evidencePreservingReducer: true,
	onlineContextCompact: true,
} as const;

const roots: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0)) await cleanup();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fake(): Promise<FakeOpenCode> {
	const root = await mkdtemp(join(tmpdir(), "sol-opencode-all-"));
	roots.push(root);
	vi.stubEnv("XDG_DATA_HOME", join(root, "data"));
	vi.stubEnv("OPENCODE_CONFIG_DIR", join(root, "config"));
	return new FakeOpenCode(join(root, "project"));
}

describe("SoL-OpenCode plugin entry", () => {
	it("is a Plugin.define definition with a stable id", () => {
		expect(plugin.id).toBe(PLUGIN_ID);
		expect(typeof plugin.setup).toBe("function");
	});

	it("is re-exported from the checkout root, where OpenCode looks for a directory plugin", async () => {
		expect((await import("../index.ts")).default).toBe(plugin);
	});

	it("registers nothing when no configuration exists", async () => {
		const opencode = await fake();
		const cleanup = await plugin.setup(opencode.ctx() as never);
		if (cleanup) cleanups.push(cleanup);
		expect(opencode.tools.size).toBe(0);
		expect(opencode.sessionHooks.size).toBe(0);
		expect(opencode.toolHooks["execute.before"]).toHaveLength(0);
		expect(opencode.toolHooks["execute.after"]).toHaveLength(0);
	});

	it("registers all four mechanisms from plugin options in SoL-Pi's order", async () => {
		const opencode = await fake();
		opencode.options = { ...ALL_ENABLED };
		const cleanup = await plugin.setup(opencode.ctx() as never);
		if (cleanup) cleanups.push(cleanup);

		expect([...opencode.tools.keys()]).toEqual(["obs_recall", "evidence_recall", "update_plan"]);
		expect(opencode.toolHooks["execute.before"]).toHaveLength(1);
		// Action Fusion appends the command output before the reducer reads it.
		expect(opencode.toolHooks["execute.after"]).toHaveLength(2);
		// Action Fusion (schema), ObservationPack, then Online Context Compact.
		expect(opencode.sessionHooks.get("context")).toHaveLength(3);
		expect(opencode.sessionHooks.get("generate")).toHaveLength(2);
		expect(opencode.sessionHooks.get("compaction")).toHaveLength(1);
		expect(opencode.sessionHooks.get("prompt")).toHaveLength(1);
	});

	it("registers the RPC contract with the enabled mechanism labels in order", async () => {
		const opencode = await fake();
		const cleanup = await registerConfiguredFeatures(opencode.ctx(), { ...DEFAULT_CONFIG, ...ALL_ENABLED });
		expect(opencode.rpcRegistrations).toHaveLength(1);
		const [registration] = opencode.rpcRegistrations;
		expect(registration?.definition.id).toBe("sol-opencode");
		expect(await registration?.handlers.status?.({})).toEqual({
			mechanisms: ["Action Fusion", "Observation Pack", "Evidence-Preserving Reducer", "Online Context Compact"],
		});
		expect(registration?.disposed).toBe(false);
		await cleanup();
		expect(registration?.disposed).toBe(true);
	});

	it("registers the RPC with no mechanism enabled", async () => {
		const opencode = await fake();
		cleanups.push(await registerConfiguredFeatures(opencode.ctx(), DEFAULT_CONFIG));
		expect(await opencode.rpcRegistrations[0]?.handlers.status?.({})).toEqual({ mechanisms: [] });
	});

	it("wires only the enabled mechanisms", async () => {
		const opencode = await fake();
		cleanups.push(
			await registerConfiguredFeatures(opencode.ctx(), { ...DEFAULT_CONFIG, observationPack: true, actionFusion: true }),
		);
		expect([...opencode.tools.keys()]).toEqual(["obs_recall"]);
		expect(opencode.sessionHooks.get("prompt")).toBeUndefined();
	});

	it("stops loading on an invalid configuration", async () => {
		const opencode = await fake();
		opencode.options = { version: 1, actionFusion: "yes" };
		await expect(plugin.setup(opencode.ctx() as never)).rejects.toThrow("SoL-Pi config actionFusion must be boolean");
	});
	describe("TUI channel", () => {
		const call = { sessionID: "ses_rpc", id: "w-1", messageID: "msg_1", agent: "build" };
		const fusedWrite = { path: "a.txt", content: "a\n", then_run: { command: "check" } };

		async function fusionFake(): Promise<FakeOpenCode> {
			const opencode = await fake();
			await mkdir(opencode.directory, { recursive: true });
			opencode.seedTool(editTool(opencode.directory));
			opencode.seedTool(writeTool(opencode.directory));
			opencode.seedTool(shellTool(async () => ({ output: "checked\n", exit: 0 })));
			return opencode;
		}

		function resultText(outcome: Awaited<ReturnType<FakeOpenCode["callTool"]>>): string {
			if (outcome.status !== "completed") throw new Error(`expected completed, got ${outcome.status}`);
			const content = outcome.result.content;
			return typeof content === "string" ? content : (content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		}

		it("delivers a saving through the real report", async () => {
			const opencode = await fusionFake();
			cleanups.push(await registerConfiguredFeatures(opencode.ctx(), { ...DEFAULT_CONFIG, actionFusion: true }));
			await opencode.callTool("write", fusedWrite, call);
			expect(opencode.rpcEvents).toEqual([
				{ name: "saving", data: { sessionID: "ses_rpc", mechanism: "Action Fusion", saving: "1 model round-trip avoided" } },
			]);
		});

		it("still registers every mechanism, and disposes nothing, when the channel is unavailable", async () => {
			const spy = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				const opencode = await fake();
				opencode.rpcRegisterError = new Error("no rpc");
				const cleanup = await registerConfiguredFeatures(opencode.ctx(), { ...DEFAULT_CONFIG, ...ALL_ENABLED });
				expect([...opencode.tools.keys()]).toEqual(["obs_recall", "evidence_recall", "update_plan"]);
				expect(opencode.toolHooks["execute.before"]).toHaveLength(1);
				expect(opencode.toolHooks["execute.after"]).toHaveLength(2);
				expect(opencode.sessionHooks.get("compaction")).toHaveLength(1);
				expect(opencode.rpcRegistrations).toHaveLength(0);
				await cleanup();
				expect(spy).toHaveBeenCalledExactlyOnceWith("[sol-opencode] TUI channel unavailable: no rpc");
			} finally {
				spy.mockRestore();
			}
		});

		it.each([
			["rejects", "rpcEmitError"],
			["throws synchronously", "rpcEmitThrows"],
		] as const)("leaves the tool result unchanged when emit %s", async (_label, field) => {
			const spy = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				const opencode = await fusionFake();
				cleanups.push(await registerConfiguredFeatures(opencode.ctx(), { ...DEFAULT_CONFIG, actionFusion: true }));
				opencode[field] = new Error("emit broke");
				const text = resultText(await opencode.callTool("write", fusedWrite, call));
				expect(text).toContain("Created file successfully: a.txt");
				expect(text).toContain("[then_run:succeeded]\nchecked");
				await Promise.resolve();
				expect(spy).toHaveBeenCalledExactlyOnceWith("[sol-opencode] saving event failed: emit broke");
			} finally {
				spy.mockRestore();
			}
		});
	});
});
