/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */
import { join } from "node:path";
import { createLedger } from "../ledger.ts";
import { REDUCER_EVENT_SCHEMA, REDUCER_EVENT_TYPE, type ReducerConfig } from "./config.ts";

/**
 * Record one entry per decision the reducer made.
 *
 * SoL-Pi appended these as non-context Pi session entries. OpenCode offers
 * plugins no session-scoped, non-context log, so they go to a JSONL journal
 * beside the archive. They never enter the model context.
 */
export type Journal = (kind: string, data?: object) => Promise<void>;

export function journalPath(config: ReducerConfig): string {
	return join(config.storeRoot, "journal.jsonl");
}

export function createJournal(config: ReducerConfig): Journal {
	const ledger = createLedger(journalPath(config));
	return async (kind, data = {}) => {
		try {
			await ledger({ type: REDUCER_EVENT_TYPE, schema: REDUCER_EVENT_SCHEMA, runId: config.runId, kind, ...data });
		} catch (error) {
			console.error(`[evidence-preserving-reducer] journal write failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
}
