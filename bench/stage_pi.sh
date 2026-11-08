#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
# SPDX-License-Identifier: MIT
#
# Stage what the task containers need for the Pi sweep (bench/sol_pi_agent.py):
# Node 22 for Linux x64, Pi 1.3.0 (the release SoL-Pi is tested against), ripgrep
# and uv as in stage.sh, and SoL-Pi source trees to compare. The sweep mounts
# bench/stage-pi read-only into every container at /sol-stage.
#
#   bench/stage_pi.sh /path/to/SoL-Pi main=upstream/main pr=perf/claude-prompt-cache
#
# Each `label=git-ref` pair exports that ref of the SoL-Pi checkout to
# bench/stage-pi/sol-pi-<label>; the agent's `sol_pi` kwarg selects the label.
set -euo pipefail
BENCH=$(cd "$(dirname "$0")" && pwd)
STAGE="$BENCH/stage-pi"
SOL_PI_ROOT=${1:?usage: stage_pi.sh <SoL-Pi checkout> label=ref...}
shift
NODE_VERSION=22.23.4
PI_VERSION=1.3.0
RG_VERSION=14.1.1
UV_VERSION=0.7.13 # the version the SWE-bench task Dockerfiles install
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

rm -rf "$STAGE"
mkdir -p "$STAGE/pi"
curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" | tar -xJ -C "$T"
mv "$T/node-v$NODE_VERSION-linux-x64" "$STAGE/node"
# Pi's only native modules are pi-tui's prebuilt terminal helpers, which ship for linux-x64 in the package.
(cd "$STAGE/pi" && npm init -y > /dev/null && npm install --silent --no-audit --no-fund --ignore-scripts --omit=dev "@earendil-works/pi-coding-agent@$PI_VERSION" > /dev/null)
curl -fsSL "https://github.com/BurntSushi/ripgrep/releases/download/$RG_VERSION/ripgrep-$RG_VERSION-x86_64-unknown-linux-musl.tar.gz" | tar -xz -C "$T"
install -m 755 "$T/ripgrep-$RG_VERSION-x86_64-unknown-linux-musl/rg" "$STAGE/rg"
curl -fsSL "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-x86_64-unknown-linux-musl.tar.gz" | tar -xz -C "$T"
install -m 755 "$T/uv-x86_64-unknown-linux-musl/uv" "$STAGE/uv"
for pair in "$@"; do
	label=${pair%%=*}
	ref=${pair#*=}
	mkdir -p "$STAGE/sol-pi-$label"
	# Only what Pi loads; the tests would otherwise be picked up by `node --test bench/`.
	git -C "$SOL_PI_ROOT" archive "$ref" package.json src | tar -x -C "$STAGE/sol-pi-$label"
	git -C "$SOL_PI_ROOT" rev-parse "$ref" > "$STAGE/sol-pi-$label/COMMIT"
	echo "sol-pi-$label: $ref $(cat "$STAGE/sol-pi-$label/COMMIT")"
done
echo "staged Node $NODE_VERSION, Pi $PI_VERSION, ripgrep $RG_VERSION, uv $UV_VERSION in $STAGE"
