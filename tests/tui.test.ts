/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it, vi } from "vitest";
import { definition, TUI_PLUGIN_ID } from "../src/tui.ts";

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
	const context = { client: { rpc: () => client }, ui: { toast: { show } }, location };
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
