# OpenCode Compatibility

SoL-OpenCode is developed and tested against OpenCode **2.0.18** (`@opencode/cli` 2.0.18) and pins `@opencode/plugin` to exactly **2.0.18**. The v2 plugin API is young: the package went from its first release on 2026-09-02 to 2.0.18 on 2026-09-28. Treat any other OpenCode version as a compatibility change and re-run both of these before using it:

- `npm run check`: type checking and 130 zero-spend tests;
- `scripts/live/verify.sh`: real sessions against a scripted local endpoint.

Source references below point at `anomalyco/opencode` tag `v2.0.18` (`packages/…`) and at `@opencode/plugin@2.0.18` `dist/`.

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
| `ctx.session.hook("generate")` | Action Fusion, Online Context Compact | |
| `ctx.session.hook("compaction")` | Action Fusion | keeps the advertised tools identical on every request kind |
| `ctx.session.hook("prompt")` | Online Context Compact | correction detection |
| `ctx.session.context` | Action Fusion | reads the recorded tool-call input |
| `ctx.session.generate` | Online Context Compact | the compaction summary |
| `ctx.generate.text` | Reducer | the reducer call |
| `ctx.model.list` | Online Context Compact | the context window |
| `ctx.storage` | Online Context Compact | per-session state |
| `ctx.event.subscribe` | Action Fusion, Online Context Compact | `session.step.ended`, `session.execution.*`, `session.idle`, `session.compaction.ended`, `session.revert.committed`, `session.deleted` |

**Experimental status:** none of these is marked experimental in the v2 docs or typings. The experimental surfaces (`experimental.ws.*` hooks and `ctx.experimental.terminal`) are not used.

SoL-OpenCode does not patch OpenCode, does not reach its HTTP API, and makes every model call through OpenCode: `ctx.generate.text` and `ctx.session.generate`.

### Host behaviour the plugin relies on

These points are not part of the documented plugin contract. The port mirrors them from the v2.0.18 source, and the fake plugin context in `tests/` reproduces them:

- **Global directories.** OpenCode's global directories follow XDG with an `opencode` suffix, and `OPENCODE_CONFIG_DIR` overrides the config directory (`util/src/global-roots.ts`, `util/src/global.ts`). There is no plugin API for them.
- **Tool paths.** The built-in `edit` and `write` resolve paths with `FileAccess.resolvePath` (`core/src/file-access.ts:73`): Windows drive conversion, `~` expansion, and resolution against the Location directory.
- **Shell output.** The built-in `shell` keeps the last 2,000 lines / 50 KiB and saves the full output to `<data>/shell/<projectID>/sh_*.out`, announced by a `full output saved to …` notice (`core/src/shell.ts:236-249`). The file is deleted once more than 25 exited shells are retained.
- **Input repair.** `opencode.tool.input.repair` runs its `execute.before` hook before any user plugin and drops keys that a closed input schema does not declare (`core/src/plugin/tool-input-repair.ts`).
- **Recorded calls.** A tool call is recorded durably with its raw input (`Tool.Called`) before execution starts (`core/src/session/runner/step.ts:101`).
- **Message rebuilding.** After the request hooks run, OpenCode rebuilds every message with `Message.make({ ...message, content })` (`core/src/session/model-request.ts:112`). Replacement messages may therefore be plain objects.
- **Tool errors.** A rejected Promise tool executor is a defect, not a typed `Tool.Error`: it skips `execute.after` (`plugin/src/promise/adapter.ts:615`, `core/src/tool.ts:113-149`).

## Plugin tools

In v2 a plugin tool without `options.codemode: false` lives only in the Code Mode catalog, reachable through the `execute` tool (`core/src/tool.ts:234`). SoL-Pi's tools were direct model tools, so `obs_recall`, `evidence_recall`, and `update_plan` set `codemode: false`, like OpenCode's own built-ins.

Their input is JSON Schema, which OpenCode validates before the executor runs. Because a Promise executor cannot report a typed failure, expected failures come back as ordinary content with `metadata.error`:

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

