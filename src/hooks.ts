/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { setTimeout as sleep } from "node:timers/promises";
import type { Cleanup, SolContext } from "./context.ts";

/** An OpenCode event type the pinned `@opencode/plugin` knows, so a renamed event fails the type check. */
export type EventType = NonNullable<NonNullable<Parameters<SolContext["event"]["subscribe"]>[0]>["types"]>[number];

const FIRST_RETRY_MS = 250;
const LAST_RETRY_MS = 30_000;

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * OpenCode runs hook callbacks without a catch (core/src/plugin/hooks.ts): a
 * rejection fails the tool call in `execute.before` and is a defect in the
 * model request or the tool result everywhere else. A mechanism error must
 * leave both as they were, so every hook is registered through this.
 */
export function failOpen<Event>(label: string, hook: (event: Event) => Promise<void> | void): (event: Event) => Promise<void> {
	return async (event) => {
		try {
			await hook(event);
		} catch (error) {
			console.error(`[sol-opencode] ${label} failed and was skipped: ${message(error)}`);
		}
	};
}

/**
 * Deliver session events of `types` to `handle` until the returned cleanup
 * runs. OpenCode's event stream is volatile: a slow consumer fails it, and
 * events during a disconnection are lost. So only the needed types are
 * requested, and a stream that ends is opened again; `onGap` then lets the
 * caller drop whatever it derived from events it may have missed.
 */
export function subscribeSessionEvents(
	ctx: Pick<SolContext, "event">,
	label: string,
	types: readonly EventType[],
	handle: (type: string, sessionID: string, data: Record<string, unknown>) => Promise<void> | void,
	onGap: () => void = () => {},
): Cleanup {
	const subscription = new AbortController();
	const { signal } = subscription;
	void (async () => {
		for (let retry = FIRST_RETRY_MS; !signal.aborted; retry = Math.min(retry * 2, LAST_RETRY_MS)) {
			try {
				for await (const event of ctx.event.subscribe({ signal, types })) {
					// A stream may still hand over what it had buffered when it was aborted.
					if (signal.aborted) return;
					retry = FIRST_RETRY_MS;
					const { type, data } = (event ?? {}) as { type?: unknown; data?: unknown };
					if (typeof type !== "string" || typeof data !== "object" || data === null) continue;
					const sessionID = (data as { sessionID?: unknown }).sessionID;
					if (typeof sessionID !== "string") continue;
					try {
						await handle(type, sessionID, data as Record<string, unknown>);
					} catch (error) {
						console.error(`[sol-opencode] ${label}: handling ${type} failed: ${message(error)}`);
					}
				}
			} catch (error) {
				if (!signal.aborted) console.error(`[sol-opencode] ${label}: event stream failed, reopening: ${message(error)}`);
			}
			if (signal.aborted) return;
			try {
				onGap();
			} catch (error) {
				console.error(`[sol-opencode] ${label}: recovering from an event gap failed: ${message(error)}`);
			}
			// Rejects only when aborted, which the loop condition then sees.
			await sleep(retry, undefined, { signal, ref: false }).catch(() => {});
		}
	})();
	return () => subscription.abort();
}
