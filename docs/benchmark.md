# Savings on Terminal-Bench 2.0 and SWE-bench Verified

These results come from [`bench/`](../bench/README.md), run on 2026-11-02 with OpenCode 2.2.3 and Claude Sonnet 5.5. Each run is one real OpenCode session in a benchmark task container, with one on/off combination of the four mechanisms, graded by the benchmark's own tests. The results are indicative, not a controlled study: there is one run per task and combination.

**With Sonnet 5.5, no mechanism lowered cost or changed success beyond run-to-run noise.** Online Context Compact and the reducer never acted, and Action Fusion acted in a few runs. ObservationPack acted in most Terminal-Bench runs, and there its cache rewrites cost more than it saved.

## Setup

- **Terminal-Bench 2.0:** regex-chess, circuit-fibsqrt, make-mips-interpreter, path-tracing and schemelike-metacircular-eval, long tasks (expert estimates of 5 to 24 hours) with small prebuilt images. A pilot ran `none` and all four mechanisms once on each task, then the grid ran all 16 combinations once: 90 runs.
- **SWE-bench Verified:** django__django-13128, sympy__sympy-13852, pytest-dev__pytest-5787, sphinx-doc__sphinx-9461 and pydata__xarray-6992, five of the 45 tasks its annotators rated "1-4 hours" or ">4 hours", one per repository. All 16 combinations once: 80 runs.
- **Agent:** `opencode run --standalone --auto` with `anthropic/claude-sonnet-5-5` and the plugin at 7725137. The reducer used `claude-haiku-5-5`, and `cacheWriteReadRatio` was 25, Sonnet 5.5's cache-write to cache-read price ratio.
- **The same for every combination:** no title request, no web fetch or web search, no LSP or formatter, and each task's own agent and verifier timeouts.
- **Cost:** a local proxy logged the provider-reported usage of every request, reducer and compaction requests included, and priced it at models.dev's prices of 2026-11-02. For Sonnet 5.5, per million tokens: $2 input, $10 output, $0.10 cache read, $2.50 cache write.
- **Host:** an Apple silicon Mac with OrbStack and Harbor 0.25.0, running 4 to 10 trials at a time. Rosetta was off in OrbStack, so the x86-64 task images ran under QEMU.

The whole sweep, pilots and smoke tests included, cost $65.08.

## Results by combination

`none` is plain OpenCode without the plugin. **Cost vs none** divides a combination's cost by `none`'s on the same task and takes the geometric mean over the five tasks. One expensive task can dominate the mean cost, so the two cost columns can disagree.

### Terminal-Bench 2.0

90 runs, $54.32.

| Combination | Runs | Mean cost | Cost vs none | Mean requests | Solved |
|---|--:|--:|--:|--:|--:|
| none | 10 | $0.523 | +0% | 18 | 8/10 |
| af | 5 | $0.520 | -5% | 21 | 4/5 |
| epr | 5 | $0.554 | -1% | 17 | 4/5 |
| occ | 5 | $0.582 | -14% | 14 | 4/5 |
| op | 5 | $0.610 | +11% | 20 | 4/5 |
| af+epr | 5 | $0.483 | -17% | 14 | 4/5 |
| af+occ | 5 | $0.572 | +3% | 24 | 4/5 |
| af+op | 5 | $0.444 | -18% | 14 | 4/5 |
| epr+occ | 5 | $0.559 | +3% | 17 | 4/5 |
| op+epr | 5 | $1.172 | +73% | 31 | 4/5 |
| op+occ | 5 | $0.666 | +16% | 20 | 3/5 |
| af+epr+occ | 5 | $0.570 | +4% | 15 | 4/5 |
| af+op+epr | 5 | $0.679 | +5% | 18 | 4/5 |
| af+op+occ | 5 | $0.561 | -11% | 16 | 4/5 |
| op+epr+occ | 5 | $0.525 | +2% | 17 | 4/5 |
| af+op+epr+occ | 10 | $0.660 | +16% | 19 | 8/10 |

The +73% of `op+epr` comes from three long runs of 42, 42 and 50 requests, on tasks where `none` took 7 to 19.

### SWE-bench Verified

80 runs, $9.74.

