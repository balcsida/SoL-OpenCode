# SoL-OpenCode agent instructions

SoL-OpenCode ports SoL-Pi's four efficiency mechanisms to an OpenCode v2 plugin.

- Use only the public `@opencode/plugin` API at the pinned version (see `package.json`). Do not patch, fork, or vendor OpenCode, and do not reach its private files or HTTP endpoints.
- `upstream/` is a read-only, git-ignored clone of NVlabs/SoL-Pi for reference. Never edit it.
- Every mechanism stays opt-in and disabled by default. Configuration lives in `sol-pi.json` or the plugin `options` (see `docs/configuration.md`).
- Never edit persisted session history. ObservationPack and Online Context Compact change only the outgoing model request. The reducer, like SoL-Pi's, replaces a tool result before OpenCode records it, and only with a verified receipt whose original is archived. Fail open: a mechanism error must leave the original tool result or request unchanged.
- Model calls go through OpenCode (`ctx.generate.text`, `ctx.session.generate`), never a direct provider call.
- Tests are zero-spend: drive mechanisms through `tests/fake-opencode.ts`, with no real provider calls.
- Run `npm run check` (type check and tests) before committing. Stop on failure; do not hide it.
- For changes that touch hooks or tools, also run `scripts/live/verify.sh af-op` and `scripts/live/verify.sh all` (real OpenCode sessions, scripted local endpoint, zero spend) when `opencode` is installed.
- Never print, log, or commit a credential. Only check whether one is present.
