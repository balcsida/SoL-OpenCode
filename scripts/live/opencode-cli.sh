#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
# SPDX-License-Identifier: MIT
#
# Fetches OpenCode's CLI for this platform from npm and prints the directory
# that holds the `opencode` binary, for the live checks:
#
#   PATH="$(scripts/live/opencode-cli.sh):$PATH" scripts/live/verify.sh all
#
# Usage: scripts/live/opencode-cli.sh [version|latest]
#
# The version defaults to the @opencode/plugin pin in package.json, the
# OpenCode release this plugin supports. The platform package is unpacked as
# it is; no install script runs.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
case "$(uname -s)-$(uname -m)" in
	Linux-x86_64) PLATFORM=linux-x64 ;;
	Linux-aarch64 | Linux-arm64) PLATFORM=linux-arm64 ;;
	Darwin-arm64) PLATFORM=darwin-arm64 ;;
	Darwin-x86_64) PLATFORM=darwin-x64 ;;
	*)
		echo "no OpenCode CLI package for $(uname -s) $(uname -m)" >&2
		exit 1
		;;
esac
REQUESTED="${1:-$(node -p 'require(process.argv[1]).dependencies["@opencode/plugin"]' "$ROOT/package.json")}"
# Resolves a tag such as `latest`, and fails here if there is no such release.
VERSION=$(npm view "@opencode/cli-$PLATFORM@$REQUESTED" version)
case "$VERSION" in
	"" | *[!0-9A-Za-z.+-]*)
		echo "$REQUESTED does not name one OpenCode release" >&2
		exit 1
		;;
esac
# A directory of the user's own: this binary gets run, so it must not come from a shared /tmp.
CACHE="${OPENCODE_CLI_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/sol-opencode-cli}/$PLATFORM-$VERSION"

if [ ! -x "$CACHE/package/bin/opencode" ]; then
	mkdir -p "${CACHE%/*}"
	# Unpacked beside the cache and moved into place, so an interrupted download is never mistaken for a release.
	STAGE=$(mktemp -d "$CACHE.XXXXXX")
	(cd "$STAGE" && npm pack --silent "@opencode/cli-$PLATFORM@$VERSION" > /dev/null && tar -xzf ./*.tgz && rm -f ./*.tgz)
	# Another run may have finished first; anything else in the way is a broken leftover.
	if [ -x "$CACHE/package/bin/opencode" ]; then rm -rf "$STAGE"; else rm -rf "$CACHE" && mv "$STAGE" "$CACHE"; fi
fi
echo "$CACHE/package/bin"
