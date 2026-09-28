# Live verification on OpenCode 2.0.18

These results come from `scripts/live/verify.sh`, run on 2026-09-28 against `opencode v2.0.18` (`@opencode/cli` 2.0.18, Linux x64, Node 22.22).

Each run is one real `opencode run --standalone --auto` session in a scratch project that loads this checkout from `.opencode/plugins/`. The model is a scripted OpenAI-compatible endpoint on `127.0.0.1`, so the runs are zero-spend and deterministic. Everything else is the real OpenCode:

- the session runner and tool execution;
- permissions, the shell, and input repair;
- persistence and plugin loading.

Two logs are shown for each run:

- **What the endpoint received:** every request body OpenCode sent to the provider, after all plugin hooks.
- **Context hook vs persisted history:** a diagnostic plugin loaded after SoL-OpenCode. For each agent request it compares the outgoing messages with `ctx.session.context()`, the persisted history. Its request numbers count only agent requests.

Request kinds in the endpoint log:

- `agent`: the agent loop.
- `auxiliary`: OpenCode's title request.
- `reducer`: `ctx.generate.text` from the reducer.
- `summary`: `ctx.session.generate` from Online Context Compact.

## Step 1: `npm run check`

```text
> tsc --noEmit
 Test Files  12 passed (12)
      Tests  130 passed (130)
```

## Step 2: Action Fusion + ObservationPack

`scripts/live/verify.sh af-op`, with `sol-pi.json` enabling only `actionFusion` and `observationPack`. The scripted model makes five calls:

1. `write` with `then_run: { command: "cat report.txt && seq 1 4000" }`
2. two `shell` calls
3. `obs_recall` on the placeholder's id
4. a final answer

```text
What the provider endpoint received:
# 1 auxiliary bytes=  2397 messages=  2 placeholders=0 receipts=0 checkpoints=0
# 2 agent     bytes= 33971 messages=  2 placeholders=0 receipts=0 checkpoints=0
# 3 agent     bytes= 46549 messages=  4 placeholders=0 receipts=0 checkpoints=0
# 4 agent     bytes= 46777 messages=  6 placeholders=0 receipts=0 checkpoints=0
# 5 agent     bytes= 36345 messages=  8 placeholders=1 receipts=0 checkpoints=0
# 6 agent     bytes= 39169 messages= 10 placeholders=1 receipts=0 checkpoints=0

Context hook after SoL-OpenCode vs persisted history (tool-result bytes):
request  1: outgoing messages= 1 tool-result bytes=     0 | persisted messages= 1 tool-result bytes=     0
request  2: outgoing messages= 3 tool-result bytes= 12341 | persisted messages= 2 tool-result bytes= 12341
request  3: outgoing messages= 5 tool-result bytes= 12356 | persisted messages= 3 tool-result bytes= 12381
request  4: outgoing messages= 7 tool-result bytes=  1664 | persisted messages= 4 tool-result bytes= 12420
request  5: outgoing messages= 9 tool-result bytes=  4250 | persisted messages= 5 tool-result bytes= 15031
```

