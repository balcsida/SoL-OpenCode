/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_CONFIG,
	DEFAULT_REDUCER_MODEL,
	DEFAULT_REDUCER_PROVIDER,
	findConfigPath,
	loadSolPiConfig,
	OPTIONS_SOURCE,
	PROJECT_CONFIG_DIRECTORY,
} from "../src/config.ts";

const roots: string[] = [];

function fixture(): { configDirectory: string; projectDirectory: string } {
	const root = mkdtempSync(join(tmpdir(), "sol-opencode-config-"));
	roots.push(root);
	const projectDirectory = join(root, "project");
	const configDirectory = join(root, "config");
	mkdirSync(projectDirectory, { recursive: true });
	mkdirSync(configDirectory, { recursive: true });
	return { configDirectory, projectDirectory };
}

function writeProjectConfig(projectDirectory: string, value: unknown): string {
	mkdirSync(join(projectDirectory, PROJECT_CONFIG_DIRECTORY), { recursive: true });
	const path = join(projectDirectory, PROJECT_CONFIG_DIRECTORY, "sol-pi.json");
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
	return path;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("SoL-Pi config", () => {
	it("returns disabled defaults when no source exists", () => {
		const sources = fixture();
		expect(findConfigPath(sources.projectDirectory, sources.configDirectory)).toBeUndefined();
		expect(loadSolPiConfig(sources)).toEqual({ config: DEFAULT_CONFIG, source: undefined });
		expect(DEFAULT_CONFIG.cacheWriteReadRatio).toBe(12.5);
		expect(DEFAULT_CONFIG.evidencePreservingReducerProvider).toBe(DEFAULT_REDUCER_PROVIDER);
		expect(DEFAULT_CONFIG.evidencePreservingReducerModel).toBe(DEFAULT_REDUCER_MODEL);
		expect(`${DEFAULT_REDUCER_PROVIDER}/${DEFAULT_REDUCER_MODEL}`).toBe("openai/gpt-5.6-luna");
	});

	it("loads the global config as a fallback", () => {
		const sources = fixture();
		const path = join(sources.configDirectory, "sol-pi.json");
		writeFileSync(path, JSON.stringify({ version: 1, observationPack: true, onlineContextCompact: true }));
		expect(findConfigPath(sources.projectDirectory, sources.configDirectory)).toBe(path);
		expect(loadSolPiConfig(sources)).toEqual({
			config: { ...DEFAULT_CONFIG, observationPack: true, onlineContextCompact: true },
			source: path,
		});
	});

	it("uses the project config instead of merging the global config", () => {
		const sources = fixture();
		writeFileSync(join(sources.configDirectory, "sol-pi.json"), JSON.stringify({ version: 1, observationPack: true }));
		const projectPath = writeProjectConfig(sources.projectDirectory, { version: 1, actionFusion: true });

		expect(findConfigPath(sources.projectDirectory, sources.configDirectory)).toBe(projectPath);
		expect(loadSolPiConfig(sources).config).toEqual({ ...DEFAULT_CONFIG, actionFusion: true });
	});

	it("loads the project config without a trust gate, as OpenCode loads project plugins", () => {
		const sources = fixture();
		writeProjectConfig(sources.projectDirectory, { version: 1, actionFusion: true });
		expect(loadSolPiConfig(sources).config.actionFusion).toBe(true);
	});

	it("uses non-empty plugin options instead of any config file", () => {
		const sources = fixture();
		writeProjectConfig(sources.projectDirectory, { version: 1, actionFusion: true });
		const loaded = loadSolPiConfig({ ...sources, options: { version: 1, observationPack: true } });
		expect(loaded).toEqual({ config: { ...DEFAULT_CONFIG, observationPack: true }, source: OPTIONS_SOURCE });
	});

	it("falls back to files when plugin options are empty", () => {
		const sources = fixture();
		const path = writeProjectConfig(sources.projectDirectory, { version: 1, actionFusion: true });
		expect(loadSolPiConfig({ ...sources, options: {} }).source).toBe(path);
	});

	it("validates plugin options with the file schema", () => {
		const sources = fixture();
		expect(() => loadSolPiConfig({ ...sources, options: { observationPack: true } })).toThrow(
			`SoL-Pi config version must be 1: ${OPTIONS_SOURCE}`,
		);
		expect(() => loadSolPiConfig({ ...sources, options: { version: 1, strict: true } })).toThrow(
			"Unknown SoL-Pi config key: strict",
		);
	});

	it("rejects unknown keys", () => {
		const sources = fixture();
		writeProjectConfig(sources.projectDirectory, { version: 1, actionFussion: true });
		expect(() => loadSolPiConfig(sources)).toThrow("Unknown SoL-Pi config key: actionFussion");
	});

	it("rejects non-boolean feature values", () => {
		const sources = fixture();
		writeProjectConfig(sources.projectDirectory, { version: 1, actionFusion: "yes" });
		expect(() => loadSolPiConfig(sources)).toThrow("SoL-Pi config actionFusion must be boolean");
	});

	it("rejects a non-boolean Online Context Compact value", () => {
		const sources = fixture();
		writeProjectConfig(sources.projectDirectory, { version: 1, onlineContextCompact: "yes" });
		expect(() => loadSolPiConfig(sources)).toThrow("SoL-Pi config onlineContextCompact must be boolean");
	});

	it("loads an explicit cache write/read ratio, including zero", () => {
		for (const cacheWriteReadRatio of [0, 3.25]) {
			const sources = fixture();
			writeFileSync(join(sources.configDirectory, "sol-pi.json"), JSON.stringify({ version: 1, cacheWriteReadRatio }));
			expect(loadSolPiConfig(sources).config.cacheWriteReadRatio).toBe(cacheWriteReadRatio);
		}
	});

	it("loads an explicit Evidence-Preserving Reducer provider/model route", () => {
		const sources = fixture();
		writeFileSync(
			join(sources.configDirectory, "sol-pi.json"),
			JSON.stringify({
				version: 1,
				evidencePreservingReducerProvider: "test-provider",
				evidencePreservingReducerModel: "test-reducer-model",
			}),
		);
		expect(loadSolPiConfig(sources).config).toEqual({
			...DEFAULT_CONFIG,
			evidencePreservingReducerProvider: "test-provider",
			evidencePreservingReducerModel: "test-reducer-model",
		});
	});

	it("normalizes surrounding whitespace in the EPR reducer route", () => {
		const sources = fixture();
		writeFileSync(
			join(sources.configDirectory, "sol-pi.json"),
			JSON.stringify({
				version: 1,
				evidencePreservingReducerProvider: "  test-provider\t",
				evidencePreservingReducerModel: "\n test-reducer-model  ",
			}),
		);
		expect(loadSolPiConfig(sources).config).toMatchObject({
			evidencePreservingReducerProvider: "test-provider",
			evidencePreservingReducerModel: "test-reducer-model",
		});
	});

	it.each([
		["evidencePreservingReducerProvider", ""],
		["evidencePreservingReducerProvider", 12],
		["evidencePreservingReducerModel", ""],
		["evidencePreservingReducerModel", 12],
	] as const)("rejects an invalid EPR reducer string: %s=%j", (key, value) => {
		const sources = fixture();
		writeFileSync(join(sources.configDirectory, "sol-pi.json"), JSON.stringify({ version: 1, [key]: value }));
		expect(() => loadSolPiConfig(sources)).toThrow(`SoL-Pi config ${key} must be a non-empty string`);
	});

	it.each([null, "12.5", -1])("rejects an invalid cache write/read ratio: %j", (cacheWriteReadRatio) => {
		const sources = fixture();
		writeFileSync(join(sources.configDirectory, "sol-pi.json"), JSON.stringify({ version: 1, cacheWriteReadRatio }));
		expect(() => loadSolPiConfig(sources)).toThrow(
			"SoL-Pi config cacheWriteReadRatio must be a finite non-negative number",
		);
	});

	it("wraps malformed JSON errors with the config path", () => {
		const sources = fixture();
		const path = writeProjectConfig(sources.projectDirectory, "{");
		expect(() => loadSolPiConfig(sources)).toThrow(`Unable to read SoL-Pi config ${path}`);
	});
});
