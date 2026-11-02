// SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
// SPDX-License-Identifier: MIT
//
// Zero-spend checks of the proxy's metering: node --test bench/
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.ANTHROPIC_KEY_FILE = new URL(import.meta.url).pathname; // any readable file; no request is made
const { addUsage, costUsd, describe } = await import("./proxy.mjs");

test("prices Sonnet 5.5 input, cache, and output tokens", () => {
	const usd = costUsd("claude-sonnet-5-5", { input: 1_000_000, read: 1_000_000, write: 1_000_000, write1h: 0, output: 1_000_000 });
	assert.equal(usd, 2 + 0.1 + 2.5 + 10);
});

test("prices a Haiku 5.5 request above 100k prompt tokens at the higher tier", () => {
	assert.equal(costUsd("claude-haiku-5-5", { input: 100_000, read: 0, write: 0, write1h: 0, output: 0 }), 0.01);
	assert.equal(costUsd("claude-haiku-5-5", { input: 100_001, read: 0, write: 0, write1h: 0, output: 0 }), (100_001 * 0.5) / 1e6);
});

test("prices 1-hour cache writes at twice the input rate", () => {
	assert.equal(costUsd("claude-sonnet-5-5", { input: 0, read: 0, write: 1_000_000, write1h: 1_000_000, output: 0 }), 4);
});

test("reads prompt usage from message_start and cumulative output from message_delta", () => {
	const totals = { input: 0, read: 0, write: 0, write1h: 0, output: 0 };
	addUsage(totals, { input_tokens: 12, cache_read_input_tokens: 3000, cache_creation_input_tokens: 400, output_tokens: 1 });
	addUsage(totals, { output_tokens: 250 });
	assert.deepEqual(totals, { input: 12, read: 3000, write: 400, write1h: 0, output: 250 });
});

test("classifies agent, reducer, and summary requests", () => {
	const tools = [{ name: "shell" }];
	assert.equal(describe({ model: "m", tools, messages: [{ role: "user", content: "fix the bug" }] }).kind, "agent");
	assert.equal(describe({ model: "m", messages: [{ role: "user", content: "You are a lossless test/build output reducer.\n…" }] }).kind, "reducer");
	const summary = describe({ model: "m", tools, messages: [{ role: "user", content: [{ type: "text", text: "<template>\n## Objective\n" }] }] });
	assert.equal(summary.kind, "summary");
	const packed = describe({ model: "m", tools, messages: [{ role: "user", content: "[large tool result replaced after its first 2 provider requests]" }] });
	assert.equal(packed.placeholders, 1);
	const sol = describe({ model: "m", tools: [{ name: "update_plan" }, { name: "edit", input_schema: { properties: { then_run: {} } } }], messages: [] });
	assert.deepEqual([sol.solTools, sol.thenRun], [["update_plan"], true]);
});