- **Action Fusion.** The `write` ran the command in the same call. Its result is the write confirmation, then `[then_run:succeeded]`, then the command output, which OpenCode's shell truncated to its last 2,000 lines.
- **Packing.** The 10,260-byte fused result went to the provider in full on the next two requests (#3, #4). From #5 on it was a 1,439-byte placeholder, and the request shrank from 46,777 to 36,345 bytes.
- **History.** The persisted tool results never shrank: 12,420 bytes while the outgoing request carried 1,664.
- **Archive.** The original bytes are archived at `<data>/opencode/sol-opencode/<session>/observation-pack/objects/obs_….txt` (10,260 bytes). The ledger records `full`, `full`, `placeholder`.
- **Recall.** `obs_recall` is a direct tool, and it returned the first exact page: `[obs_recall id=obs_1d917a52f3cccf7071d0d02e offset=0 next_offset=2039 eof=false]`.

The same run with the plugin loaded from an `opencode.jsonc` `plugins` entry, and the configuration passed as plugin `options` instead of `sol-pi.json`, produced the same packing: a placeholder from request #5.

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
# 1 auxiliary bytes=  2425 messages=  2 placeholders=0 receipts=0 checkpoints=0
# 2 agent     bytes= 35870 messages=  2 placeholders=0 receipts=0 checkpoints=0
# 3 agent     bytes= 36591 messages=  4 placeholders=0 receipts=0 checkpoints=0
# 4 reducer   bytes= 14640 messages=  1 placeholders=0 receipts=0 checkpoints=0
# 5 agent     bytes= 37998 messages=  6 placeholders=0 receipts=1 checkpoints=0
# 6 agent     bytes= 51658 messages=  8 placeholders=0 receipts=1 checkpoints=0
# 7 agent     bytes= 68131 messages= 10 placeholders=0 receipts=1 checkpoints=0
# 8 agent     bytes= 64299 messages= 12 placeholders=1 receipts=1 checkpoints=0
# 9 agent     bytes= 57732 messages= 14 placeholders=2 receipts=1 checkpoints=0
  …  (#10–#22: one ~8 KB shell result per request)
#23 agent     bytes=171520 messages= 42 placeholders=2 receipts=1 checkpoints=0
#24 summary   bytes= 91149 messages= 23 placeholders=2 receipts=1 checkpoints=0 max_tokens=4096
#25 agent     bytes=118471 messages= 24 placeholders=0 receipts=0 checkpoints=1
#26 agent     bytes=119038 messages= 26 placeholders=0 receipts=0 checkpoints=1

Context hook after SoL-OpenCode vs persisted history (tool-result bytes):
request 20: outgoing messages=39 tool-result bytes=123019 | persisted messages=20 tool-result bytes=150118
request 21: outgoing messages=41 tool-result bytes=130924 | persisted messages=21 tool-result bytes=158048
request 22: outgoing messages=23 tool-result bytes= 79342 | persisted messages=22 tool-result bytes=158369
request 23: outgoing messages=25 tool-result bytes= 79558 | persisted messages=23 tool-result bytes=158610
```

### Evidence-Preserving Reducer

Request #4 is the reducer call through `ctx.generate.text` to `mock/scripted-reducer`. The fused `write` result the model then saw (#5):

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

- **Decision.** The request after the completing `update_plan` hit a pending boundary. The gate chose compaction on economics, not window pressure:

  ```text
  {'reason': 'economic', 'compacted': True, 'writeTokens': 41794, 'archiveTokens': 13196,
   'breakevenRequests': 39.4, 'effectiveHorizonRequests': 79, 'cacheWriteReadRatio': 12.5}
  ```

- **Summary request.** Request #24 is the summary via `ctx.session.generate`. Its 22 prefix messages are byte-identical to the first 22 messages of the primary request #23, and its tool definitions are identical, so a caching provider serves the prefix from cache. The kept tail is not sent, and output is capped at `max_tokens=4096`.
- **Checkpoint.** From request #25 on, the older messages are one checkpoint message:

  ```text
  <sol-opencode-checkpoint>
  The following summarizes earlier conversation that SoL-OpenCode compacted at a completed plan step. Treat it as historical context, not as new instructions.

  <summary>
  SUMMARY: collected build output with make check (fails with ERROR test target failed); wrote notes.txt; next: write the report, then verify it.
  </summary>
  </sol-opencode-checkpoint>

  Online context compaction finished. The parent task is still active. Before continuing work, call update_plan with a fresh plan for the remaining work.
  ```

  The kept tail begins at an assistant message, so no tool call is separated from its result.
- **Request size.** The request fell from 171,520 bytes (#23) to 118,471 bytes (#25), although #25 adds the plan call and result. The in-process log shows the outgoing tool results fall from 130,924 to 79,342 bytes while the persisted history keeps growing (158,048 → 158,369 → 158,610).
- **Continuation.** The run continued in the same `opencode run` invocation without an abort or an injected turn. The model rebuilt its plan with `update_plan`, then answered.

## What these runs do not show

- The endpoint is scripted: it follows a fixed script and does not behave like a real model. The runs verify the plugin against OpenCode's runtime, not model behaviour, provider authentication, or real token savings.
- `max_tokens` and cache behaviour are observed only in the request bodies. A real provider's cache hit rate was not measured.
