# OpenCode Compatibility

SoL-OpenCode is developed and tested against OpenCode **2.2.3** (`@opencode/cli` 2.2.3) and pins `@opencode/plugin` to exactly **2.2.3**. The v2 plugin API is young: the package went from its first release on 2026-09-02 to 2.2.3 on 2026-10-30. The port moved from 2.0.18 to 2.2.3 without a change to the hooks it uses; the differences that mattered are noted below. Treat any other OpenCode version as a compatibility change and re-run both of these before using it:

- `npm run check`: type checking and 167 zero-spend tests;
- `scripts/live/verify.sh`: real sessions against a scripted local endpoint.

Source references below point at `anomalyco/opencode` tag `v2.2.3` (`packages/…`) and at `@opencode/plugin@2.2.3` `dist/`.

The mechanisms follow [NVlabs/SoL-Pi](https://github.com/NVlabs/SoL-Pi) at commit `2195680` (2026-10-18). SoL-Pi changes that concern only Pi's runtime are not ported: temporary archives for `--no-session` and in-memory sessions (every OpenCode session has an archive root under OpenCode's data directory), the recovery from native compaction refusals and the deferred-host continuation (OpenCode's run continues on its own after a compaction), and the Pi 1.x and codemode compatibility work (Pi's shell settings, in-place context edits, its compaction settings lookup, and nested codemode call ids). Where that work fixed a mechanism rather than Pi plumbing, the port already takes the status from OpenCode's metadata instead of from text, so nothing was left to fix.

## Public API used

SoL-OpenCode is a Promise plugin: `Plugin.define({ id: "sol-opencode", setup })`. It uses only these members of the plugin context:

| API | Used by | Notes |
|---|---|---|
| `ctx.options`, `ctx.location` | config, paths | options replace config files; `location.directory` resolves paths and the project config |
| `ctx.tool.transform` → `editor.add` | ObservationPack (`obs_recall`), Reducer (`evidence_recall`), Online Context Compact (`update_plan`) | all three set `options.codemode: false` (see [Tools](#plugin-tools)) |
| `ctx.tool.list` | Action Fusion | finds OpenCode's `shell` executor |
| `ctx.tool.hook("execute.before")` | Action Fusion | |
| `ctx.tool.hook("execute.after")` | Action Fusion, Reducer | Action Fusion registers first, so the reducer sees the fused output |
| `ctx.session.hook("context")` | Action Fusion, ObservationPack, Online Context Compact | registration order is Action Fusion → ObservationPack → Online Context Compact |
| `ctx.session.hook("generate")` | Action Fusion | keeps the advertised tools identical on every request kind |
| `ctx.session.hook("compaction")` | Action Fusion, ObservationPack | identical tools, and the packed prefix, on OpenCode's summary request |
| `ctx.session.hook("prompt")` | Online Context Compact | correction detection |
| `ctx.session.context` | Action Fusion | reads the recorded tool-call input |
| `ctx.session.compact`, `ctx.session.synthetic` | Online Context Compact | requests OpenCode's compaction at a plan boundary, then the plan reminder |
| `ctx.experimental.generate.text` | Reducer | the reducer call |
| `ctx.model.list` | Online Context Compact | the context window |
| `ctx.storage` | Online Context Compact | per-session state |
| `ctx.event.subscribe` | Action Fusion, Online Context Compact | `session.step.ended`, `session.execution.*`, `session.idle`, `session.compaction.ended`, `session.compaction.failed`, `session.revert.committed`, `session.deleted` |

**Experimental status:** `ctx.experimental.generate.text` sits under the experimental namespace. It replaced `ctx.experimental.generate.text`, which 2.2 deprecates and removes in the next minor. Nothing else used here is marked experimental; the `experimental.ws.*` hooks, `experimental.idle`, and `ctx.experimental.terminal` are not used.

SoL-OpenCode does not patch OpenCode, does not reach its HTTP API, and makes every model call through OpenCode: `ctx.experimental.generate.text` for the reducer, and OpenCode's own compaction for the summary.

### Host behaviour the plugin relies on

These points are not part of the documented plugin contract. The port mirrors them from the v2.2.3 source, and the fake plugin context in `tests/` reproduces them:

- **Global directories.** OpenCode's global directories follow XDG with an `opencode` suffix, and `OPENCODE_CONFIG_DIR` overrides the config directory (`util/src/global-roots.ts`, `util/src/global.ts`). There is no plugin API for them.
- **Tool paths.** The built-in `edit` and `write` resolve paths with `FileAccess.resolvePath` (`core/src/file-access.ts:73`): Windows drive conversion, `~` expansion, and resolution against the Location directory.
- **Shell output.** The built-in `shell` keeps the last 2,000 lines / 50 KiB and saves the full output to `<data>/shell/<projectID>/sh_*.out`, announced by a `full output saved to …` notice (`core/src/shell.ts:236-249`). The file is deleted once more than 25 exited shells are retained.
- **Input repair.** `opencode.tool.input.repair` runs its `execute.before` hook before any user plugin and drops keys that a closed input schema does not declare (`core/src/plugin/tool-input-repair.ts`).
- **Recorded calls.** A tool call is recorded durably with its raw input (`Tool.Called`) before execution starts (`core/src/session/runner/step.ts:101`).
- **Message rebuilding.** After the request hooks run, OpenCode rebuilds every message with `Message.make({ ...message, content })` (`core/src/session/model-request.ts:112`). Replacement messages may therefore be plain objects.
- **Tool errors.** Since 2.0.28 a rejected Promise tool executor becomes a `Tool.Error` carrying its message (`plugin/src/promise/adapter.ts`, `toolError`), and `execute.after` runs for it with `status: "error"` (`core/src/tool.ts`, `executeTool`). Only an executor that rejects with a `Tool.Error` itself keeps its metadata.

## Plugin tools

In v2 a plugin tool without `options.codemode: false` lives only in the Code Mode catalog, reachable through the `execute` tool (`core/src/tool.ts:234`). SoL-Pi's tools were direct model tools, so `obs_recall`, `evidence_recall`, and `update_plan` set `codemode: false`, like OpenCode's own built-ins.

Their input is JSON Schema, which OpenCode validates before the executor runs. Expected failures come back as ordinary content with `metadata.error`, so the recorded call stays readable:

- an unknown observation or evidence id;
- a tampered or symlinked archive object (the read fails closed);
- an invalid plan.

In SoL-Pi these threw.

## Action Fusion

The built-in `edit` and `write` tools are not replaced; wrapping their executors from a Promise plugin would turn their typed failures into defects. Action Fusion works in four steps:

1. **Advertise.** The `context`, `generate`, and `compaction` hooks add an optional `then_run` object to the live `edit`/`write` JSON schemas. OpenCode matches a replaced definition back by key (`core/src/session/model-request.ts:228`). Every provider protocol sends tool schemas with `strict: false`.
2. **Take the queue.** `execute.before` removes `then_run` from the input if it is still there. The input-repair hook usually dropped it already; in that case the plugin reads `then_run` from the recorded call via `ctx.session.context()`. It then takes SoL's per-file queue before the built-in mutation runs.
3. **Run the command.** `execute.after` checks that the file is unchanged and runs the command through OpenCode's own `shell` tool, so OpenCode's shell selection, permissions, `ctx.shell.hook("create.before")`, and output limits all apply. It appends the result and records `metadata.thenRun: { status, command, exit, truncated }`.
4. **Release.** The queue slot is released after the command. If `execute.after` never runs, the slot is released and the running command aborted on `session.execution.interrupted`, `session.idle`, or `session.deleted`.

Differences from SoL-Pi:

- `then_run.timeout` is in **milliseconds**, like OpenCode's `shell` tool. Pi used seconds.
- A command that exits non-zero, times out, or is killed leaves the call `completed`, with a `[then_run:failed]` marker and the exit status. `execute.after` cannot change a call's status. Pi reported the fused call as an error. A failed mutation is still a typed error, now ending with `[then_run:skipped] …`.
- Paths resolve exactly as OpenCode's built-ins resolve them. There is no `@` stripping, `file://` decoding, or Unicode-space normalization, because OpenCode does none.
- A plain `edit`/`write` of a file waits for a running fused command on that file, as in SoL-Pi. Mutations by other tools, other plugins, or external processes are not locked. The hash guard still skips the command if the file changes between mutation and command.
- The fused command runs with the edit/write call's identity. A permission prompt for the command is therefore attributed to that call.

## ObservationPack

A `context` hook rewrites only the outgoing request, and the same projection runs on the `compaction` hook, so OpenCode's summary request carries the packed prefix the provider has already cached. OpenCode lowers each completed tool call to a `tool` message with one `tool-result` part (`core/src/session/runner/to-llm-message.ts`). The plugin replaces the part, and its message, with a new object and never edits the original objects. Persisted history keeps every original result, which the live verification checks directly.

It skips:

- error results;
- results with any non-text item;
- provider-hosted results;
- anything containing a reducer receipt.

It keeps the result kind (`text` or `content`) and any other part fields.

Differences from SoL-Pi:

- OpenCode truncates tool output itself before a result reaches the request (2,000 lines / 50 KiB). Such results are archived as the truncated text OpenCode recorded; OpenCode keeps the full output in its own files.
- Archives live under `<OpenCode data>/sol-opencode/<sessionID>/observation-pack/` rather than a Pi session directory.
- SoL-Pi's "money saved" notification is ported as a toast by the TUI companion (`tui.tsx`); the status line is ported as a sidebar section; tool-call rendering is not. The ledger records every saving.

## Evidence-Preserving Reducer

An `execute.after` hook handles completed foreground `shell` results and fused `edit`/`write` results. The reducer route (`evidencePreservingReducerProvider`/`Model`, default `openai/gpt-5.6-luna`) goes through `ctx.experimental.generate.text`, so OpenCode resolves the model and its credentials.

As in SoL-Pi, a verified receipt becomes the tool result that OpenCode records. The original is archived under `<OpenCode data>/sol-opencode/<sessionID>/evidence-preserving-reducer/` and stays readable with `evidence_recall`. Every failure leaves the original result unchanged.

Differences from SoL-Pi:

- **Failure detection.** A failed command is judged by the shell's exit, timeout, or signal metadata, not by an error status.
- **Exact body.** For a truncated result, the full log is read only when the shell reported truncation. It is read only from a regular, non-symlink `sh_*.out` file directly inside OpenCode's shell directory for this project, named by the last truncation notice.
- **Prompt.** `ctx.experimental.generate.text` takes one prompt string, so the reducer instructions lead the input instead of forming a system prompt.
- **No output cap or usage.** `ctx.experimental.generate.text` accepts neither `maxTokens` nor reports usage or a stop reason. The receipt says `reducer_total_tokens=unavailable`. Output cost is bounded only by the model's own limit.
- **Timeout.** `ctx.experimental.generate.text` offers no cancellation, because the plugin adapter drops request options. On timeout the original result goes back to the agent, but the provider call runs to completion.
- **Readback.** Receipts point readback at `evidence_recall`. Reading the archive with `read`/`shell` would trigger OpenCode's `external_directory` approval.
- **Journal.** Decisions go to `journal.jsonl` beside the archive. OpenCode has no plugin-writable, non-context session log.

## Online Context Compact

OpenCode 2.1 added `compact` to the plugin `SessionDomain`, so Online Context Compact works as in SoL-Pi: the mechanism decides when, and the host compacts.

1. **Plan.** `update_plan` records the plan. A previously registered unfinished step that becomes completed is a boundary. A completed step that appears under a new id is recorded as history, not progress, so a plan re-stated or re-keyed after compaction does not retrigger it. The plan survives compaction, as in SoL-Pi.
2. **Decide.** The boundary is decided in the same `update_plan` call, SoL-Pi's `turn_end`: the request that produced the call has already been counted and observed. SoL-Pi's `decideCompaction` gate runs unchanged on the last request the `context` hook saw (registered after ObservationPack, so placeholders count at their size), with `cacheWriteReadRatio`, the retained tail (20,000 tokens, SoL-Pi's default), the window from `ctx.model.list()`, and the request size. Economic compaction waits two provider requests after any compaction; window protection overrides that cooldown. A boundary before any observed request, or while a requested compaction is still pending, is left undecided.
3. **Request.** A selected boundary calls `ctx.session.compact({ sessionID, delivery: "steer" })`, then `ctx.session.synthetic` with the plan reminder, also steered. OpenCode runs the compaction before the running session's next model step and admits the reminder as a user message right after the checkpoint (`core/src/session/runner/llm.ts`). The summary is OpenCode's own: its template, its model call, and its retained tail (`metadata.keepID`), sized by OpenCode's `keep` budget. The port prices the removable prefix at SoL-Pi's retained tail, because the host's split is not exposed.
4. **Account.** `session.compaction.ended` with `reason: "manual"` while a request is pending is this mechanism's compaction: it carries SoL's cache debt, and the saving (the priced prefix minus the summary) is reported. Any other compaction, OpenCode's threshold or a user's `/compact`, counts with no debt. `session.compaction.failed` clears the pending request, so a later boundary can ask again.

Consequences, compared with SoL-Pi:

- **No abort, no continuation turn.** SoL-Pi aborts the turn, compacts, and sends a message that starts a new turn. OpenCode delivers the compaction between steps of the same run, so nothing is aborted and the run continues by itself; the reminder is SoL-Pi's text, as a synthetic message.
- **Summary request.** OpenCode sends the conversation to summarize unchanged when the window fits it, with the system prompt and tools of the primary request. With ObservationPack enabled, its leading messages are byte for byte the previous agent request (the live run checks this), so the provider's prompt cache covers them. SoL-Pi's `customInstructions` are not passed: a plugin could only prepend them to the system prompt, which would break that cache, and OpenCode's template already keeps decisions, work state, and next moves.
- **Checkpoint.** The summary and the retained tail become one checkpoint user message, and history starts from it (OpenCode 2.2). The retained tail is kept as text, not as messages. `obs_recall` and `evidence_recall` keep working, because the archives outlive the compaction.
- **Request accounting.** The request that leads to the boundary is counted at its pre-compaction size before the decision, as SoL-Pi's `before_provider_request` precedes its `turn_end` decision, and the compaction clears the size baseline. Cache debt accumulates across compactions and is charged on the post-compaction context. A new prompt after a fully completed plan resets the request-horizon samples and keeps unpaid debt.
- **Failure.** If `compact` rejects, nothing changes and the decision is recorded with `requested: false`. A compaction OpenCode starts and then fails ends the run with `session.compaction.failed`, as a failed `/compact` would. The gate therefore never requests one without a cut point, which rules out OpenCode's only refusal (`Nothing to compact`). SoL-Pi's recoverable refusals and its retry block have no counterpart.
- **Visibility.** OpenCode shows the compaction as it shows `/compact`; the TUI companion toasts the saving as well.
- **Corrections and reverts.** `session.revert.committed` resets the plan, like a correction. A prompt that starts with `CORRECTION:`, or a steering prompt sent while the session is running, is a correction. OpenCode delivers every prompt as `"steer"` by default, so a steer counts only while the session is busy.
- **Forks.** A forked session starts with no state of its own.
- **State.** The plan, request horizon, context-growth, and debt state is one `ctx.storage` record per session (`occ/<sessionID>`). It never enters the model context. It is deleted when OpenCode reports `session.deleted` while the plugin is running.
- **Parallel calls.** `update_plan` calls are serialized per session, because v2 tools have no sequential execution mode.

### Context usage

SoL-Pi read `ExtensionContext.getContextUsage()`. The port takes the provider-counted size of the latest completed step from `session.step.ended` (`input + cache.read + cache.write + output + reasoning`), the same anchor OpenCode's own compaction threshold uses (`core/src/session/compaction.ts:174`).

It compares that with an estimate of the current request: bytes ÷ 4 of the messages, the system text, and the tool definitions. It uses the larger of the two, as SoL-Pi did. After any compaction the provider-counted value is cleared until the next step, as Pi reported no size between a compaction and the next answered request. The context window comes from `ctx.model.list()`.

## Configuration and trust

See [configuration.md](configuration.md).

- **No trust gate.** OpenCode v2 has no project-trust concept, and it auto-loads code from `.opencode/plugins/`. SoL-OpenCode therefore reads `<location>/.opencode/sol-pi.json` without a trust check.
- **Plugin options.** Non-empty plugin `options` replace the config files entirely.

## Test doubles and verification

`tests/fake-opencode.ts` implements only the plugin-context members SoL-OpenCode uses. It reproduces the host behaviour listed above: hook order on one mutable event, input repair for closed schemas, the recorded call, Code Mode-only plugin tools, typed errors for failed built-ins and rejected plugin tools, `session.compact` and `session.synthetic` as recorded inbox items, and message shapes. Every test is zero-spend.

`scripts/live/verify.sh` runs real `opencode run --standalone` sessions in a scratch project. It loads this checkout from `.opencode/plugins/` and points it at a scripted OpenAI-compatible endpoint on localhost. It logs every request the endpoint receives, and a diagnostic plugin compares each outgoing request with the persisted history. See [verification.md](verification.md) for the 2.2.3 results.

The live checks verify runtime compatibility, not provider behaviour or token savings on real tasks.

## Known gaps

- **Compaction cut.** OpenCode chooses the retained tail from its own `keep` budget; the port prices the removable prefix at `keepRecentTokens`. If the plugin API exposes the host's compaction settings, the estimate can follow them, as SoL-Pi follows Pi's.
- **Reducer request options.** If `ctx.experimental.generate.text` gains request options (system, `maxTokens`, abort signal, usage), the reducer can restore SoL-Pi's output cap, timeout cancellation, and receipt usage.
- **TUI.** `notify` is ported: the server plugin emits a `saving` RPC event and the TUI companion (`@opencode/plugin/tui`) shows a toast. SoL-Pi's status line is ported as a sidebar section with per-mechanism tallies; `renderCall` rendering is not ported. The web UI has no plugin surface.
