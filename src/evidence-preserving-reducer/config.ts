/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { DEFAULT_REDUCER_MODEL, DEFAULT_REDUCER_PROVIDER } from "../config.ts";

// The on-disk and in-context identifiers keep SoL-Pi's names so receipts stay
// recognizable across both hosts; ObservationPack skips the receipt prefix.
export const REDUCER_EVENT_TYPE = "sol-pi-evidence-preserving-reducer-v1" as const;
export const REDUCER_EVENT_SCHEMA = "sol-pi-evidence-preserving-reducer/1" as const;
export const REDUCER_RECEIPT_SCHEMA = "sol-pi-evidence-receipt/1" as const;
export const REDUCER_RECEIPT_PREFIX = "sol_pi_evidence_receipt_v1" as const;

export const MAX_EVIDENCE_ITEMS = 12;
export const MAX_QUOTE_CHARS = 600;

const DEFAULT_MIN_BYTES = 4_096;
const DEFAULT_MAX_CHARS = 600_000;
const DEFAULT_TIMEOUT_MS = 90_000;

export { DEFAULT_REDUCER_MODEL, DEFAULT_REDUCER_PROVIDER };

export const DIAGNOSTIC_COMMAND =
	/(?:^|[;&|()\s])(?:lake\s+build|lake\s+env\s+lean|lean|coq|cargo(?:\s+(?:build|test|check))?|zig\s+build|pytest|python(?:3)?\s+-m\s+(?:pytest|unittest|py_compile)|ctest|cmake\s+--build|ninja|make|npm\s+test|pnpm\s+test|yarn\s+test|go\s+test|bazel\s+test)(?:\s|$)/i;

export const FAILURE_SIGNAL = /error|failed|failure|fatal|exception|panic|timeout|unsolved|type mismatch|assert/i;
export const LIKELY_SECRET = /(?:api[_-]?key|authorization|bearer|access[_-]?token|secret)[^\n]{0,32}[=:][^\n]+/i;

export interface ReducerConfig {
	readonly maxChars: number;
	readonly minBytes: number;
	readonly reducerModel: string;
	readonly reducerProvider: string;
	readonly runId: string;
	readonly storeRoot: string;
	readonly timeoutMs: number;
}

export interface ReducerConfigOptions {
	readonly reducerModel?: string;
	readonly reducerProvider?: string;
	readonly timeoutMs?: number;
}

export function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordValue(value: unknown, key: string): unknown {
	return isRecord(value) ? value[key] : undefined;
}

export function loadReducerConfig(runtimeDirectory: string, options: ReducerConfigOptions = {}): ReducerConfig {
	return Object.freeze({
		maxChars: DEFAULT_MAX_CHARS,
		minBytes: DEFAULT_MIN_BYTES,
		reducerModel: options.reducerModel ?? DEFAULT_REDUCER_MODEL,
		reducerProvider: options.reducerProvider ?? DEFAULT_REDUCER_PROVIDER,
		runId: sha256(runtimeDirectory).slice(0, 16),
		storeRoot: join(runtimeDirectory, "evidence-preserving-reducer"),
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	});
}
