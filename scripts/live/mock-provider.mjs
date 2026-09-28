// SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
// SPDX-License-Identifier: MIT
//
// A scripted OpenAI-compatible Chat Completions endpoint for zero-spend live
// verification of the SoL-OpenCode plugin inside a real OpenCode 2.0.18 process.
// Every request body the "provider" receives is logged, so the log shows
// exactly what OpenCode sent after the plugin's hooks ran.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const PORT = Number(process.env.MOCK_PORT ?? 18_765);
const LOG_DIR = process.env.MOCK_LOG_DIR ?? "./mock-log";
const SCRIPT = process.env.SCRIPT ?? "af-op";
mkdirSync(LOG_DIR, { recursive: true });

const call = (name, args) => ({ type: "tool", name, args });
const text = (value) => ({ type: "text", value });
// Build a tool call from the request the model just received.
const dynamic = (build) => ({ type: "dynamic", build });
const recallObservation = dynamic((serialized) => call("obs_recall", { id: serialized.match(/obs_[a-f0-9]{24}/u)?.[0] ?? "missing", offset: 0 }));
const recallEvidence = dynamic((serialized) => call("evidence_recall", { source_sha256: serialized.match(/source_sha256=([a-f0-9]{64})/u)?.[1] ?? "missing", offset: 0 }));

const SCRIPTS = {
	// Step 2: Action Fusion + ObservationPack.
	"af-op": [
		call("write", {
			path: "report.txt",
			content: "hello from the fused write\n",
			then_run: { command: "cat report.txt && seq 1 4000" },
		}),
		call("shell", { command: "echo second-step" }),
		call("shell", { command: "echo third-step" }),
		recallObservation,
		text("All done."),
	],
	// Step 3: all four mechanisms.
	all: [
		call("update_plan", {
			steps: [
				{ id: "collect", goal: "collect build output", status: "in_progress" },
				{ id: "report", goal: "write the report", status: "pending" },
				{ id: "verify", goal: "verify the report", status: "pending" },
			],
		}),
		call("write", { path: "notes.txt", content: "build notes\n", then_run: { command: "make check" } }),
		recallEvidence,
		call("shell", { command: "seq 100001 105000" }),
		...Array.from({ length: 16 }, (_, index) => call("shell", { command: `echo chunk-${index}; seq 1 1500` })),
		call("update_plan", {
			steps: [
				{ id: "collect", goal: "collect build output", status: "completed" },
				{ id: "report", goal: "write the report", status: "in_progress" },
				{ id: "verify", goal: "verify the report", status: "pending" },
			],
			progress: { files_changed: ["notes.txt"], verification: ["make check fails as expected"], decisions: [] },
		}),
		call("update_plan", {
			steps: [
				{ id: "report", goal: "write the report", status: "in_progress" },
				{ id: "verify", goal: "verify the report", status: "pending" },
			],
		}),
		text("All done."),
	],
};

let agentStep = 0;
let requestNumber = 0;

function messageText(message) {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.map((part) => (typeof part.text === "string" ? part.text : "")).join("\n");
}

function classify(body) {
	const messages = body.messages ?? [];
	const last = messages.at(-1);
	const lastText = last ? messageText(last) : "";
	if (lastText.includes("<sol-opencode-compaction nonce=")) return "summary";
	if (lastText.startsWith("You are a lossless test/build output reducer.")) return "reducer";
	if (Array.isArray(body.tools) && body.tools.length > 0) return "agent";
	return "auxiliary";
}

function reducerReceipt(prompt) {
	const hash = prompt.match(/source_sha256=([a-f0-9]{64})/u)?.[1];
	const isError = prompt.includes("is_error=true");
	const log = prompt.slice(prompt.indexOf("<untrusted_log>\n") + "<untrusted_log>\n".length);
	const quote = log.split("\n").find((line) => /ERROR/u.test(line)) ?? log.split("\n")[0];
	return JSON.stringify({
		schema: "sol-pi-evidence-receipt/1",
		source_sha256: hash,
		status: isError ? "failure" : "success",
		uncertain: false,
		evidence: [{ kind: isError ? "failure" : "summary", quote }],
	});
}

function summarize(body, kind) {
	const messages = body.messages ?? [];
	const toolMessages = messages.filter((message) => message.role === "tool");
	const serialized = JSON.stringify(body);
	return {
		request: requestNumber,
		kind,
		bytes: Buffer.byteLength(serialized),
		messages: messages.length,
		toolResults: toolMessages.length,
		toolResultBytes: toolMessages.map((message) => Buffer.byteLength(messageText(message))),
		placeholders: (serialized.match(/\[large tool result replaced/gu) ?? []).length,
		receipts: (serialized.match(/sol_pi_evidence_receipt_v1/gu) ?? []).length,
		checkpoints: (serialized.match(/<sol-opencode-checkpoint>/gu) ?? []).length,
		thenRunInSchema: serialized.includes('"then_run"'),
		maxTokens: body.max_tokens ?? body.max_completion_tokens,
	};
}

function sse(res, chunks) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
}

function respond(res, body, action) {
	const base = { id: `chatcmpl-${requestNumber}`, object: "chat.completion.chunk", created: 0, model: body.model };
	const promptTokens = Math.ceil(Buffer.byteLength(JSON.stringify(body.messages ?? [])) / 4);
	const usage = { prompt_tokens: promptTokens, completion_tokens: 20, total_tokens: promptTokens + 20 };
	if (action.type === "tool") {
		const id = `call_${requestNumber}`;
		return sse(res, [
			{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id, type: "function", function: { name: action.name, arguments: JSON.stringify(action.args) } }] }, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
		]);
	}
	return sse(res, [
		{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: action.value }, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
	]);
}

createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => {
		raw += chunk;
	});
	req.on("end", () => {
		if (req.method === "GET") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ id: "scripted", object: "model" }] }));
			return;
		}
		requestNumber += 1;
		let body;
		try {
			body = JSON.parse(raw);
		} catch {
			res.writeHead(400).end();
			return;
		}
		const kind = classify(body);
		writeFileSync(join(LOG_DIR, `request-${String(requestNumber).padStart(3, "0")}-${kind}.json`), JSON.stringify(body, null, 2));
		appendFileSync(join(LOG_DIR, "requests.jsonl"), `${JSON.stringify(summarize(body, kind))}\n`);

		if (kind === "summary") return respond(res, body, text("SUMMARY: collected build output with make check (fails with ERROR test target failed); wrote notes.txt; next: write the report, then verify it."));
		if (kind === "reducer") return respond(res, body, text(reducerReceipt(messageText(body.messages.at(-1)))));
		if (kind === "auxiliary") return respond(res, body, text("Scripted session"));
		const script = SCRIPTS[SCRIPT];
		let action = script[Math.min(agentStep, script.length - 1)];
		agentStep += 1;
		if (action.type === "dynamic") action = action.build(JSON.stringify(body));
		return respond(res, body, action);
	});
}).listen(PORT, "127.0.0.1", () => console.log(`mock provider on ${PORT} (${SCRIPT})`));
