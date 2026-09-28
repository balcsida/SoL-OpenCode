/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openCodeConfigDirectory } from "./paths.ts";

export const DEFAULT_CACHE_WRITE_READ_RATIO = 12.5;
/** OpenCode's `openai` provider covers both API keys and ChatGPT sign-in, like Pi's `openai-codex`. */
export const DEFAULT_REDUCER_PROVIDER = "openai";
export const DEFAULT_REDUCER_MODEL = ["gpt-5.6", "luna"].join("-");

export const CONFIG_FILE_NAME = "sol-pi.json";
export const PROJECT_CONFIG_DIRECTORY = ".opencode";
export const OPTIONS_SOURCE = "plugin options";

export interface SolPiConfig {
	readonly version: 1;
	readonly actionFusion: boolean;
	readonly observationPack: boolean;
	readonly evidencePreservingReducer: boolean;
	readonly evidencePreservingReducerModel: string;
	readonly evidencePreservingReducerProvider: string;
	readonly onlineContextCompact: boolean;
	readonly cacheWriteReadRatio: number;
}

export const DEFAULT_CONFIG: SolPiConfig = Object.freeze({
	version: 1,
	actionFusion: false,
	observationPack: false,
	evidencePreservingReducer: false,
	evidencePreservingReducerModel: DEFAULT_REDUCER_MODEL,
	evidencePreservingReducerProvider: DEFAULT_REDUCER_PROVIDER,
	onlineContextCompact: false,
	cacheWriteReadRatio: DEFAULT_CACHE_WRITE_READ_RATIO,
});

const FEATURE_KEYS = [
	"actionFusion",
	"observationPack",
	"evidencePreservingReducer",
	"onlineContextCompact",
] as const;
const STRING_KEYS = ["evidencePreservingReducerModel", "evidencePreservingReducerProvider"] as const;
const CONFIG_KEYS = new Set<string>(["version", ...FEATURE_KEYS, ...STRING_KEYS, "cacheWriteReadRatio"]);

export interface LoadedConfig {
	readonly config: SolPiConfig;
	/** The file path, {@link OPTIONS_SOURCE}, or `undefined` for built-in defaults. */
	readonly source: string | undefined;
}

export interface ConfigSources {
	readonly projectDirectory: string;
	readonly configDirectory?: string;
	readonly options?: Readonly<Record<string, unknown>>;
}

/** Project `.opencode/sol-pi.json` first, then the OpenCode global config directory. */
export function findConfigPath(
	projectDirectory: string,
	configDirectory = openCodeConfigDirectory(),
): string | undefined {
	const projectPath = join(projectDirectory, PROJECT_CONFIG_DIRECTORY, CONFIG_FILE_NAME);
	if (existsSync(projectPath)) return projectPath;

	const globalPath = join(configDirectory, CONFIG_FILE_NAME);
	return existsSync(globalPath) ? globalPath : undefined;
}

/**
 * Resolve the one effective configuration. Non-empty plugin options replace
 * the files entirely; otherwise the project file replaces the global file.
 * Sources are never merged.
 */
export function loadSolPiConfig(sources: ConfigSources): LoadedConfig {
	const options = sources.options ?? {};
	if (Object.keys(options).length > 0) {
		return { config: parseSolPiConfig(options, OPTIONS_SOURCE), source: OPTIONS_SOURCE };
	}

	const path = findConfigPath(sources.projectDirectory, sources.configDirectory);
	if (!path) return { config: DEFAULT_CONFIG, source: undefined };

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to read SoL-Pi config ${path}: ${reason}`);
	}
	return { config: parseSolPiConfig(parsed, path), source: path };
}

export function parseSolPiConfig(parsed: unknown, source: string): SolPiConfig {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`SoL-Pi config must be a JSON object: ${source}`);
	}

	const record = parsed as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!CONFIG_KEYS.has(key)) throw new Error(`Unknown SoL-Pi config key: ${key}`);
	}
	if (record.version !== 1) throw new Error(`SoL-Pi config version must be 1: ${source}`);

	for (const key of FEATURE_KEYS) {
		if (record[key] !== undefined && typeof record[key] !== "boolean") {
			throw new Error(`SoL-Pi config ${key} must be boolean: ${source}`);
		}
	}
	const cacheWriteReadRatio = Object.hasOwn(record, "cacheWriteReadRatio")
		? record.cacheWriteReadRatio
		: DEFAULT_CACHE_WRITE_READ_RATIO;
	if (
		typeof cacheWriteReadRatio !== "number" ||
		!Number.isFinite(cacheWriteReadRatio) ||
		cacheWriteReadRatio < 0
	) {
		throw new Error(`SoL-Pi config cacheWriteReadRatio must be a finite non-negative number: ${source}`);
	}
	const evidencePreservingReducerModel = stringConfigValue(
		record,
		"evidencePreservingReducerModel",
		DEFAULT_REDUCER_MODEL,
		source,
	);
	const evidencePreservingReducerProvider = stringConfigValue(
		record,
		"evidencePreservingReducerProvider",
		DEFAULT_REDUCER_PROVIDER,
		source,
	);

	return Object.freeze({
		...DEFAULT_CONFIG,
		...record,
		cacheWriteReadRatio,
		evidencePreservingReducerModel,
		evidencePreservingReducerProvider,
	}) as SolPiConfig;
}

function stringConfigValue(
	record: Record<string, unknown>,
	key: (typeof STRING_KEYS)[number],
	defaultValue: string,
	source: string,
): string {
	const value = Object.hasOwn(record, key) ? record[key] : defaultValue;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`SoL-Pi config ${key} must be a non-empty string: ${source}`);
	}
	return value.trim();
}
