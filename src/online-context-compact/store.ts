/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

/**
 * Per-session Online Context Compact state in `ctx.storage`.
 *
 * SoL-Pi appended versioned custom entries to Pi's session log. OpenCode has no
 * plugin-writable, session-scoped, non-context log, so the latest snapshot and
 * the active checkpoint live under one plugin storage key per session. They
 * never enter the model context; the checkpoint summary does, through the
 * request projection.
 */

import type { SolContext } from "../context.ts";
import { initialOnlineState, ONLINE_STATE_ENTRY, type OnlineState, parseOnlineState } from "./state.ts";

export const STORAGE_PREFIX = "occ/";

export interface Checkpoint {
	/** Session message id of the first message kept verbatim after the summary. */
	readonly keptMessageID: string;
	readonly summary: string;
	readonly archivedMessages: number;
	readonly createdAt: number;
}

export interface StoredSession {
	readonly state: OnlineState;
	readonly checkpoint: Checkpoint | undefined;
	readonly lastDecision: Record<string, unknown> | undefined;
}

export function storageKey(sessionID: string): string {
	return `${STORAGE_PREFIX}${sessionID}`;
}

function parseCheckpoint(value: unknown): Checkpoint | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		typeof record.keptMessageID !== "string" ||
		record.keptMessageID.length === 0 ||
		typeof record.summary !== "string" ||
		record.summary.length === 0 ||
		typeof record.archivedMessages !== "number" ||
		typeof record.createdAt !== "number"
	) {
		return undefined;
	}
	return {
		keptMessageID: record.keptMessageID,
		summary: record.summary,
		archivedMessages: record.archivedMessages,
		createdAt: record.createdAt,
	};
}

export async function loadSession(storage: SolContext["storage"], sessionID: string): Promise<StoredSession> {
	const stored = await storage.get(storageKey(sessionID));
	const record = typeof stored === "object" && stored !== null && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
	if (record.schema !== ONLINE_STATE_ENTRY) return { state: initialOnlineState(), checkpoint: undefined, lastDecision: undefined };
	const lastDecision = record.lastDecision;
	return {
		state: parseOnlineState(record.state) ?? initialOnlineState(),
		checkpoint: parseCheckpoint(record.checkpoint),
		lastDecision:
			typeof lastDecision === "object" && lastDecision !== null && !Array.isArray(lastDecision)
				? (lastDecision as Record<string, unknown>)
				: undefined,
	};
}

export async function saveSession(storage: SolContext["storage"], sessionID: string, session: StoredSession): Promise<void> {
	const value = JSON.parse(
		JSON.stringify({
			schema: ONLINE_STATE_ENTRY,
			state: session.state,
			...(session.checkpoint ? { checkpoint: session.checkpoint } : {}),
			...(session.lastDecision ? { lastDecision: session.lastDecision } : {}),
		}),
	);
	await storage.set(storageKey(sessionID), value);
}
