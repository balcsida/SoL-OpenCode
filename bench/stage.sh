#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
# SPDX-License-Identifier: MIT
#
# Stage what the task containers need: OpenCode's Linux x64 binary, ripgrep
# (OpenCode would download it otherwise), this checkout's plugin with its runtime
# dependencies, and uv for SWE-bench's grader (the task image installs it from the
# internet at build time, which the Docker engine here cannot reach). The sweep
# mounts bench/stage read-only into every container.
set -euo pipefail
BENCH=$(cd "$(dirname "$0")" && pwd)
ROOT=$(dirname "$BENCH")
STAGE="$BENCH/stage"
OPENCODE_VERSION=2.2.3
RG_VERSION=14.1.1
UV_VERSION=0.7.13 # the version the SWE-bench task Dockerfiles install
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

rm -rf "$STAGE"
mkdir -p "$STAGE/sol-opencode"
# The baseline build runs on any x86-64 CPU, including emulation without AVX2.
(cd "$T" && npm pack --silent "@opencode/cli-linux-x64-baseline@$OPENCODE_VERSION" > /dev/null && tar -xzf opencode-cli-linux-x64-baseline-*.tgz)
install -m 755 "$T/package/bin/opencode" "$STAGE/opencode"
curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/$RG_VERSION/ripgrep-$RG_VERSION-x86_64-unknown-linux-musl.tar.gz" | tar -xz -C "$T"
install -m 755 "$T/ripgrep-$RG_VERSION-x86_64-unknown-linux-musl/rg" "$STAGE/rg"
curl -fsSL "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-x86_64-unknown-linux-musl.tar.gz" | tar -xz -C "$T"
install -m 755 "$T/uv-x86_64-unknown-linux-musl/uv" "$STAGE/uv"
cp -R "$ROOT/.npmrc" "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/index.ts" "$ROOT/tui.tsx" "$ROOT/src" "$STAGE/sol-opencode/"
(cd "$STAGE/sol-opencode" && npm ci --omit=dev --ignore-scripts --silent)
echo "staged OpenCode $OPENCODE_VERSION, ripgrep $RG_VERSION, uv $UV_VERSION, and SoL-OpenCode $(git -C "$ROOT" rev-parse --short HEAD) in $STAGE"
