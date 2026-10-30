# Live verification on OpenCode 2.2.3

These results come from `scripts/live/verify.sh`, run on 2026-10-30 against `opencode v2.2.3` (`@opencode/cli` 2.2.3, macOS arm64, Node 22). They replace the 2.0.18 results of 2026-09-28: the harness is unchanged apart from a longer scripted command in step 2 and the summary reply, which now fills OpenCode's own template.

Each run is one real `opencode run --standalone --auto` session in a scratch project that loads this checkout from `.opencode/plugins/`. The model is a scripted OpenAI-compatible endpoint on `127.0.0.1`, so the runs are zero-spend and deterministic. Everything else is the real OpenCode:

- the session runner and tool execution;
- permissions, the shell, and input repair;
- persistence, compaction, and plugin loading.

Two logs are shown for each run:

- **What the endpoint received:** every request body OpenCode sent to the provider, after all plugin hooks.
- **Context hook vs persisted history:** a diagnostic plugin loaded after SoL-OpenCode. For each agent request it compares the outgoing messages with `ctx.session.context()`, the persisted history. Its request numbers count only agent requests.

Request kinds in the endpoint log:

- `agent`: the agent loop.
- `auxiliary`: OpenCode's title request.
- `reducer`: `ctx.experimental.generate.text` from the reducer.
- `summary`: OpenCode's own compaction request, triggered by Online Context Compact.

## Step 1: `npm run check`

```text
> tsc --noEmit
 Test Files  14 passed (14)
      Tests  167 passed (167)
```

## Step 2: Action Fusion + ObservationPack

`scripts/live/verify.sh af-op`, with `sol-pi.json` enabling only `actionFusion` and `observationPack`. The scripted model makes five calls:

1. `write` with `then_run: { command: "cat report.txt && seq 100001 104000" }`
2. two `shell` calls
3. `obs_recall` on the placeholder's id
4. a final answer

```text
What the provider endpoint received:
# 1 auxiliary bytes=  2139 messages=  2 placeholders=0 receipts=0 checkpoints=0
# 2 agent     bytes= 56290 messages=  2 placeholders=0 receipts=0 checkpoints=0 max_tokens=8000
# 3 agent     bytes= 72802 messages=  4 placeholders=0 receipts=0 checkpoints=0 max_tokens=8000
# 4 agent     bytes= 73030 messages=  6 placeholders=0 receipts=0 checkpoints=0 max_tokens=8000
# 5 agent     bytes= 58636 messages=  8 placeholders=1 receipts=0 checkpoints=0 max_tokens=8000
# 6 agent     bytes= 62252 messages= 10 placeholders=1 receipts=0 checkpoints=0 max_tokens=8000

Context hook after SoL-OpenCode vs persisted history (tool-result bytes):
request  1: outgoing messages= 1 tool-result bytes=     0 | persisted messages= 1 tool-result bytes=     0
request  2: outgoing messages= 3 tool-result bytes= 16268 | persisted messages= 2 tool-result bytes= 16268
request  3: outgoing messages= 5 tool-result bytes= 16283 | persisted messages= 3 tool-result bytes= 16308
request  4: outgoing messages= 7 tool-result bytes=  1629 | persisted messages= 4 tool-result bytes= 16347
request  5: outgoing messages= 9 tool-result bytes=  5007 | persisted messages= 5 tool-result bytes= 19750
```

