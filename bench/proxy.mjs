// SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
// SPDX-License-Identifier: MIT
//
// Metering proxy for the SWE-bench sweep. OpenCode in each task container sends
// its Anthropic requests to http://host.docker.internal:PORT/t/<job>/<trial>/v1/…
// The proxy adds the API key (containers never hold it), forwards to
// api.anthropic.com, and logs the provider-reported usage of every request:
// agent steps, reducer calls, and compaction summaries alike, which OpenCode's
// own JSON stream does not all report. Once the spend cap is reached it refuses
// further requests, so a run fails instead of spending more.
//
// It also serves the containers' other traffic as a forward proxy: HTTPS (pip,
// uv, GitHub) by CONNECT and plain HTTP (apt), chained through the host's own
// proxy when the host has one.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { dirname } from "node:path";

const PORT = Number(process.env.PROXY_PORT ?? 18789);
const LOG = process.env.PROXY_LOG ?? new URL("jobs/proxy.jsonl", import.meta.url).pathname;
const CAP_USD = Number(process.env.BUDGET_USD ?? 240);
const KEY_FILE = process.env.ANTHROPIC_KEY_FILE ?? `${process.env.HOME}/.config/sol-opencode-bench/anthropic-api-key`;
const KEY = readFileSync(KEY_FILE, "utf8").trim();

// USD per million tokens, from models.dev on 2026-11-02. A request whose prompt
// exceeds `over.size` tokens is priced at the `over` rates. Unlisted models are
// refused, so nothing unpriced can run.
const PRICES = {
	"claude-sonnet-5-5": { input: 2, output: 10, read: 0.1, write: 2.5 },
	"claude-haiku-5-5": { input: 0.1, output: 0.5, read: 0.01, write: 0.125, over: { size: 100_000, input: 0.5, output: 2.5, read: 0.05, write: 0.625 } },
};

export function costUsd(model, u) {
	const base = PRICES[model];
	const prompt = u.input + u.read + u.write;
	const p = base.over && prompt > base.over.size ? base.over : base;
	// 1-hour cache writes cost 2x input; 5-minute writes are the `write` rate.
	return (u.input * p.input + u.output * p.output + u.read * p.read + (u.write - u.write1h) * p.write + u.write1h * p.input * 2) / 1e6;
}

// Apply one usage object (message_start, message_delta, or a whole response) to the running totals.
export function addUsage(totals, usage) {
	if (!usage) return;
	if (usage.input_tokens != null) totals.input = usage.input_tokens;
	if (usage.cache_read_input_tokens != null) totals.read = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens != null) totals.write = usage.cache_creation_input_tokens;
	if (usage.cache_creation?.ephemeral_1h_input_tokens != null) totals.write1h = usage.cache_creation.ephemeral_1h_input_tokens;
	if (usage.output_tokens != null) totals.output = usage.output_tokens;
}

function text(content) {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.map((part) => part.text ?? "").join("\n") : "";
}

// Request kinds as in scripts/live/mock-provider.mjs, for the Anthropic Messages format.
export function describe(body) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const last = text(messages.at(-1)?.content);
	const serialized = JSON.stringify(body);
	let kind = "auxiliary";
	if (last.includes("<template>") && last.includes("## Objective")) kind = "summary";
	// SoL-OpenCode sends the reducer instructions as the last message, SoL-Pi as the system prompt.
	else if (`${text(body.system).slice(0, 400)}\n${last.slice(0, 400)}`.includes("You are a lossless test/build output reducer.")) kind = "reducer";
	else if (Array.isArray(body.tools) && body.tools.length > 0) kind = "agent";
	const tools = Array.isArray(body.tools) ? body.tools.map((tool) => tool.name) : [];
	return {
		kind,
		model: body.model,
		bytes: Buffer.byteLength(serialized),
		messages: messages.length,
		// Proof the plugin is active in this request: its tools and Action Fusion's then_run parameter.
		solTools: tools.filter((name) => ["update_plan", "obs_recall", "evidence_recall"].includes(name)),
		thenRun: serialized.includes('"then_run"'),
		placeholders: serialized.split("[large tool result replaced after its first").length - 1,
		receipts: serialized.split("sol_pi_evidence_receipt_v1").length - 1,
		checkpoints: serialized.split("<conversation-checkpoint>").length - 1,
	};
}

function spentSoFar() {
	if (!existsSync(LOG)) return 0;
	return readFileSync(LOG, "utf8").split("\n").filter(Boolean).reduce((total, line) => total + (JSON.parse(line).usd ?? 0), 0);
}

function log(entry) {
	appendFileSync(LOG, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

function refuse(res, status, message) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }));
}

const FORWARD_RESPONSE_HEADERS = /^(content-type|request-id|retry-after|x-should-retry|anthropic-ratelimit-.*)$/u;
const DROP_REQUEST_HEADERS = new Set(["host", "connection", "content-length", "accept-encoding", "x-api-key", "authorization"]);