A `context` hook rewrites only the outgoing request. OpenCode lowers each completed tool call to a `tool` message with one `tool-result` part (`core/src/session/runner/to-llm-message.ts`). The plugin replaces the part, and its message, with a new object and never edits the original objects. Persisted history keeps every original result, which the live verification checks directly.

It skips:

- error results;
- results with any non-text item;
- provider-hosted results;
- anything containing a reducer receipt.

It keeps the result kind (`text` or `content`) and any other part fields.

Differences from SoL-Pi:

- OpenCode truncates tool output itself before a result reaches the request (2,000 lines / 50 KiB). Such results are archived as the truncated text OpenCode recorded; OpenCode keeps the full output in its own files.
- Archives live under `<OpenCode data>/sol-opencode/<sessionID>/observation-pack/` rather than a Pi session directory.
- The first-placeholder "money saved" TUI notification is not ported. The ledger records every saving.

## Evidence-Preserving Reducer

An `execute.after` hook handles completed foreground `shell` results and fused `edit`/`write` results. The reducer route (`evidencePreservingReducerProvider`/`Model`, default `openai/gpt-5.6-luna`) goes through `ctx.generate.text`, so OpenCode resolves the model and its credentials.

As in SoL-Pi, a verified receipt becomes the tool result that OpenCode records. The original is archived under `<OpenCode data>/sol-opencode/<sessionID>/evidence-preserving-reducer/` and stays readable with `evidence_recall`. Every failure leaves the original result unchanged.

Differences from SoL-Pi:

- **Failure detection.** A failed command is judged by the shell's exit, timeout, or signal metadata, not by an error status.
- **Exact body.** For a truncated result, the full log is read only when the shell reported truncation. It is read only from a regular, non-symlink `sh_*.out` file directly inside OpenCode's shell directory for this project, named by the last truncation notice.
- **Prompt.** `ctx.generate.text` takes one prompt string, so the reducer instructions lead the input instead of forming a system prompt.
- **No output cap or usage.** `ctx.generate.text` accepts neither `maxTokens` nor reports usage or a stop reason. The receipt says `reducer_total_tokens=unavailable`. Output cost is bounded only by the model's own limit.
- **Timeout.** `ctx.generate.text` offers no cancellation, because the plugin adapter drops request options. On timeout the original result goes back to the agent, but the provider call runs to completion.
- **Readback.** Receipts point readback at `evidence_recall`. Reading the archive with `read`/`shell` would trigger OpenCode's `external_directory` approval.
- **Journal.** Decisions go to `journal.jsonl` beside the archive. OpenCode has no plugin-writable, non-context session log.

## Online Context Compact

OpenCode v2.0.18 gives plugins no way to request its own compaction: `ctx.session` has no `compact` (`dist/promise/session.d.ts:143`, `dist/promise/adapter.js:417-432`). Online Context Compact therefore compacts in the outgoing request:

