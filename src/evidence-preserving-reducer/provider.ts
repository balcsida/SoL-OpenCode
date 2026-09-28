/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import type { SolContext } from "../context.ts";
import type { ArchiveObject } from "./archive.ts";
import type { ReducerConfig } from "./config.ts";
import { reducerPrompt } from "./receipt.ts";

export interface NormalizedUsage {
	readonly totalTokens: number;
}

export interface ProviderResult {
	readonly errorMessage: string | undefined;
	readonly model: string;
	readonly ok: boolean;
	readonly outputText: string;
	readonly provider: string;
	/** `ctx.generate.text` reports neither a stop reason nor token usage. */
	readonly stopReason: "unknown";
	readonly usage: NormalizedUsage | undefined;
}

export class ReducerModelUnavailableError extends Error {
	override readonly name = "ReducerModelUnavailableError";
}

export class ReducerTimeoutError extends Error {
	override readonly name = "AbortError";
}

function isModelSelectionError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const tag = (error as { _tag?: unknown })._tag;
	const name = (error as { name?: unknown }).name;
	return tag === "Generate.ModelSelectionError" || name === "Generate.ModelSelectionError";
}

/**
 * `ctx.generate.text` offers no cancellation (the plugin adapter drops request
 * options), so a timeout abandons the wait and the original result goes back
 * to the agent; the provider call itself runs to completion.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new ReducerTimeoutError("Reducer model call timed out")), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Use the configured reducer route through OpenCode's model runtime and credentials. */
export async function callReducer(
	config: ReducerConfig,
	command: string,
	isError: boolean,
	archive: ArchiveObject,
	body: string,
	generate: SolContext["generate"],
): Promise<ProviderResult> {
	let response: { text: string };
	try {
		response = await withTimeout(
			generate.text({
				prompt: reducerPrompt(command, isError, archive, body),
				model: { providerID: config.reducerProvider, id: config.reducerModel },
			}),
			config.timeoutMs,
		);
	} catch (error) {
		if (isModelSelectionError(error)) {
			throw new ReducerModelUnavailableError(
				`Reducer model is unavailable: ${config.reducerProvider}/${config.reducerModel}`,
			);
		}
		throw error;
	}
	return {
		errorMessage: undefined,
		model: config.reducerModel,
		ok: true,
		outputText: response.text,
		provider: config.reducerProvider,
		stopReason: "unknown",
		usage: undefined,
	};
}
