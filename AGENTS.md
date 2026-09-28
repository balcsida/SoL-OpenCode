# SoL-OpenCode agent instructions

SoL-OpenCode ports SoL-Pi's four efficiency mechanisms to an OpenCode v2 plugin.

- Use only the public `@opencode/plugin` API at the pinned version (see `package.json`). Do not patch, fork, or vendor OpenCode, and do not reach its private files or HTTP endpoints.
- `upstream/` is a read-only, git-ignored clone of NVlabs/SoL-Pi for reference. Never edit it.
- Every mechanism stays opt-in and disabled by default. Configuration lives in `sol-pi.json` or the plugin `options` (see `docs/configuration.md`).
- Never mutate persisted session history. Request hooks change only the outgoing model request. Keep originals archived and fail open: a mechanism error must leave the original tool result or request unchanged.
- Model calls go through OpenCode (`ctx.generate.text`, `ctx.session.generate`), never a direct provider call.
- Tests are zero-spend: drive mechanisms through `tests/fake-opencode.ts`, with no real provider calls.
- Run `npm run check` (type check and tests) before committing. Stop on failure; do not hide it.
- Never print, log, or commit a credential. Only check whether one is present.