| Combination | Runs | Mean cost | Cost vs none | Mean requests | Solved |
|---|--:|--:|--:|--:|--:|
| none | 5 | $0.123 | +0% | 14 | 2/5 |
| af | 5 | $0.123 | +2% | 13 | 3/5 |
| epr | 5 | $0.113 | -5% | 12 | 1/5 |
| occ | 5 | $0.121 | +0% | 13 | 2/5 |
| op | 5 | $0.120 | -3% | 12 | 2/5 |
| af+epr | 5 | $0.116 | -1% | 12 | 2/5 |
| af+occ | 5 | $0.122 | +1% | 12 | 2/5 |
| af+op | 5 | $0.114 | -6% | 11 | 4/5 |
| epr+occ | 5 | $0.120 | -1% | 12 | 2/5 |
| op+epr | 5 | $0.121 | -7% | 14 | 2/5 |
| op+occ | 5 | $0.112 | -13% | 12 | 3/5 |
| af+epr+occ | 5 | $0.126 | +4% | 13 | 2/5 |
| af+op+epr | 5 | $0.127 | +3% | 14 | 2/5 |
| af+op+occ | 5 | $0.122 | -3% | 13 | 2/5 |
| op+epr+occ | 5 | $0.139 | +13% | 14 | 2/5 |
| af+op+epr+occ | 5 | $0.127 | +1% | 13 | 2/5 |

### By task

Whether a task was solved depended mostly on the task, not on the combination.

| Task | Runs | Solved | Cost per run | Requests per run |
|---|--:|--:|--:|--:|
| circuit-fibsqrt | 18 | 18 | $0.12 to $0.18 | 4 to 10 |
| make-mips-interpreter | 18 | 0 | $0.34 to $0.83 | 13 to 42 |
| path-tracing | 18 | 18 | $0.19 to $0.93 | 10 to 50 |
| regex-chess | 18 | 18 | $0.53 to $1.83 | 6 to 42 |
| schemelike-metacircular-eval | 18 | 17 | $0.56 to $2.53 | 10 to 50 |
| django__django-13128 | 16 | 16 | $0.08 to $0.12 | 9 to 15 |
| pydata__xarray-6992 | 16 | 0 | $0.03 to $0.07 | 6 to 8 |
| pytest-dev__pytest-5787 | 16 | 2 | $0.12 to $0.18 | 10 to 19 |
| sphinx-doc__sphinx-9461 | 16 | 15 | $0.09 to $0.22 | 10 to 24 |
| sympy__sympy-13852 | 16 | 2 | $0.10 to $0.17 | 9 to 17 |

## Average effect of each mechanism

For each task, the geometric mean cost of the runs with the mechanism on is divided by that of the runs with it off, then the geometric mean is taken over the tasks. That is 9 runs against 9 per Terminal-Bench task (with the pilot), and 8 against 8 per SWE-bench task.

| Mechanism | Terminal-Bench cost | Solved with / without (of 45) | SWE-bench cost | Solved with / without (of 40) |
|---|--:|--:|--:|--:|
| Action Fusion | -9% | 36 / 35 | +3% | 19 / 16 |
| ObservationPack | +14% | 35 / 36 | -2% | 19 / 16 |
| Evidence-Preserving Reducer | +12% | 36 / 35 | +4% | 15 / 20 |
| Online Context Compact | +1% | 35 / 36 | +2% | 17 / 18 |

## Noise

- **Repeats:** two runs of the same task and combination differed in cost by a median of 20% on Terminal-Bench (10 pairs, up to 2.6×) and 14% on SWE-bench (8 pairs, up to 1.45×). The SWE-bench repeats come from two earlier pilot jobs that are not in the tables above.
- **Mechanisms that never acted:** the reducer and Online Context Compact did nothing in any run, so their rows above show noise plus the cost of their tool definitions: +12% and +1% on Terminal-Bench, +4% and +2% on SWE-bench, and 15 against 20 solved SWE-bench runs for the reducer.

## Mechanism activity

| Mechanism | Terminal-Bench: runs with an action | Actions per such run | SWE-bench: runs with an action | Actions per such run |
|---|--:|--:|--:|--:|
| Action Fusion | 4/45 | 1.0 | 2/40 | 1.0 |
| ObservationPack | 27/45 | 2.2 | 14/40 | 1.0 |
| Evidence-Preserving Reducer | 0/45 | - | 0/40 | - |
| Online Context Compact | 0/45 | - | 0/40 | - |

These are the SoL-Pi paper's trigger rate and trigger intensity (section 3.4), over the runs with the mechanism enabled. An action is a fused `then_run`, a packed observation, a verified reducer receipt or a compaction.

- No run made a reducer request or a compaction request, OpenCode's own automatic compaction included. The largest request was 666 KB, well inside Sonnet 5.5's 1M-token context window.
- The model read packed observations back with `obs_recall` 13 times, all on Terminal-Bench.

## Why the mechanisms rarely act

These figures come from the runs' OpenCode event streams.

