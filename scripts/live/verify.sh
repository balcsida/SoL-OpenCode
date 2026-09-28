#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
# SPDX-License-Identifier: MIT
#
# Zero-spend live verification of SoL-OpenCode inside a real OpenCode process.
#
# Usage: scripts/live/verify.sh <af-op|all> [work-directory]
#
#   af-op  Action Fusion + ObservationPack only.
#   all    All four mechanisms (the reducer route points at the scripted endpoint).
#
# Creates a scratch project that loads this checkout from .opencode/plugins/,
# starts a scripted OpenAI-compatible endpoint on 127.0.0.1:18765, runs one
# `opencode run --standalone` session with isolated XDG directories, and prints
# what the endpoint received per request next to the persisted history. No
# credential or network provider is used.
set -euo pipefail

MODE="${1:?usage: verify.sh <af-op|all> [work-directory]}"
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
LIVE="$ROOT/scripts/live"
WORK="${2:-$(mktemp -d "${TMPDIR:-/tmp}/sol-opencode-live-XXXXXX")}"
PROJECT="$WORK/project"
PORT=18765

command -v opencode >/dev/null || { echo "opencode is not installed" >&2; exit 1; }
echo "OpenCode $(opencode --version) · work directory $WORK"

rm -rf "$PROJECT" "$WORK/xdg" "$WORK/mock-log" "$WORK/request-log.jsonl"
mkdir -p "$PROJECT/.opencode/plugins"
cat > "$PROJECT/opencode.jsonc" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "providers": {
    "mock": {
      "name": "Scripted mock",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:$PORT/v1", "apiKey": "unused" },
      "models": {
        "scripted": { "name": "Scripted", "limit": { "context": 200000, "output": 8000 } },
        "scripted-reducer": { "name": "Scripted reducer", "limit": { "context": 200000, "output": 4000 } }
      }
    }
  }
}
EOF
printf 'export { default } from "%s/src/index.ts";\n' "$ROOT" > "$PROJECT/.opencode/plugins/10-sol-opencode.ts"
cp "$LIVE/request-log.ts" "$PROJECT/.opencode/plugins/90-request-log.ts"
if [ "$MODE" = "af-op" ]; then
	PROMPT="Write the report and check it."
	printf '{\n  "version": 1,\n  "actionFusion": true,\n  "observationPack": true\n}\n' > "$PROJECT/.opencode/sol-pi.json"
else
	PROMPT="Collect the build output, write the report, and verify it."
	cat > "$PROJECT/.opencode/sol-pi.json" <<'EOF'
{
  "version": 1,
  "actionFusion": true,
  "observationPack": true,
  "evidencePreservingReducer": true,
  "evidencePreservingReducerProvider": "mock",
  "evidencePreservingReducerModel": "scripted-reducer",
  "onlineContextCompact": true,
  "cacheWriteReadRatio": 12.5
}
EOF
	printf 'check:\n\t@for i in $$(seq 1 300); do echo "diagnostic output line $$i of the test run"; done\n\t@echo "ERROR test target failed"\n\t@exit 2\n' > "$PROJECT/Makefile"
fi
git -C "$PROJECT" init -q
git -C "$PROJECT" add -A
git -C "$PROJECT" -c user.email=live@example.invalid -c user.name=live commit -qm init
node "$ROOT/scripts/check-sol-pi-config.mjs" --config "$PROJECT/.opencode/sol-pi.json" > /dev/null

MOCK_PORT=$PORT MOCK_LOG_DIR="$WORK/mock-log" SCRIPT="$MODE" node "$LIVE/mock-provider.mjs" > "$WORK/mock.out" 2>&1 &
MOCK_PID=$!
trap 'kill "$MOCK_PID" 2>/dev/null || true' EXIT
sleep 1

(
	cd "$PROJECT"
	export XDG_DATA_HOME="$WORK/xdg/data" XDG_CONFIG_HOME="$WORK/xdg/config" XDG_STATE_HOME="$WORK/xdg/state" XDG_CACHE_HOME="$WORK/xdg/cache"
	export OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_AUTOUPDATE=1 SOL_REQUEST_LOG="$WORK/request-log.jsonl"
	# `opencode run` reads piped stdin, so give it none.
	timeout 300 opencode run --standalone --auto -m mock/scripted --format json "$PROMPT" < /dev/null > "$WORK/run.out" 2> "$WORK/run.err"
)
echo "opencode run exit status: $?"

node - "$WORK" <<'EOF'
const { readFileSync } = require("node:fs");
const work = process.argv[2];
const lines = (path) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
console.log("\nWhat the provider endpoint received:");
for (const r of lines(`${work}/mock-log/requests.jsonl`)) {
	console.log(
		`#${String(r.request).padStart(2)} ${r.kind.padEnd(9)} bytes=${String(r.bytes).padStart(6)} messages=${String(r.messages).padStart(3)} ` +
			`placeholders=${r.placeholders} receipts=${r.receipts} checkpoints=${r.checkpoints}${r.maxTokens ? ` max_tokens=${r.maxTokens}` : ""}`,
	);
}
console.log("\nContext hook after SoL-OpenCode vs persisted history (tool-result bytes):");
for (const r of lines(`${work}/request-log.jsonl`)) {
	const sum = (items) => items.reduce((total, item) => total + item.bytes, 0);
	console.log(
		`request ${String(r.request).padStart(2)}: outgoing messages=${String(r.outgoingMessages).padStart(2)} tool-result bytes=${String(sum(r.outgoingToolResults)).padStart(6)} | ` +
			`persisted messages=${String(r.persistedMessages).padStart(2)} tool-result bytes=${String(sum(r.persistedToolResults)).padStart(6)}`,
	);
}
EOF
