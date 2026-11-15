// SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
// SPDX-License-Identifier: MIT
//
// Reads what one live run left behind, prints it, and fails unless every
// enabled mechanism did its job. OpenCode exits 0 and prints nothing when a
// plugin fails to load, so these checks are what tells a working package from
// a broken one. They test what happened, never exact byte counts, which move
// with every OpenCode release.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [mode, work] = process.argv.slice(2);
if ((mode !== "af-op" && mode !== "all") || !work) {
	console.error("usage: check.mjs <af-op|all> <work-directory>");
	process.exit(2);
}

const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");
const jsonl = (path) => read(path).split("\n").filter(Boolean).map((line) => JSON.parse(line));
const sum = (items) => items.reduce((total, item) => total + item.bytes, 0);

const requests = jsonl(join(work, "mock-log", "requests.jsonl"));
const history = jsonl(join(work, "request-log.jsonl"));

console.log("\nWhat the provider endpoint received:");
for (const r of requests) {
	console.log(
		`#${String(r.request).padStart(2)} ${r.kind.padEnd(9)} bytes=${String(r.bytes).padStart(6)} messages=${String(r.messages).padStart(3)} ` +
			`placeholders=${r.placeholders} receipts=${r.receipts} checkpoints=${r.checkpoints}${r.maxTokens ? ` max_tokens=${r.maxTokens}` : ""}`,
	);
}
console.log("\nContext hook after SoL-OpenCode vs persisted history (tool-result bytes):");
for (const r of history) {
	console.log(
		`request ${String(r.request).padStart(2)}: outgoing messages=${String(r.outgoingMessages).padStart(2)} tool-result bytes=${String(sum(r.outgoingToolResults)).padStart(6)} | ` +
			`persisted messages=${String(r.persistedMessages).padStart(2)} tool-result bytes=${String(sum(r.persistedToolResults)).padStart(6)}`,
	);
}

const body = (r) => JSON.parse(read(join(work, "mock-log", `request-${String(r.request).padStart(3, "0")}-${r.kind}.json`)) || "{}");
const text = (message) =>
	typeof message.content === "string" ? message.content : (message.content ?? []).map((part) => part.text ?? "").join("\n");
const agents = requests.filter((r) => r.kind === "agent");
const bodies = agents.map(body);
const toolResults = bodies.flatMap((b) => (b.messages ?? []).filter((message) => message.role === "tool").map(text));
const tools = Object.fromEntries((bodies[0]?.tools ?? []).map((tool) => [tool.function?.name, tool.function?.parameters]));

// What the plugin stored for the session.
const dataRoot = join(work, "xdg", "data", "opencode", "sol-opencode");
const stored = existsSync(dataRoot) ? readdirSync(dataRoot, { recursive: true }).map(String) : [];
const storedLines = (name) => stored.filter((path) => path.endsWith(name)).flatMap((path) => jsonl(join(dataRoot, path)));
const ledger = storedLines(join("observation-pack", "ledger.jsonl"));
// The first large result's life in the ledger, in order.
const firstObservation = ledger.filter((entry) => entry.id === ledger[0]?.id).map((entry) => entry.event);
const journal = storedLines(join("evidence-preserving-reducer", "journal.jsonl")).map((entry) => entry.kind);
const count = (values, wanted) => values.filter((value) => value === wanted).length;
const written = (name) => read(join(work, "project", name));
const entryPoints = Object.values(JSON.parse(read(join(work, "package", "package.json")) || "{}").exports ?? {});

/** A packed result leaves at least this much out of the request: ObservationPack's 10 KiB threshold less its excerpt. */
const PACKED_BYTES = 8 * 1024;

