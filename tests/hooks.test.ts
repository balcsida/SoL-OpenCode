/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { failOpen, subscribeSessionEvents } from "../src/hooks.ts";
import { FakeOpenCode } from "./fake-opencode.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("failOpen", () => {
	it("turns a throwing or rejecting hook into a logged no-op", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const thrown = failOpen("sync hook", () => {
			throw new Error("sync boom");
		});
		const rejected = failOpen("async hook", async () => {
			throw new Error("async boom");
		});
		await expect(thrown({})).resolves.toBeUndefined();
		await expect(rejected({})).resolves.toBeUndefined();
		expect(logged.mock.calls.map(([line]) => line)).toEqual([
			"[sol-opencode] sync hook failed and was skipped: sync boom",
			"[sol-opencode] async hook failed and was skipped: async boom",
		]);
	});

	it("runs a healthy hook on the same event", async () => {
		const event = { seen: false };
		await failOpen<typeof event>("hook", (input) => {
			input.seen = true;
		})(event);
		expect(event.seen).toBe(true);
	});
});

/** A context whose event stream is scripted per attempt, for what the fake's stream cannot do. */
function scripted(attempts: (attempt: number) => AsyncIterable<unknown>) {
	const requested: unknown[] = [];
	const ctx = {
		event: {
			subscribe: (options: { types?: unknown }) => {
				requested.push(options.types);
				return attempts(requested.length);
			},
		},
	} as unknown as Parameters<typeof subscribeSessionEvents>[0];
	return { ctx, requested };
}

const idle = (sessionID: unknown) => ({ type: "session.idle", data: { sessionID } });

describe("subscribeSessionEvents", () => {
	it("delivers the session events it asked for and survives a failing handler", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const fake = new FakeOpenCode("/unused");
		const seen: string[] = [];
		const stop = subscribeSessionEvents(fake.ctx(), "test", ["session.idle"], (type, sessionID) => {
			if (sessionID === "ses_bad") throw new Error("handler boom");
			seen.push(`${type}:${sessionID}`);
		});
		fake.emit({ type: "session.deleted", data: { sessionID: "ses_other_type" } });
		fake.emit(idle("ses_bad"));
		fake.emit(idle("ses_ok"));
		await fake.settle();
		expect(seen).toEqual(["session.idle:ses_ok"]);
		await stop();
		expect(fake.subscriptions.size).toBe(0);
	});

	it("reopens a failed stream, reports the gap, and skips what is not a session event", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { ctx, requested } = scripted(async function* (attempt) {
			if (attempt === 1) throw new Error("slow consumer");
			yield null;
			yield { type: 1, data: {} };
			yield { type: "session.idle", data: null };
			yield idle(7);
			yield idle("ses_after_gap");
			await new Promise(() => {});
		});
		const seen: string[] = [];
		let gaps = 0;
		const stop = subscribeSessionEvents(
			ctx,
			"test",
			["session.idle", "session.deleted"],
			(_type, sessionID) => void seen.push(sessionID),
			() => {
				gaps += 1;
			},
		);
		await vi.waitFor(() => expect(seen).toEqual(["ses_after_gap"]), { timeout: 2000 });
		expect(gaps).toBe(1);
		expect(requested).toEqual([
			["session.idle", "session.deleted"],
			["session.idle", "session.deleted"],
		]);
		await stop();
	});

	it("does not reopen the stream, or deliver what it had buffered, once cleaned up", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const failing = scripted(async function* () {
			throw new Error("slow consumer");
		});
		const stopFailing = subscribeSessionEvents(failing.ctx, "test", ["session.idle"], () => {});
		await vi.waitFor(() => expect(failing.requested).toHaveLength(1));
		// Cleaned up while it waits to reopen: the wait ends and nothing is opened again.
		await stopFailing();
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(failing.requested).toHaveLength(1);

		const buffered = scripted(async function* () {
			yield idle("ses_first");
			yield idle("ses_buffered");
		});
		const seen: string[] = [];
		const stop = subscribeSessionEvents(buffered.ctx, "test", ["session.idle"], (_type, sessionID) => {
			seen.push(sessionID);
			void stop();
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(seen).toEqual(["ses_first"]);
		expect(buffered.requested).toHaveLength(1);
	});
});