1. **Plan.** `update_plan` records the plan. A newly completed step becomes a pending boundary.
2. **Decide.** The next `context` hook (registered after ObservationPack, so it measures the packed request) finds that step's `update_plan` result and runs SoL-Pi's `decideCompaction` gate, unchanged. It uses `cacheWriteReadRatio`, the retained tail (20,000 tokens, SoL-Pi's default), the window from `ctx.model.list()`, and the request size.
3. **Summarize.** A selected boundary is summarized once through `ctx.session.generate`. The plugin's `generate` hook replaces that request's messages with the primary request's projected prefix, byte for byte, plus the summary prompt, and caps output at 4,096 tokens. Its system prompt, tools, and prefix therefore match the primary request, so the provider's prompt cache covers them. The live run confirms the byte-identical prefix.
4. **Apply.** The summary and the id of the first kept message become a checkpoint. That request and every later one carry one user message holding the summary and the plan-rebuild reminder in place of the older messages. Mid-conversation system messages stay.

Consequences, compared with SoL-Pi:

- **History and continuation.** Persisted history is never changed, and the run continues in the same step. There is no `abort()`, no `agent_settled` barrier, and no hidden continuation turn. The plan-rebuild reminder is part of the checkpoint message.
- **Summary cost.** The summary is one extra request on the session's model, as native compaction is. Its prefix is cache-read; the gate's memo estimate stays at SoL-Pi's 1,000 tokens.
- **Failure.** Any summary failure (an error or empty text) leaves the request and state unchanged. The decision is recorded with `summaryFailed: true`.
- **Visibility.** OpenCode's UI does not show plugin compactions. OpenCode's own automatic compaction still runs on its thresholds, measured against the smaller projected requests. When it completes (`session.compaction.ended`), SoL's checkpoint is retired, and the compaction counts with no cache debt.
- **Stale checkpoints.** A checkpoint whose kept message is gone, for example after a revert, is dropped on the next request.
- **Corrections and reverts.** `session.revert.committed` resets the plan, like a correction. A prompt that starts with `CORRECTION:`, or a steering prompt sent while the session is running, is a correction. OpenCode delivers every prompt as `"steer"` by default, so a steer counts only while the session is busy.
- **Forks.** A forked session starts without a checkpoint.
- **State.** The plan, request horizon, context-growth, and debt state is one `ctx.storage` record per session (`occ/<sessionID>`). It never enters the model context. It is deleted when OpenCode reports `session.deleted` while the plugin is running.
- **Parallel calls.** `update_plan` calls are serialized per session, because v2 tools have no sequential execution mode.

### Context usage

SoL-Pi read `ExtensionContext.getContextUsage()`. The port takes the provider-counted size of the latest completed step from `session.step.ended` (`input + cache.read + cache.write + output + reasoning`), the same anchor OpenCode's own compaction threshold uses (`core/src/session/compaction.ts:174`).

It compares that with an estimate of the current request: bytes ÷ 4 of the messages, the system text, and the tool definitions. It uses the larger of the two, as SoL-Pi did. After a SoL compaction the provider-counted value is cleared until the next step, as Pi reported no size between a compaction and the next answered request. The context window comes from `ctx.model.list()`.

## Configuration and trust

See [configuration.md](configuration.md).

- **No trust gate.** OpenCode v2 has no project-trust concept, and it auto-loads code from `.opencode/plugins/`. SoL-OpenCode therefore reads `<location>/.opencode/sol-pi.json` without a trust check.
- **Plugin options.** Non-empty plugin `options` replace the config files entirely.

## Test doubles and verification

`tests/fake-opencode.ts` implements only the plugin-context members SoL-OpenCode uses. It reproduces the host behaviour listed above: hook order on one mutable event, input repair for closed schemas, the recorded call, Code Mode-only plugin tools, typed errors for built-ins versus defects for plugin tools, and message shapes. Every test is zero-spend.

`scripts/live/verify.sh` runs real `opencode run --standalone` sessions in a scratch project. It loads this checkout from `.opencode/plugins/` and points it at a scripted OpenAI-compatible endpoint on localhost. It logs every request the endpoint receives, and a diagnostic plugin compares each outgoing request with the persisted history. See [verification.md](verification.md) for the 2.0.18 results.

The live checks verify runtime compatibility, not provider behaviour or token savings on real tasks.

## Known gaps

- **Native compaction.** If OpenCode adds `compact` to the plugin `SessionDomain`, Online Context Compact could switch to native compaction with `delivery: "steer"`. The runner already continues the loop after a steer-delivered compaction.
- **Reducer request options.** If `ctx.generate.text` gains request options (system, `maxTokens`, abort signal, usage), the reducer can restore SoL-Pi's output cap, timeout cancellation, and receipt usage.
- **TUI.** The savings display (`renderCall`, `setStatus`, `notify`) is not ported. A CLI plugin (`@opencode/plugin/tui`) could provide it.