- **Online Context Compact:** Sonnet never called `update_plan` (0 of 85 runs), so there was never a completed plan step to compact at. SoL-Pi gives Pi prompt guidelines for `update_plan`. OpenCode has no counterpart, so this port puts the same guidance in the tool description ([`src/online-context-compact/tools.ts`](../src/online-context-compact/tools.ts)).
- **Action Fusion:** Sonnet passed `then_run` 6 times in 85 runs. It edits a file and runs the follow-up command as two calls.
- **ObservationPack:** 5.5% (Terminal-Bench) and 2.8% (SWE-bench) of tool results reached its 10 KiB threshold. Sonnet trims its own output: 51% and 76% of its shell commands pipe through `tail`, `head`, `grep`, `sed`, `awk`, `cut` or `wc`.
- **Evidence-Preserving Reducer:** it reduces only output of at least 4 KiB from a command on its list (`pytest`, `python -m pytest`, `make`, `cargo test` and similar). On Terminal-Bench the agent ran its own scripts, and 1 of 1,438 shell calls matched the list. On SWE-bench 214 matched, but only 1 printed 4 KiB, because Sonnet had trimmed the rest.
- **Fixed overhead:** the tool definitions the mechanisms add go into every request: Action Fusion 1,157 bytes, ObservationPack 476, the reducer 535 and Online Context Compact 1,424, so 3,592 bytes (about 900 tokens) for all four. With prompt caching that is under half a cent per run.

Sonnet also called a `bash` tool, which OpenCode does not have, 73 times (and `bash_tool` once). Each such call fails and costs a request, with or without the plugin.

## ObservationPack and the prompt cache

Replacing a result with a placeholder changes the prompt from that point on, so the provider writes everything after it to the cache again. On Sonnet 5.5 a cache write costs 25 times a cache read.

- **Cache writes:** requests in which ObservationPack replaced a result wrote a median of 9,173 cache tokens on Terminal-Bench, against 1,378 for the other requests of the same runs (5,452 against 862 on SWE-bench).
- **Cost and saving:** matching ObservationPack's ledger to those requests, the replacements added about 390,000 cache-write tokens on Terminal-Bench, about $0.8 to $0.9 more than reading them. The 2.0 million tokens they kept out of later requests saved $0.20 at the cache-read price. On SWE-bench it was $0.13 against $0.03.
- **Break-even:** at these averages, one replacement pays for itself after about 50 more requests. The Terminal-Bench runs made about 19 requests on average in total.

The paper describes the same trade (section 3.4, "Cache Reuse and Total Cost"): cache writes go up and cache reads go down, and on EdgeBench's long sessions the total cost falls. Online Context Compact prices this rewrite with `cacheWriteReadRatio` before it compacts. ObservationPack replaces after a fixed two sends.

## Compared with the SoL-Pi paper

The [SoL-Pi paper](https://arxiv.org/abs/2609.20519) reports large savings on Pi:

- **EdgeBench** (Table 4): the full stack cost 33.2% less than Pi under GPT-5.6 Sol and 33.5% less under Opus 5. Under Opus 5, ObservationPack alone saved 32.5%.
- **Terminal-Bench 4** (Table 3, 63 CPU-only tasks): 26.3% less total cost than Pi, with 15 tasks solved against Pi's 18.

The likely reasons for the gap:

- **Session length:** under GPT-5.6 Sol, Pi's EdgeBench runs carried 2.15 billion tokens, tens of millions per task, almost all of it cache reads. The runs here carried 0.8 million tokens per Terminal-Bench run and 0.2 million per SWE-bench run.
- **Backend:** the paper finds lower trigger rates and intensity under Opus 5 than under GPT-5.6 Sol, the backend the mechanisms were found on (section 3.4), and reports that prompt-only triggering of Action Fusion was unreliable (section 3.5).

EdgeBench and Terminal-Bench 4 are not in Harbor's registry. The paper's search environments use Terminal-Bench 2's verifier interface (section 2.3), so Terminal-Bench 2.0 is the closest available.

## What these runs do not show

- **Precision:** there is one run per task and combination, two for `none` and all four on Terminal-Bench. Single runs often differ by 20% or more.
- **Other models:** only Sonnet 5.5 was measured. The mechanisms were developed on GPT-5.6 Sol and may act far more often there.
- **Long sessions:** the runs made 4 to 50 requests. Sessions of hundreds of requests with a large accumulated context, where the paper's savings come from, were not measured.
- **Wall-clock time:** QEMU slowed builds, tests and grading, and 8 Terminal-Bench runs hit their agent timeout, 7 of them on schemelike-metacircular-eval. All combinations ran under the same conditions.
- **Billing:** costs are provider-reported usage at list prices, not an invoice.