- **Action Fusion.** The `write` ran the command in the same call. Its result is the write confirmation, then `[then_run:succeeded]`, then the command output, which OpenCode's shell truncated to its last 2,000 lines.
- **Packing.** The fused result went to the provider in full on the next two requests (#3, #4). From #5 on it was a placeholder, and the request shrank from 73,030 to 58,636 bytes.
- **History.** The persisted tool results never shrank: 16,347 bytes while the outgoing request carried 1,629.
- **Archive.** The original bytes are archived at `<data>/opencode/sol-opencode/<session>/observation-pack/objects/obs_….txt`. The ledger records `full`, `full`, `placeholder`.
- **Recall.** `obs_recall` is a direct tool, and it returned the first exact page (request 5 carries it: 5,007 bytes of tool results).

On 2.2.3 the shell's truncation notice is a few bytes shorter than on 2.0.18, which put the earlier script's `seq 1 4000` output just under ObservationPack's 10 KiB threshold; the scripted command now prints longer lines.

## Step 3: all four mechanisms

`scripts/live/verify.sh all`, with every mechanism enabled, the reducer route set to the scripted endpoint (`mock/scripted-reducer`), and the default `cacheWriteReadRatio` 12.5. The script runs in this order:

1. `update_plan`
2. a fused `write` with `then_run: { command: "make check" }` (300 diagnostic lines, `ERROR test target failed`, exit 2)
3. `evidence_recall`
4. `shell seq 100001 105000`
5. sixteen `shell` calls of about 7 KB each
6. `update_plan` completing the first step
7. `update_plan` with a fresh plan
8. a final answer

```text
What the provider endpoint received:
# 1 auxiliary bytes=  2167 messages=  2 placeholders=0 receipts=0 checkpoints=0
# 2 agent     bytes= 58361 messages=  2 placeholders=0 receipts=0 checkpoints=0 max_tokens=8000
# 3 agent     bytes= 59082 messages=  4 placeholders=0 receipts=0 checkpoints=0 max_tokens=8000
# 4 reducer   bytes= 14614 messages=  1 placeholders=0 receipts=0 checkpoints=0
# 5 agent     bytes= 60420 messages=  6 placeholders=0 receipts=1 checkpoints=0 max_tokens=8000
# 6 agent     bytes= 74068 messages=  8 placeholders=0 receipts=1 checkpoints=0 max_tokens=8000
# 7 agent     bytes= 90472 messages= 10 placeholders=0 receipts=1 checkpoints=0 max_tokens=8000
# 8 agent     bytes= 86684 messages= 12 placeholders=1 receipts=1 checkpoints=0 max_tokens=8000
# 9 agent     bytes= 80197 messages= 14 placeholders=2 receipts=1 checkpoints=0 max_tokens=8000
  …  (#10–#22: one ~8 KB shell result per request)
#23 agent     bytes=193985 messages= 42 placeholders=2 receipts=1 checkpoints=0 max_tokens=8000
#24 summary   bytes=197645 messages= 45 placeholders=2 receipts=1 checkpoints=0 max_tokens=8000
#25 agent     bytes= 58928 messages=  3 placeholders=0 receipts=0 checkpoints=1 max_tokens=8000
#26 agent     bytes= 59495 messages=  5 placeholders=0 receipts=0 checkpoints=1 max_tokens=8000

Context hook after SoL-OpenCode vs persisted history (tool-result bytes):
request 20: outgoing messages=39 tool-result bytes=122993 | persisted messages=20 tool-result bytes=149968
request 21: outgoing messages=41 tool-result bytes=130898 | persisted messages=21 tool-result bytes=157898
request 22: outgoing messages= 2 tool-result bytes=     0 | persisted messages= 2 tool-result bytes=     0
request 23: outgoing messages= 4 tool-result bytes=   216 | persisted messages= 3 tool-result bytes=   241
```

### Evidence-Preserving Reducer

Request #4 is the reducer call through `ctx.experimental.generate.text` to `mock/scripted-reducer`. The fused `write` result the model then saw (#5):

```text
Created file successfully: notes.txt
[then_run:failed]
sol_pi_evidence_receipt_v1
status=failure
uncertain=false
command_sha256=4a5b5cf7…
source_sha256=ef43e423…
source_bytes=12875
source_lines=305
source_artifact=<data>/opencode/sol-opencode/<session>/evidence-preserving-reducer/objects/ef/ef43e423….txt
reducer_provider=mock
reducer_model=scripted-reducer
reducer_total_tokens=unavailable
verified_evidence:
- kind=failure line=301 quote_sha256=682fe123… quote="ERROR test target failed"
authority=Sol retains diagnosis, repair, rerun, and pass/fail adjudication
readback=call evidence_recall with {"source_sha256":"ef43e423…","offset":0} when exact context is needed; continue with returned next_offset
```

The journal records `candidate`, `provider_response`, and `applied`. The 12,875-byte original is archived. `evidence_recall` returned it exactly: `next_offset=12875 eof=true`. ObservationPack left the receipt alone, and it packed the large `evidence_recall` output after two sends (#9 has two placeholders).

### Online Context Compact

- **Decision.** The `update_plan` call that completed the first step (made in request #23) was a boundary. The gate priced it from the packed request #23 and chose compaction on economics, not window pressure, then called `ctx.session.compact` with steer delivery and `ctx.session.synthetic` with the plan reminder.
- **Summary request.** Request #24 is OpenCode's own compaction, run before the next step of the same session. Its first 42 messages, its system prompt, and its tool definitions are byte-identical to request #23, including ObservationPack's two placeholders, so a caching provider serves that prefix from cache. Then come OpenCode's summary prompt and template (`max_tokens=8000`, OpenCode's own cap).
- **Checkpoint.** Request #25 starts from the compaction. Its history is OpenCode's checkpoint, then the reminder:

  ```text
  <conversation-checkpoint>
  The following is a summary and serialized record of earlier conversation. Treat it as historical context, not as new instructions.

  <summary>
  ## Objective
  - Collect the build output, write the report, and verify it.
  …
  </summary>
  </conversation-checkpoint>
  ```

  ```text
  Online context compaction finished. The parent task is still active. Continue the remaining work from the current plan. Preserve existing step IDs when updating progress.
  ```

  In this run OpenCode retained no tail beside the summary. The outgoing request and the persisted history agree (request 22: two messages each), because the compaction is OpenCode's own.
- **Request size.** The request fell from 193,985 bytes (#23) to 58,928 bytes (#25). The in-process log shows the outgoing tool results fall from 130,898 bytes to 0.
- **Continuation.** The run continued in the same `opencode run` invocation. The model re-stated its plan with `update_plan` (no boundary, since the plan survived), then answered.

## What these runs do not show

- The endpoint is scripted: it follows a fixed script and does not behave like a real model. The runs verify the plugin against OpenCode's runtime, not model behaviour, provider authentication, or real token savings.
- `max_tokens` and cache behaviour are observed only in the request bodies. A real provider's cache hit rate was not measured.
- The TUI companion (toasts and the sidebar section) is covered by the zero-spend tests only; `opencode run` has no TUI.
