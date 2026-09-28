# SoL-Pi → OpenCode v2 port audit (Phase 1)

Status: **audit only, no port code yet.** Phase 2 starts after the decisions in [§8](#8-decisions-needed-before-phase-2) are made.

## 0. Inputs and provenance

| Input | Value |
|---|---|
| Upstream SoL-Pi | `NVlabs/SoL-Pi` @ `1559b5cb12c72da4a485bc50fe326586b216fb19`, cloned read-only to `./upstream/` (git-ignored) |
| This repo's root | Byte-identical to that upstream commit (`diff -rq` shows no differences): the root is currently a plain copy of SoL-Pi |
| OpenCode v2 target | **2.0.18**, the `latest` dist-tag of `@opencode/cli`, `@opencode/plugin`, `@opencode/client`, and `@opencode/schema` on 2026-09-28 |
| v2 typings read | `@opencode/plugin@2.0.18` `dist/` (Promise and Effect entrypoints, `promise/adapter.js`), `@opencode/client@2.0.18` generated types |
| v2 source read | `anomalyco/opencode` tag `v2.0.18` (`cd9a14a6`) |
| v2 docs read (2026-09-28) | [Plugins overview](https://opencode.ai/v2/docs/build/plugins/), [Migrate plugins from V1](https://opencode.ai/v2/docs/build/plugins/migrate-v1/), [Compaction](https://opencode.ai/v2/docs/compaction/) (the task's `v2.opencode.ai/compaction` link redirects here), [Configure plugins](https://opencode.ai/v2/docs/plugins/), [Tools](https://opencode.ai/v2/docs/tools/), [CLI](https://opencode.ai/v2/docs/cli/), [Intro](https://opencode.ai/v2/docs/) |
| OpenCode installed locally? | **No.** `opencode` is not on `PATH`, so there is no local version to pin. This audit assumes 2.0.18. |

Citation keys used below:

- **[D: page › section]** is a v2 docs page.
- **[T: file:line]** is an `@opencode/plugin@2.0.18` `dist/` typing (or `adapter.js`).
- **[C: …]** is an `@opencode/client@2.0.18` generated type.
- **[S: path:line]** is `anomalyco/opencode@v2.0.18` source under `packages/`.

## 1. Findings in brief

1. **ObservationPack, Action Fusion, and Evidence-Preserving Reducer map onto public v2 hooks.** Their pure logic carries over mostly unchanged. Roughly 1,200 of upstream's 3,077 source lines can be reused verbatim or with type-only edits.
2. **Online Context Compact cannot trigger native compaction through the public plugin API.** `ctx.session` exposes `create | get | switchAgent | switchModel | prompt | generate | command | synthetic | interrupt | update | move | wait | context`, and there is no `compact` [T: promise/session.d.ts:143]. The Effect host is the same [T: effect/session.d.ts:143], and the runtime adapter builds exactly that set [T: promise/adapter.js:417-432]. The HTTP client has `session.compact`, but the plugin context exposes no client, server URL, or credentials. The hypothesis "`POST /api/session/{id}/compact` via the client on `ctx`" is therefore **false for 2.0.18**. The redesign options are in [§4.1](#41-online-context-compact-has-no-compaction-trigger).
3. **A Promise-plugin tool that throws is a defect, not a tool error.** `executePromiseTool` wraps executors in `Effect.promise` [T: promise/adapter.js:444]. A rejection therefore bypasses the typed `Tool.Error` path [S: core/src/tool/runtime.ts:37] and the `execute.after` hook [S: core/src/tool.ts:132-149]. This rules out naïvely wrapping the built-in `edit`/`write` executors from a Promise plugin, and it changes how `obs_recall` and `update_plan` report bad input. See [§4.2](#42-promise-tool-failures-are-defects).
4. **The built-in shell differs from Pi's bash.** The tool is named `shell`. Its timeout is in **milliseconds**, and a non-zero exit is a *successful* result carrying an `Exited with code N` notice, not an error. Output is tail-truncated to 50 KiB, with the full log saved to `<data>/shell/<projectID>/sh_*.out` [S: core/src/tool/plugin/shell.ts:22-57; core/src/shell.ts:136,247].
5. **`ctx.generate.text` accepts only a prompt.** Input is `{ prompt, model? }` and output is `{ text }` [C: GenerateTextInput; S: core/src/generate.ts:63]. There is no system role, no `maxTokens`, no usage or stop reason, and the adapter drops `requestOptions`, so there is no cancellation signal [T: promise/adapter.js:231].
6. **Provider-counted context size is available.** It was listed as "unknown". Assistant messages from `ctx.session.context()` and the `session.step.ended` event both carry per-request `tokens` (`input`, `cache.read`, `cache.write`, …). OpenCode's own compaction threshold uses the same anchor [S: core/src/session/compaction.ts:174-208].
7. **v2 path resolution differs from upstream `resolveToolPath`.** v2 does not strip `@`, decode `file://`, or normalise Unicode spaces [S: core/src/file-access.ts:73-83]. Porting the resolver unchanged would hash-check a different file than the one the built-in wrote.
8. **v2 has no project-trust gate.** It auto-loads code from `.opencode/plugins/` [D: plugins › Discover]. Pi's `isProjectTrusted()` guard has no counterpart.
9. **None of the hooks this port needs are marked experimental.** Only the `experimental.ws.*` hooks and `ctx.experimental.terminal` are [D: build/plugins › Native WebSocket (experimental); T: promise/plugin.d.ts]. The surface is still young, though: `@opencode/plugin` went from its first publish on 2026-09-02 to 2.0.18 on 2026-09-28.

## 2. Upstream inventory: pure logic vs Pi adapter code

Classes:

- **PURE**: no Pi imports; reuse verbatim.
- **PURE\***: logic is pure, but Pi types or Pi-specific constants need replacing; near-verbatim.
- **MIXED**: some functions reusable verbatim, the rest rewritten.
- **ADAPTER**: rewrite against v2.
- **DROP**: out of scope.

### Shared

| File | Lines | Class | Pi API used | Port verdict |
|---|---:|---|---|---|
| `src/sol-pi/index.ts` | 42 | ADAPTER | `ExtensionFactory`, `session_start`, `getAgentDir`, `isProjectTrusted` | Rewrite as `Plugin.define({ id, setup })`. Keep the registration order: AF → OP → EPR → OCC. |
| `src/sol-pi/config.ts` | 135 | MIXED | `CONFIG_DIR_NAME`, `getAgentDir` | Keep the schema validation (`loadSolPiConfig` body after path discovery, `stringConfigValue`, key sets) verbatim. Rewrite path discovery and add `ctx.options` as a source ([§4.5](#45-configuration-resolution)). |
| `src/sol-pi/runtime-paths.ts` | 17 | ADAPTER | `sessionManager.getSessionDir/getSessionId` | Replace with the storage root from [§4.4](#44-storage-root). Keep the safe-ID regex; v2 `ses_…` IDs match it. |
| `src/sol-pi/tui.ts` | 71 | DROP | `pi-tui`, `ctx.ui.*` | TUI is out of scope. `formatSavingsCount`/`formatSavingsBytes` are pure and may be kept for ledger text. |
| `scripts/check-sol-pi-config.mjs` | — | PURE\* | none at runtime | Keep the preflight and update the path defaults. |
| `scripts/check-pi-compat.mjs` | — | DROP | Pi exports | Replace with a check against `@opencode/plugin` exports. |

### Action Fusion (`extensions/action-fusion/`)

| File | Lines | Class | Pi API used | Port verdict |
|---|---:|---|---|---|
| `file-queue.ts` | 93 | MIXED | none | `withFusedFileQueue` and `canonicalQueueKey` stay verbatim. **Rewrite `resolveToolPath`, `normalizeToolPath`, and `normalizeWindowsShellPath`** to mirror v2 `FileAccess.resolvePath` + `FSUtil.windowsPath` [S: core/src/file-access.ts:73; util/src/fs-util.ts:258]. v2 does not strip `@`, decode `file://`, or map Unicode spaces. Its drive conversion handles `/c:/`, `/c/`, `/cygdrive/c/`, and `/mnt/c/`, and it resolves against `Location.directory` [S: core/src/file-access.ts:100]. |
| `then-run.ts` | 127 | MIXED | `createBashToolDefinition`, `AgentToolResult`, TypeBox | Keep the markers, `assertUnchangedBeforeCommand`, `fileSha256`, and `errorText` verbatim. Rewrite command execution to call the built-in `shell` executor. Map the exit code from `result.output.exit`/`metadata.exit` to `[then_run:failed]`. Convert the timeout (seconds → ms, or change units; see §8). Replace the TypeBox schema with JSON Schema. |
| `index.ts` | 169 | ADAPTER | `registerTool`, `create{Edit,Write}ToolDefinition`, renderers | Rewrite (design in [§4.2](#42-promise-tool-failures-are-defects)). Drop renderers. |

### ObservationPack (`extensions/observation-pack/`)

| File | Lines | Class | Pi API used | Port verdict |
|---|---:|---|---|---|
| `observation.ts` | 252 | PURE\* | types only: `AgentMessage`, `ToolResultMessage`, `TextContent` | Everything except `isPureTextResult`, `textFromResult`, and the `createObservation` signature is verbatim (thresholds, hashing, IDs, `ensureStored`, `placeholderFor`, `readRecallChunk`). Those three move to a v2 `ToolResultPart` adapter ([§3](#3-hook-mapping-pi--opencode-v2), row 4). |
| `ledger.ts` | 20 | PURE | none | Verbatim. |
| `index.ts` | 227 | ADAPTER | `registerTool`, `context` event, TUI | Rewrite registration and projection. Keep the algorithm verbatim: prior-assistant counting, `FULL_SENDS`, the send-count map, fail-open. |

### Evidence-Preserving Reducer (`extensions/evidence-preserving-reducer/`)

| File | Lines | Class | Pi API used | Port verdict |
|---|---:|---|---|---|
| `config.ts` | 70 | PURE\* | none | Verbatim, except that `DEFAULT_REDUCER_PROVIDER/MODEL` are Pi route IDs (`openai-codex/gpt-5.6-luna`) and must become an OpenCode route (§8). |
| `archive.ts` | 53 | PURE | none | Verbatim. |
| `receipt.ts` | 177 | PURE\* | type `ProviderResult` only | Verbatim, except the `readback=use bash …` line (v2 tool is `shell`; see §4.3) and `reducer_total_tokens` (no usage available; see §4.3). |
| `candidate.ts` | 101 | ADAPTER | `ToolResultEvent` | Keep the fused `then_run` marker parsing. Rewrite for tool `shell` (was `bash`). Derive failure from exit code, timeout, or signal instead of `isError`. Replace the full-output rule (`pi-bash-*.log` directly in `tmpdir`) with `sh_*.out` directly in `<data>/shell/<projectID>/`, taken from the shell's `full output saved to …` notice [S: core/src/shell.ts:136,247]. |
| `provider.ts` | 163 | ADAPTER | `modelRegistry.find/complete`, `pi-ai/compat` | Rewrite on `ctx.generate.text`. `operationSignal` and `normalizedUsage` become mostly moot (§4.3). |
| `journal.ts` | 25 | ADAPTER | `pi.appendEntry` | Rewrite as a JSONL ledger next to the archive, reusing `ledger.ts`, or as `ctx.storage` entries. |
| `index.ts` | 220 | MIXED | `tool_result`, `ExtensionContext` | The `reduceToolResult` decision flow (eligibility, all fallback reasons, smaller-receipt check, journal events) is reusable once its event type is abstracted. Registration becomes `execute.after`. |

### Online Context Compact (`extensions/online-context-compact/`)

| File | Lines | Class | Pi API used | Port verdict |
|---|---:|---|---|---|
| `economics.ts` | 237 | PURE | none | Verbatim. |
| `plan.ts` | 79 | PURE | none | Verbatim. |
| `state.ts` | 208 | MIXED | `SessionEntry`, `pi.appendEntry` | All state reducers and `parseOnlineState` stay verbatim. `restoreOnlineState(entries)` and `appendOnlineState(pi, …)` become storage load/save (§4.6). |
| `tools.ts` | 100 | ADAPTER | `registerTool`, TypeBox, `executionMode`, `promptSnippet/Guidelines`, TUI | Hand-write the equivalent JSON Schema. Fold the prompt snippets into `description`. Replace sequential execution with a per-session mutex. |
| `extension.ts` | 442 | ADAPTER | `findCutPoint`, `buildSessionContext`, `sessionEntryToContextMessages`, `estimateTokens`, `getContextUsage`, `compact`, `abort`, `agent_settled`, `sendMessage`, `session_*` events | Full redesign (§4.1). Keep `progressSummary`, `resolveKeepRecentTokens`, `tokenEstimate`, the construction of the `decideCompaction(...)` input, and the debt bookkeeping. `nativeCompactionFeasible`, `branchAfterAbort`, `compactionMessageCount`, the abort barrier, and the continuation promise do not carry over. |
| `index.ts` | 49 | ADAPTER | `ExtensionAPI` | Thin rewrite. |

## 3. Hook mapping: Pi → OpenCode v2

✅ confirmed · ⚠️ confirmed with a material difference · ❌ no equivalent

| # | Pi | Hypothesis | Verified v2 equivalent | | Evidence |
|---|---|---|---|---|---|
| 1 | `registerTool` (new tools `obs_recall`, `update_plan`) | `ctx.tool.transform` | `ctx.tool.transform(editor => editor.add({ name, description, input, execute }))`. Input may be JSON Schema, an Effect Schema, or a Standard Schema. A later valid registration overrides the same name. A thrown error in a Promise executor is a defect (§4.2). | ⚠️ | [D: build/plugins › API › Tools]; [T: promise/tool.d.ts]; [S: schema tool.d.ts `Info`] |
| 2 | `create{Edit,Write}ToolDefinition` replacement | `ctx.tool.transform` add/update | `editor.update("edit"/"write", …)` exposes the built-in with a Promise-adapted executor, so wrapping is technically possible [T: promise/adapter.js `update`]. However, the built-ins' `input` is an Effect `Schema.Struct` [S: core/src/tool/plugin/edit.ts:24, write.ts:23]. A Promise wrapper turns the built-ins' typed failures into defects. Recommended instead: a hooks-only design (rows 6 and 7 plus the `context` hook; §4.2). The built-in executors keep their permission checks [S: write.ts:78, edit.ts:180]. | ⚠️ | as cited |
| 3 | `createBashToolDefinition` (for `then_run`) | — | Call the built-in **`shell`** executor, obtained from `editor.get("shell")` or `ctx.tool.list()`. It runs through permissions and `ctx.shell.hook("create.before")`. Timeout is in ms (default 120,000). A non-zero exit is not an error. | ⚠️ | [S: core/src/tool/plugin/shell.ts:22-57,135]; [D: build/plugins › Hooks › Shell] |
| 4 | `context` event (projection) | `ctx.session.hook("context")` | Same. `event.messages: Message[]` holds `@opencode/ai` LLM messages. A tool result is a `role: "tool"` message with `ToolResultPart { id, name, result: {type:"text"\|"json"\|"error"\|"content", value} }`. Edits affect only the outgoing call. The hook also runs for tool-driven continuations. Register `"generate"` too if `ctx.session.generate` requests must see the same projection. | ✅ | [D: build/plugins › Hooks › Model requests]; [T: promise/session.d.ts]; [S: ai/src/schema/messages.ts:148,236; core/src/session/model-request.ts:205-254] |
| 5 | `before_provider_request` (size accounting) | `context` / `"model.request"` | `ctx.session.hook("context")`, registered after the other SoL transformers (hooks run in registration order). `"model.request"` carries only `headers`/`baseURL`, with no messages, so it cannot measure size. | ✅ | [D: build/plugins › Hooks]; [T: promise/session.d.ts `SessionModelRequest`] |
| 6 | `tool_result` (replace result) | `ctx.tool.hook("execute.after")`, set `event.result` | Same. For `status: "completed"`, `result` is writable. For `"error"`, `error` is writable, as the built-in Plan plugin does. The hook runs **before** OpenCode's generic 50 KiB / 2,000-line truncation [S: core/src/tool.ts:137,149 → core/src/session/runner/step.ts:122; core/src/tool-output.ts:13-14], so EPR sees full text. `shell` truncates its own output earlier (row 3). Defects never reach this hook. | ✅ | [D: build/plugins › Hooks › Tools]; [T: promise/tool.d.ts:38]; [S: core/src/plugin/plan.ts:45] |
| 7 | *(new)* input rewrite before execution | — | `ctx.tool.hook("execute.before")` receives the **raw provider input**, which is decoded afterwards [S: core/src/tool.ts:271; core/src/tool/runtime.ts:30], and `event.input` is writable. | ✅ | [T: promise/tool.d.ts] |
| 8 | `modelRegistry.complete()` | `ctx.generate.text` | Same, but prompt-only: `{ prompt, model? } → { text }`. No system role, `maxTokens`, usage, stop reason, or abort signal. Errors are `Generate.ModelSelectionError` or `UnavailableError`. | ⚠️ | [D: build/plugins › API › Generate]; [C: GenerateTextInput]; [S: core/src/generate.ts]; [T: promise/adapter.js:231] |
| 9 | `ExtensionContext.compact()` | `POST /api/session/{id}/compact` via client on `ctx` + `hook("compaction")` | **Not available to plugins** (see §1, finding 2). `hook("compaction")` only intercepts or replaces the summary of a compaction OpenCode has already decided to run. | ❌ | [T: promise/session.d.ts:143; effect/session.d.ts:143; promise/adapter.js:417-432]; [D: compaction › Manual] |
| 10 | `agent_settled` / `abort()` barrier | likely unnecessary | **Confirmed unnecessary for native compaction**: a steer-delivered compaction request is taken at the next step boundary while the loop is continuing, and the loop then proceeds without a new prompt [S: core/src/session/runner/llm.ts:56,111-150,155-161]. The point is moot until row 9 exists. | ✅ | as cited; [D: compaction › Manual: "Runs at the next safe point"] |
| 11 | `sendMessage({triggerTurn:true})` | `ctx.session.prompt` / `synthetic` after compaction event | Both exist. `synthetic({ sessionID, text, resume })` persists a durable message that enters context (the Plan plugin uses `resume:false`). Not needed for continuation (row 10). The plan-rebuild reminder can be a transient context-hook injection instead. | ✅ | [D: build/plugins › API › Sessions]; [C: SessionSyntheticInput]; [S: core/src/plugin/plan.ts:66-68] |
| 12 | `getContextUsage()` | **unknown** | **Resolved.** Provider-counted size of the last request is `tokens.input + tokens.cache.read + tokens.cache.write`. It is on the last assistant message from `ctx.session.context({sessionID})` and on `session.step.ended.data.tokens` (via `ctx.event.subscribe`). The window comes from `ctx.model.list()` → `Model.Info.limit.context`. The system prompt size is estimated from the context hook's `event.system`. | ✅ | [C: SessionMessageAssistant.tokens, SessionStepEnded, TokenUsageInfo]; [S: core/src/session/compaction.ts:174-208] |
| 13 | `SessionManager.getSessionDir()` | `ctx.storage` or a sessionID-keyed dir | `ctx.storage` is durable JSON in OpenCode's global SQLite KV table, namespaced by plugin ID. It is **not** session-scoped and not deleted with the session [S: core/src/plugin/host.ts:584; core/src/kv.ts]. There is no public API for a data directory (§4.4). | ⚠️ | [D: build/plugins › API › Storage] |
| 14 | `session_before_tree` | none needed | **Confirmed**: v2 has no tree navigation. Related v2 operations that OCC state must survive: `session.revert.*`, `session.forked`, `session.moved`, `session.deleted` events. | ✅ | [C: event type list] |
| 15 | TUI `renderCall` / `setStatus` / `notify` | out of scope | Out of scope. v2 UI extensions are CLI plugins (`@opencode/plugin/tui`). | — | [D: build/plugins/cli] |
| 16 | `session_start` / `session_shutdown` | — | `setup` runs once per plugin location; its returned cleanup runs on unload. Per-session state is restored lazily on the first hook that carries a `sessionID`. | ✅ | [D: build/plugins › Lifecycle] |
| 17 | `session_compact` (after native compaction) | `hook("compaction")` | `session.compaction.ended` event (`reason: "auto" \| "manual"`, `text`, `tokens`) via `ctx.event.subscribe()`. | ✅ | [C: SessionCompactionEnded] |
| 18 | `input` (steer / `CORRECTION:` detection) | — | `ctx.session.hook("prompt")` sees `prompt.text` and `delivery`. **But v2 delivery defaults to `"steer"` for every prompt**, so it does not mean "typed while running". Busy state has to be tracked from `session.execution.started` / `session.idle` events. | ⚠️ | [D: build/plugins › Hooks › Prompt admission] |
| 19 | `turn_end` | — | Evaluate the pending plan boundary at the next `context` hook call (the `update_plan` result is in `event.messages`), or on `session.step.ended`. | ✅ | as above |
| 20 | `pi.appendEntry` (non-context session log entries) | — | **No session-scoped, non-context equivalent.** `synthetic` enters context. `session.update({metadata})` replaces a single object other writers share. Use `ctx.storage` keyed by `sessionID`, plus cleanup on `session.deleted`. | ❌ | [C: SessionUpdateInput] |
| 21 | `ExtensionContext.model` / `modelRegistry.find` | — | Context hook `event.model` (`Model.Ref`) plus `ctx.model.list()`. | ✅ | [T: promise/session.d.ts] |
| 22 | `ctx.cwd` | — | `ctx.location.directory`. Built-ins resolve relative paths against `Location.directory` and also accept paths inside the project worktree. | ✅ | [D: build/plugins › Context]; [S: core/src/file-access.ts:99-108] |
| 23 | `ctx.signal` | — | Tool executors get `context.signal`. Hooks get no signal. | ⚠️ | [D: build/plugins › API › Tools] |
| 24 | `isProjectTrusted()` | — | No equivalent: v2 has no project-trust gate. | ❌ | [D: plugins › Discover] |
| 25 | `getAgentDir()` / `CONFIG_DIR_NAME` | — | No plugin API. OpenCode's global config dir is `$OPENCODE_CONFIG_DIR` ?? `$XDG_CONFIG_HOME/opencode` (default `~/.config/opencode`), and the project dir is `.opencode/`. These must be replicated. | ⚠️ | [S: util/src/global.ts:12-24,79]; [D: plugins › Configure] |
| 26 | `executionMode: "sequential"` | — | No equivalent. `Tool.Options` is `namespace`, `permission`, `codemode`, `pinned`. Tool calls in a step run as concurrent fibers. | ❌ | [S: schema tool.d.ts `Options`; core/src/session/runner/step.ts:118-128] |
| 27 | `promptSnippet` / `promptGuidelines` | — | No equivalent; fold into `description`. | ❌ | [T: promise/tool.d.ts] |
| 28 | plugin options | — | `ctx.options` (`Readonly<Record<string, any>>`) from `{ "package": …, "options": {…} }` in `opencode.json(c)`. | ✅ | [D: build/plugins › Options]; [T: options.d.ts] |

## 4. Gaps and proposed redesigns

### 4.1 Online Context Compact has no compaction trigger

In Pi, OCC is: detect a completed plan step → run the economic gate → `abort()` → `compact()` on `agent_settled` → send a hidden reminder with `triggerTurn`. In 2.0.18 the decision logic ports cleanly, but no public call can request compaction. Options:

- **A. Projection compaction (plugin-owned, public API only).** When the gate selects a boundary:
  1. Pick a cut point in `event.messages` that never separates a tool call from its result, keeping about `keepRecentTokens`.
  2. Produce a summary of the prefix with `ctx.session.generate({ sessionID, prompt })`. This sends the session's own system, tools, and transcript under the session's prompt-cache key [S: core/src/session/generate.ts:20-55; core/src/session/model-request.ts:252], so, like native summary compaction, it mostly reads cache. `ctx.generate.text` would pay full uncached input for the whole prefix, which `cacheWriteReadRatio` does not model.
  3. Store the summary and cut identity in `ctx.storage`.
  4. From then on, the `context` hook replaces the prefix with one summary message that also carries the plan-rebuild reminder.

  Properties:
  - History is never mutated.
  - No abort or continuation barrier: the run continues naturally.
  - A native `session.compaction.ended` resets our state.

  Costs and risks:
  - This is new design work, not a port.
  - Inserting a message needs an `@opencode/ai` `Message` value (the built-in Plan plugin uses `Message.user` [S: core/src/plugin/plan.ts:66]), so either add a dependency or clone an existing message instance (§8).
  - Message identity across requests (`Message.id` is optional) must be verified.
  - OpenCode's UI will not show these compactions.
- **B. Native compaction after an upstream change.** Ask OpenCode to add `"compact"` to the plugin `SessionDomain` pick. The client method and the server-side steer handling already exist. With it, OCC becomes `ctx.session.compact({ sessionID, delivery: "steer" })` at a selected boundary. No abort or barrier is needed (row 10). Only the post-compaction reminder remains, injected by the context hook. This is closest to upstream semantics and roughly 3× cheaper to build than A, but it depends on OpenCode.
- **C. Call the local server over HTTP. Rejected.** It would mean discovering the server URL and password from private files, which violates "public plugin API only".
- **D. Dry run.** Ship `update_plan` and state tracking, run the gate, and log decisions without compacting until B lands.

**Recommendation:** port the other three mechanisms first. For OCC, choose between **A** (if OCC must ship in this port) and **B + D** (if waiting for the upstream API is acceptable). The pure economics, plan, and state code is reused in every option.

Further differences, whichever option is chosen:

- OpenCode's retained tail defaults to `keep.tokens` 15,000; Pi's is 20,000.
- The auto-compaction buffer is **20,000** in code [S: core/src/session/compaction.ts:40], while the docs say "10% of the limit" [D: compaction › Settings]. That setting only affects when OpenCode compacts on its own.
- The plugin context cannot read `compaction.*` config (no config API on `ctx`), so the retained-tail value is a plugin constant. Pi likewise could not read its setting.
- `DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE = 1_000` should be re-checked: OpenCode's summary follows a structured template and the next request re-anchors on it [D: compaction › Summaries].

### 4.2 Promise tool failures are defects

`executePromiseTool = Effect.promise(signal => tool.execute(…))` [T: promise/adapter.js:444]. A rejected promise is therefore a *defect*. The runtime only maps typed failures to `Tool.Error` [S: core/src/tool/runtime.ts:37-44], `execute.after` only runs for success or typed failure [S: core/src/tool.ts:113-149], and defects are settled through the step's `failUnsettledTools` path [S: core/src/session/runner/step.ts:200-209,281-304]. There is no public way to return a typed failure from a Promise executor: `ToolContext` has no error helper and `Tool.Result` has no `isError`.

Consequences and proposals:

- **Action Fusion: use a hooks-only design (recommended; no new dependency).**
  - A `context` hook adds an optional `then_run` property to the advertised JSON schema of `edit` and `write`. Replacing the definition object is fine: OpenCode matches it back by key [S: core/src/session/model-request.ts:228-233]. This inherits the live built-in schema with no copy to drift.
  - `execute.before` removes `then_run` from the raw input and stashes it under the call ID. The built-in Effect `Struct` would otherwise ignore the extra key.
  - The **unmodified** built-in executor runs, so permissions, formatter, diff metadata, and typed failures are all preserved.
  - `execute.after` (`completed`) takes SoL's per-file queue, runs the hash guard, executes the command through the built-in `shell` executor, and appends `[then_run:succeeded]` or `[then_run:failed]` plus output to `event.result.content`.
  - On `error`, it appends `[then_run:skipped]` to `event.error`, as the Plan plugin does [S: core/src/plugin/plan.ts:45-55].

  Differences from upstream:
  - SoL's queue no longer surrounds the mutation itself. A competing fused mutation between write and command is still caught by the hash guard, which skips the command, so correctness holds but throughput under contention drops.
  - A failing command leaves the call `completed`, flagged by the marker and exit code, rather than an error, because `execute.after` cannot switch status.
  - Providers that enforce strict tool schemas may reject an optional property added this way. This must be tested per provider in Phase 2.

  The alternative is wrapping executors via `ctx.tool.transform`. That needs either a hand-copied JSON Schema of `edit`/`write` (drift risk) or a direct `effect` import to extend the `Struct`, plus an Effect-API executor to keep typed failures. Both mean a dependency beyond the allowed set.
- **`obs_recall` and `update_plan`:** do not throw on expected bad input (unknown ID, invalid plan). Return the error text as content. Throw only for internal faults.

### 4.3 EPR over `ctx.generate.text`

- **System prompt:** prepend `reducerInstructions()` to the single prompt string.
- **Output cap:** `maxOutputTokens = 2048` cannot be enforced. Input is still capped (`maxChars`, `minBytes`, `LIKELY_SECRET`, diagnostic-command gate). Output cost is bounded only by the model's own limit.
- **Usage and stop reason are unavailable.** Journal events and the receipt's `reducer_total_tokens` lose that data. Proposal: emit `reducer_total_tokens=unavailable` so the receipt format stays parseable. `ok` then relies on the existing JSON, schema, hash, and exact-quote validation, which already rejects truncated output.
- **No cancellation:** `timeoutMs` can race the promise and fall back to the original result, but the underlying call keeps running and costs money until the provider finishes.
- **Default route:** Pi's `openai-codex/gpt-5.6-luna` is not an OpenCode provider ID. Either default to an OpenCode route or require an explicit one when EPR is enabled (§8). An unavailable model surfaces as `ModelSelectionError`, which maps to the existing `reducer-model-unavailable` fallback.
- **Shell specifics:**
  - The tool name is `shell` and the command is `input.command`.
  - Failure is `metadata.exit !== 0 || metadata.timeout || metadata.signal`.
  - The exact log is the `sh_*.out` file named in the truncation notice. It must be read inside `execute.after`, because OpenCode deletes it once more than 25 exited shells are retained [S: core/src/shell.ts:32,168,378].
  - The SECURITY rule becomes: a regular, non-symlink `sh_*.out` directly inside `<OpenCode data>/shell/<ctx.location.project.id>/`.
- **Readback:** an archive outside the Location triggers v2's `external_directory` approval when the agent reads it with `read` or `shell` [S: core/src/tool/plugin/write.ts:1-6; file-access.ts]. Proposal: a small `evidence_recall` tool, paged exactly like `obs_recall`, with the receipt's `readback=` line pointing at it.

### 4.4 Storage root

There is no session directory. Proposal: byte archives (OP objects and ledger, EPR objects and journal) go under `<$XDG_DATA_HOME or ~/.local/share>/opencode/sol-opencode/<sessionID>/`. This mirrors where OpenCode keeps its own `tool-output/` and `shell/` data [S: core/src/tool-output.ts:53; util/src/global.ts]. The upstream code (`ensureStored`, `readRecallChunk`, `archiveBody`, O_NOFOLLOW, 0600) is then reused verbatim. OCC state and small indices go in `ctx.storage`.

Caveat: the data root is a replica of OpenCode's XDG logic, not a public API.

Alternative: store everything in `ctx.storage` (SQLite). That is public, but it means rewriting the archive and recall code, and receipts would have no file path.

### 4.5 Configuration resolution

- **Files, not merged:**
  1. `<ctx.location.directory>/.opencode/sol-pi.json`
  2. `<$OPENCODE_CONFIG_DIR ?? $XDG_CONFIG_HOME/opencode ?? ~/.config/opencode>/sol-pi.json`
  3. Defaults.
- **No trust gate.** v2 has none, and a project that can ship `sol-pi.json` can already ship `.opencode/plugins/*.ts`.
- **`ctx.options`, proposed rule:** if any SoL key is present in `options`, validate `options` as the *complete* effective config and ignore files. This keeps "one effective config, never merged". Otherwise use the file search.
- The schema, strict unknown-key rejection, defaults, and `cacheWriteReadRatio` semantics stay as upstream.

### 4.6 OCC state persistence

`appendEntry` custom entries become one versioned `OnlineState` per session in `ctx.storage` (`occ/<sessionID>`). `parseOnlineState` validation is reused verbatim. Other events:

- `session.revert.committed` → reset, the same as `recordCorrection`.
- `session.forked` → initial state for the child.
- `session.deleted` → remove the key.

State still never enters model context. Unlike Pi, it is not deleted with the session unless the plugin is running when the session is deleted.

### 4.7 Smaller gaps

- **Correction detection:** use the `prompt` hook together with busy tracking (row 18).
- **Sequential `update_plan`:** add a per-session promise mutex (row 26).
- **Savings notifications:** TUI is out of scope; record savings in the ledger instead.

## 5. Behaviour differences to carry into `docs/compatibility.md`

- **Action Fusion:**
  - `then_run.timeout` units (§8).
  - A failed command is `completed` with a `[then_run:failed]` marker, not an error.
  - Path resolution follows v2 (no `@` or `file://` handling).
  - The queue covers the hash guard and command, not the mutation.
- **ObservationPack:** results over 50 KiB or 2,000 lines are already truncated by OpenCode, which saves the full text to its own `tool-output/` file, before they reach the context hook. OP therefore archives OpenCode's truncated text for those, and applies its 10 KiB threshold to everything else.
- **EPR:** as §4.3 (no usage, no output cap, no cancellation, `shell` semantics, recall tool).
- **OCC:** as §4.1. It depends on the chosen option.
- **Context-usage estimate:** provider-counted tokens when a completed step exists. Otherwise the upstream JSON/4-chars estimate plus the system text.

## 6. Tests

| Upstream test | Verdict |
|---|---|
| `online-context-compact-economics`, `-plan` | Port verbatim |
| `online-context-compact-state` | Port; only the restore-from-`SessionEntry` cases change |
| `config`, `sol-pi-config-preflight` | Port with v2 paths plus new `options` cases |
| `observation-pack` | Port unit cases (thresholds, IDs, placeholder, recall paging, symlink/integrity); rewrite projection cases on a fake `ctx` |
| `evidence-preserving-reducer` | Port receipt, validation, and archive cases; rewrite candidate and provider cases (`shell`, `generate.text` fake) |
| `action-fusion` | Port queue and hash-guard cases; rewrite tool cases for the hooks-only design |
| `action-fusion-paths` | **Rewrite expectations** to v2 `resolvePath` semantics. Several upstream expectations become intentionally wrong (`@` prefix, `file://`, Unicode spaces). |
| `sol-pi-regression-stress` | Port the logic-level stress cases |
| `all-mechanisms`, `pi-package-integration`, `online-context-compact-agent-session`, `tui`, `install-guide`, `runtime-paths`, `package` | Replace with fake-`ctx` adapter tests and a package test. There is no Pi runtime to integrate with. |

The fake `ctx` implements only what the port uses:

- `tool.transform` (editor `add`/`get`/`update`/`list`) and `tool.hook`
- `session.hook`, `session.context`, `session.get`, `session.generate`
- `generate.text`, `storage`, `event.subscribe`, `model.list`
- `location`, `options`

All model calls are fakes, so the suite spends nothing.

## 7. Recommended order and effort

Estimates are focused engineering days, including tests. They assume 2.0.x does not break the hooks mid-port.

| Order | Work | Reuse | Effort | Main risks |
|---|---|---|---|---|
| 0 | Scaffold: package, `Plugin.define` entry, config loader, storage root, fake-`ctx` harness | config validation | 1–1.5 d | pinning `@opencode/plugin` versus the installed CLI |
| 1 | **ObservationPack** | `observation.ts`, `ledger.ts`, algorithm | 1.5–2 d | editing `Message` class instances in place; preserving `cache` hints on replaced parts |
| 2 | **Action Fusion** (hooks-only) | queue, hash guard, markers | 2–3 d | strict-schema providers; shell executor invocation from a plugin; stash keyed by call ID |
| 3 | **Evidence-Preserving Reducer** | receipt, archive, config, decision flow | 2–3 d | `generate.text` limits; shell output file lifetime; recall tool |
| 4a | **OCC via projection** (option A) | economics, plan, state | 5–8 d | cut-point correctness; cache-prefix alignment with OP; message identity; UX invisibility |
| 4b | **OCC via native compact** (option B, after upstream exposes it) | same | 2–3 d | upstream timing |
| 4d | **OCC dry run** (option D) | same | 1–2 d | — |
| 5 | Real-session verification (the user's steps 2–3) and `docs/compatibility.md` | — | 1–2 d | needs OpenCode 2.0.18 installed and a provider credential |

ObservationPack goes first. It makes no model calls, maps 1:1 onto `hook("context")`, and proves the message-projection code that OCC option A also needs. Action Fusion follows, completing the conservative profile the user's verification step 2 enables.

## 8. Decisions needed before Phase 2

1. **OCC strategy:** A (projection), B (wait for upstream `session.compact`, and should I draft the upstream issue text?), or D (dry run). Or skip OCC for now.
2. **Action Fusion design:** hooks-only (recommended, no new deps), or executor wrapping (needs `effect`).
3. **Dependencies:** the recommended designs need only `@opencode/plugin@2.0.18`, TypeScript, and Vitest. OCC option A needs an `@opencode/ai` `Message` value; is `@opencode/ai@2.0.18` (already a transitive dependency) acceptable, or should I clone existing message instances?
4. **Storage root:** files under OpenCode's XDG data directory (recommended), or `ctx.storage` only.
5. **Config:**
   - the `ctx.options`-replaces-files rule;
   - project path `<location>/.opencode/sol-pi.json`;
   - dropping the trust gate;
   - the EPR default route: pick an OpenCode `providerID/modelID`, or require one explicitly.
6. **`then_run.timeout` units:** ms (matches OpenCode's `shell`; recommended) or seconds (matches upstream).
7. **EPR readback:** add `evidence_recall` (recommended) or keep a filesystem path, which triggers `external_directory` approval.
8. **Repo layout and name:** the root is a verbatim SoL-Pi copy, and its `CLAUDE.md`/`AGENTS.md`/`agents-install.md` mandate the *Pi* install protocol. Proposal for Phase 2: replace the root with the new `sol-opencode` package (git history and `./upstream/` keep the Pi source) and rewrite those agent files for OpenCode.
9. **Live verification:** OpenCode is not installed here. May I run `npm install -g @opencode/cli@2.0.18`? Its postinstall selects a native binary. Which provider and model should the real-session checks use, given they cost money?
