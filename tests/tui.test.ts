/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it, vi } from "vitest";
import type { Saving } from "../src/rpc.ts";
import { createDefinition, definition, sidebarLines, tally, TUI_PLUGIN_ID, type SidebarState } from "../src/tui.ts";

type SavingHandler = (event: { data: unknown }) => void;

function tuiContext(status: () => Promise<{ mechanisms: string[] }>, location?: { directory: string }) {
	const handlers = new Map<string, SavingHandler>();
	const unsubscribe = vi.fn();
	const show = vi.fn();
	const client = {
		status,
		events: {
			on: (name: string, handler: SavingHandler) => {
				handlers.set(name, handler);
				return unsubscribe;
			},
		},
	};
	const storage = { memory: (_key: string, { initial }: { initial: object }) => [initial, (mutate: (draft: object) => void) => mutate(initial)] };
	const context = { client: { rpc: () => client }, ui: { toast: { show } }, location, storage };
	return { context: context as never, handlers, unsubscribe, show };
}

describe("TUI companion", () => {
	it("has a stable id", () => {
		expect(definition.id).toBe(TUI_PLUGIN_ID);
	});

	it("announces the active mechanisms at startup", async () => {
		const { context, show } = tuiContext(async () => ({ mechanisms: ["Action Fusion", "Observation Pack"] }));
		await definition.setup(context);
		expect(show).toHaveBeenCalledWith({
			title: "SoL-OpenCode",
			message: "Active: Action Fusion, Observation Pack",
			variant: "info",
			duration: 4000,
		});
	});

	it("says so when no mechanism is enabled", async () => {
		const { context, show } = tuiContext(async () => ({ mechanisms: [] }));
		await definition.setup(context);
		expect(show).toHaveBeenCalledWith(expect.objectContaining({ message: "Loaded with no mechanism enabled", variant: "info" }));
	});

	it("shows a toast per saving and ignores malformed event data", async () => {
		const { context, handlers, show } = tuiContext(async () => ({ mechanisms: [] }));
		await definition.setup(context);
		show.mockClear();
		const onSaving = handlers.get("saving")!;
		onSaving({ data: { sessionID: "ses_1", mechanism: "Action Fusion", saving: "1 model round-trip avoided" } });
		expect(show).toHaveBeenCalledExactlyOnceWith({
			title: "⚡ SoL-OpenCode · Action Fusion",
			message: "Money saved · 1 model round-trip avoided",
			variant: "success",
			duration: 4000,
			sessionID: "ses_1",
		});
		show.mockClear();
		onSaving({ data: { sessionID: "ses_1", mechanism: "Other", saving: "x" } });
		onSaving({ data: null });
		expect(show).not.toHaveBeenCalled();
	});

	it("ignores savings from other projects", async () => {
		const { context, handlers, show } = tuiContext(async () => ({ mechanisms: [] }), { directory: "/proj" });
		await definition.setup(context);
		show.mockClear();
		const data = { sessionID: "ses_1", mechanism: "Action Fusion", saving: "x" };
		const onSaving = handlers.get("saving")!;
		onSaving({ data, location: { directory: "/other" } } as never);
		onSaving({ data } as never);
		expect(show).not.toHaveBeenCalled();
		onSaving({ data, location: { directory: "/proj" } } as never);
		expect(show).toHaveBeenCalledOnce();
	});

	it("unsubscribes on cleanup", async () => {
		const { context, unsubscribe } = tuiContext(async () => ({ mechanisms: [] }));
		const cleanup = await definition.setup(context);
		expect(unsubscribe).not.toHaveBeenCalled();
		await (cleanup as () => void)();
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("warns, without throwing, when the server plugin does not answer", async () => {
		const { context, show } = tuiContext(async () => {
			throw new Error("no such rpc");
		});
		await definition.setup(context);
		expect(show).toHaveBeenCalledWith(
			expect.objectContaining({ variant: "warning", message: expect.stringContaining("no such rpc") }),
		);
	});
});

const saving = (sessionID: string, mechanism: Saving["mechanism"], text: string): Saving => ({ sessionID, mechanism, saving: text });

describe("tally", () => {
	it("counts per session and mechanism and keeps the latest text", () => {
		const state: SidebarState = { mechanisms: [], sessions: {} };
		tally(state, saving("s1", "Action Fusion", "a"));
		tally(state, saving("s1", "Action Fusion", "b"));
		tally(state, saving("s1", "Observation Pack", "c"));
		tally(state, saving("s2", "Action Fusion", "d"));
		expect(state.sessions).toEqual({
			s1: { "Action Fusion": { count: 2, last: "b" }, "Observation Pack": { count: 1, last: "c" } },
			s2: { "Action Fusion": { count: 1, last: "d" } },
		});
	});
});

describe("sidebarLines", () => {
	const state: SidebarState = {
		mechanisms: ["Action Fusion", "Observation Pack"],
		sessions: { s1: { "Action Fusion": { count: 3, last: "1 model round-trip avoided" } } },
	};

	it("lists tallies and bare names", () => {
		expect(sidebarLines(state, "s1")).toEqual(["Action Fusion ×3 · 1 model round-trip avoided", "Observation Pack"]);
	});

	it("lists bare names for an unknown session", () => {
		expect(sidebarLines(state, "other")).toEqual(["Action Fusion", "Observation Pack"]);
	});

	it("is empty without mechanisms", () => {
		expect(sidebarLines({ mechanisms: [], sessions: {} }, "s1")).toEqual([]);
	});
});

describe("createDefinition", () => {
	it("feeds the sidebar state from status and saving events", async () => {
		const { context, handlers } = tuiContext(async () => ({ mechanisms: ["Action Fusion"] }), { directory: "/proj" });
		const sidebar = vi.fn(() => vi.fn());
		await createDefinition(sidebar).setup(context);
		expect(sidebar).toHaveBeenCalledOnce();
		const [calledContext, state] = sidebar.mock.calls[0] as unknown as [unknown, SidebarState];
		expect(calledContext).toBe(context);
		expect(state.mechanisms).toEqual(["Action Fusion"]);
		const onSaving = handlers.get("saving")!;
		const inProject = { location: { directory: "/proj" } };
		onSaving({ data: saving("s1", "Action Fusion", "x"), ...inProject } as never);
		onSaving({ data: null, ...inProject } as never);
		onSaving({ data: { ...saving("s1", "Action Fusion", "x"), mechanism: "Other" }, ...inProject } as never);
		onSaving({ data: saving("s2", "Action Fusion", "y"), location: { directory: "/other" } } as never);
		expect(state.sessions).toEqual({ s1: { "Action Fusion": { count: 1, last: "x" } } });
	});

	it("disposes the sidebar and unsubscribes on cleanup", async () => {
		const { context, unsubscribe } = tuiContext(async () => ({ mechanisms: [] }));
		const dispose = vi.fn();
		const cleanup = await createDefinition(() => dispose).setup(context);
		(cleanup as () => void)();
		expect(dispose).toHaveBeenCalledOnce();
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("leaves mechanisms empty when status rejects", async () => {
		const { context } = tuiContext(async () => {
			throw new Error("no such rpc");
		});
		const sidebar = vi.fn(() => vi.fn());
		await expect(createDefinition(sidebar).setup(context)).resolves.toBeTypeOf("function");
		expect((sidebar.mock.calls[0] as unknown as [unknown, SidebarState])[1].mechanisms).toEqual([]);
	});
});