const checks = [
	[
		"the package has every entry point its package.json names",
		entryPoints.length > 0 && entryPoints.every((path) => existsSync(join(work, "package", path))),
	],
	["the write tool offers then_run", tools.write?.properties?.then_run !== undefined],
	["a large tool result is sent as a placeholder", agents.some((r) => r.placeholders > 0)],
	[
		"the request carries less than the history keeps",
		history.some((r) => sum(r.persistedToolResults) - sum(r.outgoingToolResults) > PACKED_BYTES),
	],
	[
		"the persisted history never shrinks, except at a compaction",
		history.length > 0 &&
			history.every((r, index) => {
				const previous = history[index - 1];
				return !previous || r.persistedMessages < previous.persistedMessages || sum(r.persistedToolResults) >= sum(previous.persistedToolResults);
			}),
	],
	[
		"the original is archived, and the ledger shows exactly two full sends before the placeholder",
		stored.some((path) => /observation-pack[\\/]objects[\\/]obs_[a-f0-9]{24}\.txt$/u.test(path)) &&
			firstObservation.slice(0, 3).join() === "full,full,placeholder",
	],
	["the session ran to its scripted end", read(join(work, "run.out")).includes("All done.")],
];

if (mode === "af-op") {
	checks.push(
		[
			"the fused write wrote the file, and its command ran in the same call",
			written("report.txt") === "hello from the fused write\n" && toolResults.some((result) => result.includes("[then_run:succeeded]")),
		],
		[
			// The archived result opens with the write confirmation and the marker.
			"obs_recall returns the archived original",
			toolResults.some((result) => result.startsWith("[obs_recall id=obs_") && result.includes("[then_run:succeeded]")),
		],
	);
} else {
	const summaryAt = requests.findIndex((r) => r.kind === "summary");
	// The conversation OpenCode was asked to summarize ends with the plan update that completed a step.
	const completedStep = (body(requests[summaryAt] ?? {}).messages ?? []).some((message) =>
		(message.tool_calls ?? []).some((call) => call.function?.name === "update_plan" && call.function.arguments.includes('"completed"')),
	);
	const before = requests.slice(0, Math.max(summaryAt, 0)).findLast((r) => r.kind === "agent");
	const after = requests.slice(summaryAt + 1).find((r) => r.kind === "agent");
	const reducerAt = requests.findIndex((r) => r.kind === "reducer");
	checks.push(
		["update_plan is offered", tools.update_plan !== undefined],
		[
			"the fused write wrote the file, and its failing command is reported with a verified receipt",
			written("notes.txt") === "build notes\n" &&
				toolResults.some((result) => /\[then_run:failed\]\nsol_pi_evidence_receipt_v1\nstatus=failure\n/u.test(result)),
		],
		[
			"the reducer model is asked once, and its receipt reaches the agent",
			count(requests.map((r) => r.kind), "reducer") === 1 && requests.slice(reducerAt + 1).some((r) => r.kind === "agent" && r.receipts > 0),
		],
		["the reducer journal records the applied receipt", journal.includes("applied")],
		[
			"evidence_recall returns the archived log to its end",
			toolResults.some(
				(result) =>
					result.startsWith("[evidence_recall id=") &&
					result.split("\n", 1)[0].includes("eof=true") &&
					result.includes("diagnostic output line 1 of the test run") &&
					result.includes("ERROR test target failed"),
			),
		],
		[
			"one completed plan step makes OpenCode compact once, and the run continues from the smaller checkpoint",
			count(requests.map((r) => r.kind), "summary") === 1 &&
				completedStep &&
				before !== undefined &&
				after !== undefined &&
				after.checkpoints > 0 &&
				after.bytes < before.bytes &&
				JSON.stringify(body(after)).includes("Online context compaction finished."),
		],
	);
}

console.log(`\nChecks (${mode}):`);
for (const [label, passed] of checks) console.log(`${passed ? "ok  " : "FAIL"} ${label}`);
const failed = checks.filter(([, passed]) => !passed).length;
if (failed > 0) {
	console.error(`\n${failed} of ${checks.length} checks failed. The work directory has the request bodies and logs: ${work}`);
	process.exit(1);
}
