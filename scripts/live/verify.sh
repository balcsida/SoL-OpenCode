#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
# SPDX-License-Identifier: MIT
#
# Zero-spend live check of the packed SoL-OpenCode plugin inside a real OpenCode process.
#
# Usage: scripts/live/verify.sh <af-op|all> [work-directory]
#
#   af-op  Action Fusion + ObservationPack only.
#   all    All four mechanisms (the reducer route points at the scripted endpoint).
#
# Packs this checkout as `npm publish` would, or takes the tarball named by
# SOL_TARBALL, and creates a scratch project that loads the extracted package
# through a `plugins` entry, the way a user installs it. It starts a scripted
# OpenAI-compatible endpoint on 127.0.0.1:18765 and runs one
# `opencode run --standalone` session with isolated XDG directories. It prints
# what the endpoint received per request next to the persisted history, and
# fails unless every enabled mechanism did its job (scripts/live/check.mjs).
# No credential or network provider is used.
#
# OpenCode exits 0 and prints nothing when a plugin fails to load, so only
# those checks tell a working package from a broken one.
set -euo pipefail

MODE="${1:?usage: verify.sh <af-op|all> [work-directory]}"
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
LIVE="$ROOT/scripts/live"
WORK="${2:-$(mktemp -d "${TMPDIR:-/tmp}/sol-opencode-live-XXXXXX")}"
PORT=18765

command -v opencode >/dev/null || { echo "opencode is not installed" >&2; exit 1; }
echo "OpenCode $(opencode --version) · work directory $WORK"

mkdir -p "$WORK"
# The package path goes into OpenCode's config, which is read from another directory.
WORK=$(cd "$WORK" && pwd)
PROJECT="$WORK/project"
rm -rf "$PROJECT" "$WORK/xdg" "$WORK/mock-log" "$WORK/request-log.jsonl" "$WORK/package" "$WORK/request-log"
mkdir -p "$PROJECT/.opencode" "$WORK/request-log"
TARBALL="${SOL_TARBALL:-$WORK/$(cd "$ROOT" && npm pack --silent --pack-destination "$WORK")}"
tar -xzf "$TARBALL" -C "$WORK"
PACKAGE="$WORK/package"
# Hooks run in the order the plugins load, so the diagnostic plugin comes second.
cp "$LIVE/request-log.ts" "$WORK/request-log/index.ts"
cat > "$PROJECT/opencode.jsonc" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "$PACKAGE" }, { "package": "$WORK/request-log" }],
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
node "$PACKAGE/scripts/check-sol-pi-config.mjs" --config "$PROJECT/.opencode/sol-pi.json" > /dev/null

MOCK_PORT=$PORT MOCK_LOG_DIR="$WORK/mock-log" SCRIPT="$MODE" node "$LIVE/mock-provider.mjs" > "$WORK/mock.out" 2>&1 &
MOCK_PID=$!
# Waiting for it lets the next run have the port.
trap 'kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null || true' EXIT
# Ready when it answers as itself: something else may already hold the port.
for _ in $(seq 1 100); do
	curl -fsS --max-time 1 "http://127.0.0.1:$PORT/v1/models" 2>/dev/null | grep -q '"scripted"' && break
	kill -0 "$MOCK_PID" 2>/dev/null || break
	sleep 0.1
done
if ! kill -0 "$MOCK_PID" 2>/dev/null; then
	echo "the scripted endpoint did not start:" >&2
	cat "$WORK/mock.out" >&2
	exit 1
fi

STATUS=0
(
	cd "$PROJECT"
	export XDG_DATA_HOME="$WORK/xdg/data" XDG_CONFIG_HOME="$WORK/xdg/config" XDG_STATE_HOME="$WORK/xdg/state" XDG_CACHE_HOME="$WORK/xdg/cache"
	export OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_AUTOUPDATE=1 SOL_REQUEST_LOG="$WORK/request-log.jsonl"
	# `opencode run` reads piped stdin, so give it none.
	timeout 300 opencode run --standalone --auto -m mock/scripted --format json "$PROMPT" < /dev/null > "$WORK/run.out" 2> "$WORK/run.err"
) || STATUS=$?
echo "opencode run exit status: $STATUS"

node "$LIVE/check.mjs" "$MODE" "$WORK" || STATUS=1
if [ "$STATUS" -ne 0 ]; then
	# For a failure nobody is watching, such as the weekly run: what OpenCode and the endpoint said.
	tail -n 30 "$WORK/run.err" "$WORK/mock.out" >&2 || true
fi
exit "$STATUS"