async function handle(req, res, state) {
	if (req.url.startsWith("http://")) return forward(req, res);
	if (req.url === "/health") {
		res.writeHead(200, { "content-type": "application/json" });
		return res.end(JSON.stringify({ spentUsd: state.spent, capUsd: CAP_USD }));
	}
	const route = req.url.match(/^\/t\/([^/]+)\/([^/]+)(\/v1\/.*)$/u);
	if (!route) return refuse(res, 404, "use /t/<job>/<trial>/v1/...");
	const [, job, trial, path] = route;
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	const raw = Buffer.concat(chunks);
	let info = { kind: "other" };
	if (raw.length > 0) {
		try {
			info = describe(JSON.parse(raw.toString("utf8")));
		} catch {
			return refuse(res, 400, "request body is not JSON");
		}
	}
	if (info.model && !PRICES[info.model]) {
		log({ job, trial, ...info, status: 400, refused: "unpriced model", usd: 0 });
		return refuse(res, 400, `model ${info.model} has no price in bench/proxy.mjs`);
	}
	if (state.spent >= CAP_USD) {
		log({ job, trial, ...info, status: 400, refused: "budget", usd: 0 });
		return refuse(res, 400, `SoL bench budget of $${CAP_USD} is spent`);
	}

	const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !DROP_REQUEST_HEADERS.has(name)));
	headers["x-api-key"] = KEY;
	const started = Date.now();
	let upstream;
	try {
		upstream = await fetch(`https://api.anthropic.com${path}`, { method: req.method, headers, body: raw.length > 0 ? raw : undefined });
	} catch (error) {
		log({ job, trial, ...info, status: 502, error: String(error), usd: 0 });
		return refuse(res, 502, "upstream unreachable");
	}
	res.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([name]) => FORWARD_RESPONSE_HEADERS.test(name))));

	// Pass the body through while reading usage from SSE events or a JSON body.
	const totals = { input: 0, read: 0, write: 0, write1h: 0, output: 0 };
	const streaming = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
	const decoder = new TextDecoder();
	let pending = "";
	let errorText = "";
	if (upstream.body) {
		for await (const chunk of upstream.body) {
			if (!res.destroyed) res.write(chunk);
			pending += decoder.decode(chunk, { stream: true });
			if (!streaming) continue;
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.startsWith("data:")) continue;
				try {
					const event = JSON.parse(line.slice(5));
					addUsage(totals, event.type === "message_start" ? event.message?.usage : event.usage);
					if (event.type === "error") errorText = JSON.stringify(event.error);
				} catch {
					// Not JSON (e.g. a keep-alive); nothing to meter.
				}
			}
		}
	}
	res.end();
	if (!streaming && pending) {
		try {
			const body = JSON.parse(pending);
			addUsage(totals, body.usage);
			if (body.type === "error") errorText = JSON.stringify(body.error);
		} catch {
			// Non-JSON body; nothing to meter.
		}
	}
	const usd = info.model ? costUsd(info.model, totals) : 0;
	state.spent += usd;
	log({ job, trial, ...info, status: upstream.status, ms: Date.now() - started, ...totals, usd, ...(errorText ? { error: errorText.slice(0, 500) } : {}) });
}

const HOST_PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const HOST_HTTP_PROXY = process.env.HTTP_PROXY || process.env.http_proxy || HOST_PROXY;
const proxyAuth = (proxy) => `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;

// Forward a plain-HTTP proxy request (`GET http://host/path`, as apt sends it), through the host's proxy when set.
function forward(req, res) {
	const target = new URL(req.url);
	const via = HOST_HTTP_PROXY ? new URL(HOST_HTTP_PROXY) : undefined;
	const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !["connection", "proxy-connection", "proxy-authorization"].includes(name)));
	if (via?.username) headers["proxy-authorization"] = proxyAuth(via);
	const options = via
		? { host: via.hostname, port: Number(via.port) || 80, path: req.url }
		: { host: target.hostname, port: Number(target.port) || 80, path: `${target.pathname}${target.search}` };
	const upstream = httpRequest({ ...options, method: req.method, headers }, (response) => {
		res.writeHead(response.statusCode ?? 502, response.headers);
		response.pipe(res);
	});
	upstream.on("error", () => (res.headersSent ? res.destroy() : refuse(res, 502, "upstream unreachable")));
	req.pipe(upstream);
}

// Open a tunnel for `CONNECT host:port`, through the host's proxy when set (its address is never logged).
function tunnel(req, client, head) {
	client.on("error", () => client.destroy());
	const fail = () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
	const open = (upstream) => {
		upstream.on("error", () => client.destroy());
		client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		if (head.length > 0) upstream.write(head);
		upstream.pipe(client).pipe(upstream);
	};
	const [host, port = "443"] = req.url.split(":");
	if (!HOST_PROXY) {
		const upstream = netConnect(Number(port), host, () => open(upstream)).on("error", fail);
		return;
	}
	const proxy = new URL(HOST_PROXY);
	const headers = { host: req.url };
	if (proxy.username) headers["proxy-authorization"] = proxyAuth(proxy);
	httpRequest({ host: proxy.hostname, port: Number(proxy.port) || 80, method: "CONNECT", path: req.url, headers })
		.on("connect", (res, upstream) => (res.statusCode === 200 ? open(upstream) : (upstream.destroy(), fail())))
		.on("error", fail)
		.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
	mkdirSync(dirname(LOG), { recursive: true });
	const state = { spent: spentSoFar() };
	// Loopback only: the proxy spends the key's money, so it must not be reachable from the network.
	createServer((req, res) => {
		handle(req, res, state).catch((error) => {
			log({ url: req.url, status: 500, error: String(error), usd: 0 });
			if (!res.headersSent) refuse(res, 500, "proxy error");
			else res.end();
		});
	})
		.on("connect", tunnel)
		.listen(PORT, "127.0.0.1", () => console.log(`metering proxy on 127.0.0.1:${PORT}, spent $${state.spent.toFixed(4)} of $${CAP_USD}, log ${LOG}`));
}
