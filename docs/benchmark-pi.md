# SoL-Pi on Pi with Claude Sonnet 5.5: upstream main against PR #121

These results come from [`bench/sweep_pi.py`](../bench/README.md#pi-sweep), run on 2026-11-03 with Pi 1.3.0 and Claude Sonnet 5.5 (thinking `medium`, Pi's cache warming off). Each run is one `pi --mode json` session in a benchmark task container, graded by the benchmark's own tests. There is one run per task and arm, so the numbers carry the same run-to-run noise as [benchmark.md](benchmark.md): single runs often differ by 20% or more.

- **Tasks:** the same five Terminal-Bench 2.0 and five SWE-bench Verified tasks as the OpenCode sweep.
- **Arms:** `none` is plain Pi. `main` is upstream SoL-Pi at 2195680. `pr` is [NVlabs/SoL-Pi#121](https://github.com/NVlabs/SoL-Pi/pull/121) at b3ed060, which replaces large results from the second provider request instead of the third; that revision also added two system-prompt rules asking for `then_run` and `update_plan`, which were dropped from the PR after this sweep. Each tree ran with ObservationPack alone (`op`) and with all four mechanisms (`cacheWriteReadRatio` 25, reducer `claude-haiku-5-5`).
- **Cost:** the metering proxy, priced as in benchmark.md. The whole sweep cost $9.35.

**Findings.** The arms are within noise of each other on total cost. ObservationPack replaced a result in 2 of 20 `main` runs and 4 of 20 `pr` runs; on the requests where a placeholder first appeared, `main` wrote 10.2k and 10.9k cache tokens (one replacement each) and `pr` a median of 6.2k over six replacements and 3.7k on the seventh, which is the second-send effect. The prompt rules were in every `pr` request (its first request is 410 bytes larger than `main`'s on all ten tasks) and changed nothing: `update_plan` was called in 0 of 10 runs with Online Context Compact on both trees, and `then_run` was never passed. In all 50 runs Sonnet never called Pi's `edit` or `write` tools at all; it wrote and patched files through bash heredocs (32 to 57 of each arm's roughly 90 bash calls), so Action Fusion had nothing to fuse. One regex-chess run of `pr:op` hit the 60-minute agent timeout at $1.30 and got no verdict.

50 runs, $9.35 metered in total.

## Runs

| Task | Arm | Cost | Requests | Output tok | Peak request | Minutes | Resolved | Fired: fused / packed / reduced / plans / recalls / compactions | Error |
|---|---|--:|--:|--:|--:|--:|:-:|---|---|
| circuit-fibsqrt | main:af+op+epr+occ | $0.108 | 4 | 7,604 | 47 KB | 1.4 | yes | 0 / 0 / 0 / 0 / 0 / 0 |  |
| circuit-fibsqrt | main:op | $0.065 | 3 | 4,367 | 33 KB | 1.0 | yes | 0 / 0 / 0 / 0 / 0 / 0 |  |
| circuit-fibsqrt | none | $0.067 | 3 | 4,511 | 33 KB | 1.0 | yes | 0 / 0 / 0 / 0 / 0 / 0 |  |
| circuit-fibsqrt | pr:af+op+epr+occ | $0.073 | 3 | 4,954 | 38 KB | 1.1 | yes | 0 / 0 / 0 / 0 / 0 / 0 |  |
| circuit-fibsqrt | pr:op | $0.122 | 7 | 9,144 | 55 KB | 2.2 | yes | 0 / 0 / 0 / 0 / 0 / 0 |  |
| django__django-13128 | main:af+op+epr+occ | $0.020 | 5 | 1,195 | 17 KB | 0.4 | yes | 0 / 0 / 0 / 0 / 0 / 0 |  |
| django__django-13128 | main:op | $0.030 | 6 | 1,683 | 20 KB | 0.5 | yes | 0 / 0 / 0 / 0 / 0 / 0 |  |
| django__django-13128 | none | $0.032 | 6 | 1,693 | 22 KB | 0.5 | yes | 0 / 0 / 0 / 0 / 0 / 0 |  |
| django__django-13128 | pr:af+op+epr+occ | $0.027 | 6 | 1,509 | 20 KB | 0.6 | yes | 0 / 0 / 0 / 0 / 0 / 0 |  |
| django__django-13128 | pr:op | $0.025 | 6 | 1,480 | 22 KB | 0.5 | yes | 0 / 0 / 0 / 0 / 0 / 0 |  |
| make-mips-interpreter | main:af+op+epr+occ | $0.175 | 9 | 10,367 | 68 KB | 2.7 | no | 0 / 0 / 0 / 0 / 0 / 0 |  |
| make-mips-interpreter | main:op | $0.240 | 12 | 14,373 | 195 KB | 4.0 | no | 0 / 0 / 0 / 0 / 0 / 0 |  |
| make-mips-interpreter | none | $0.296 | 18 | 16,219 | 218 KB | 8.6 | no | 0 / 0 / 0 / 0 / 0 / 0 |  |
| make-mips-interpreter | pr:af+op+epr+occ | $0.247 | 11 | 15,082 | 199 KB | 3.1 | no | 0 / 0 / 0 / 0 / 0 / 0 |  |
| make-mips-interpreter | pr:op | $0.202 | 11 | 11,288 | 180 KB | 2.6 | no | 0 / 1 / 0 / 0 / 0 / 0 |  |
| path-tracing | main:af+op+epr+occ | $0.309 | 30 | 17,971 | 321 KB | 18.7 | yes | 0 / 0 / 0 / 0 / 0 / 0 |  |
| path-tracing | main:op | $0.129 | 12 | 8,527 | 132 KB | 5.1 | yes | 0 / 0 / 0 / 0 / 0 / 0 |  |
| path-tracing | none | $0.293 | 16 | 9,109 | 147 KB | 2.4 | yes | 0 / 0 / 0 / 0 / 0 / 0 |  |
| path-tracing | pr:af+op+epr+occ | $0.304 | 23 | 15,964 | 113 KB | 17.9 | yes | 0 / 0 / 0 / 0 / 0 / 0 |  |
| path-tracing | pr:op | $0.263 | 26 | 16,481 | 162 KB | 12.0 | yes | 0 / 0 / 0 / 0 / 0 / 0 |  |
| pydata__xarray-6992 | main:af+op+epr+occ | $0.024 | 3 | 940 | 15 KB | 0.3 | no | 0 / 0 / 0 / 0 / 0 / 0 |  |
| pydata__xarray-6992 | main:op | $0.029 | 6 | 1,386 | 18 KB | 0.6 | no | 0 / 0 / 0 / 0 / 0 / 0 |  |
| pydata__xarray-6992 | none | $0.019 | 3 | 696 | 12 KB | 0.2 | no | 0 / 0 / 0 / 0 / 0 / 0 |  |
| pydata__xarray-6992 | pr:af+op+epr+occ | $0.024 | 3 | 925 | 15 KB | 0.3 | no | 0 / 0 / 0 / 0 / 0 / 0 |  |
| pydata__xarray-6992 | pr:op | $0.018 | 3 | 812 | 15 KB | 0.3 | no | 0 / 0 / 0 / 0 / 0 / 0 |  |
| pytest-dev__pytest-5787 | main:af+op+epr+occ | $0.061 | 10 | 3,363 | 35 KB | 1.1 | no | 0 / 0 / 0 / 0 / 0 / 0 |  |
| pytest-dev__pytest-5787 | main:op | $0.065 | 9 | 3,773 | 34 KB | 1.0 | no | 0 / 0 / 0 / 0 / 0 / 0 |  |
| pytest-dev__pytest-5787 | none | $0.064 | 9 | 3,648 | 34 KB | 0.9 | no | 0 / 0 / 0 / 0 / 0 / 0 |  |
| pytest-dev__pytest-5787 | pr:af+op+epr+occ | $0.068 | 10 | 3,756 | 39 KB | 0.9 | no | 0 / 0 / 0 / 0 / 0 / 0 |  |
| pytest-dev__pytest-5787 | pr:op | $0.046 | 7 | 2,593 | 30 KB | 0.5 | no | 0 / 0 / 0 / 0 / 0 / 0 |  |
| regex-chess | main:af+op+epr+occ | $0.555 | 21 | 31,109 | 163 KB | 58.5 | yes | 0 / 0 / 0 / 0 / 0 / 0 |  |
| regex-chess | main:op | $0.420 | 5 | 26,795 | 111 KB | 14.2 | yes | 0 / 0 / 0 / 0 / 0 / 0 |  |
| regex-chess | none | $0.669 | 10 | 28,091 | 177 KB | 60.0 | yes | 0 / 0 / 0 / 0 / 0 / 0 | AgentTimeoutError |
| regex-chess | pr:af+op+epr+occ | $0.563 | 14 | 33,608 | 150 KB | 49.7 | yes | 0 / 0 / 0 / 0 / 0 / 0 |  |
| regex-chess | pr:op | $1.302 | 20 | 34,630 | 194 KB | 60.0 | - | 0 / 1 / 0 / 0 / 0 / 0 | AgentTimeoutError |
| schemelike-metacircular-eval | main:af+op+epr+occ | $0.371 | 6 | 30,504 | 142 KB | 6.1 | yes | 0 / 1 / 0 / 0 / 0 / 0 |  |
| schemelike-metacircular-eval | main:op | $0.517 | 11 | 28,947 | 139 KB | 32.4 | yes | 0 / 1 / 0 / 0 / 0 / 0 |  |
| schemelike-metacircular-eval | none | $0.520 | 12 | 28,829 | 155 KB | 40.0 | no | 0 / 0 / 0 / 0 / 0 / 0 | AgentTimeoutError |
| schemelike-metacircular-eval | pr:af+op+epr+occ | $0.167 | 5 | 11,001 | 59 KB | 16.0 | yes | 0 / 1 / 0 / 0 / 0 / 0 |  |
| schemelike-metacircular-eval | pr:op | $0.277 | 12 | 12,648 | 83 KB | 40.0 | yes | 0 / 4 / 0 / 0 / 0 / 0 | AgentTimeoutError |
| sphinx-doc__sphinx-9461 | main:af+op+epr+occ | $0.068 | 12 | 3,870 | 38 KB | 1.5 | no | 0 / 0 / 0 / 0 / 0 / 0 |  |
| sphinx-doc__sphinx-9461 | main:op | $0.110 | 17 | 6,085 | 57 KB | 1.4 | yes | 0 / 0 / 0 / 0 / 0 / 0 |  |
| sphinx-doc__sphinx-9461 | none | $0.046 | 7 | 2,215 | 25 KB | 0.5 | no | 0 / 0 / 0 / 0 / 0 / 0 |  |
| sphinx-doc__sphinx-9461 | pr:af+op+epr+occ | $0.088 | 12 | 5,177 | 46 KB | 1.9 | yes | 0 / 0 / 0 / 0 / 0 / 0 |  |
| sphinx-doc__sphinx-9461 | pr:op | $0.104 | 17 | 5,848 | 53 KB | 2.1 | yes | 0 / 0 / 0 / 0 / 0 / 0 |  |
| sympy__sympy-13852 | main:af+op+epr+occ | $0.026 | 6 | 1,313 | 20 KB | 0.4 | no | 0 / 0 / 0 / 0 / 0 / 0 |  |
| sympy__sympy-13852 | main:op | $0.024 | 5 | 1,218 | 17 KB | 0.4 | no | 0 / 0 / 0 / 0 / 0 / 0 |  |
| sympy__sympy-13852 | none | $0.031 | 6 | 1,563 | 20 KB | 0.4 | no | 0 / 0 / 0 / 0 / 0 / 0 |  |
| sympy__sympy-13852 | pr:af+op+epr+occ | $0.024 | 5 | 1,162 | 20 KB | 0.4 | no | 0 / 0 / 0 / 0 / 0 / 0 |  |
| sympy__sympy-13852 | pr:op | $0.021 | 4 | 1,236 | 16 KB | 0.3 | no | 0 / 0 / 0 / 0 / 0 / 0 |  |

## By arm

Cost vs none: geometric mean over tasks of this arm's cost divided by plain Pi's on the same task.

| Arm | Runs | Mean cost | Cost vs none | Mean requests | Mean cache read / write (K tok) | Mean minutes | Resolved | Cost per resolved |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| none | 10 | $0.204 | +0% | 9 | 164 / 36 | 11.5 | 4/10 | $0.509 |
| main:op | 10 | $0.163 | -5% | 9 | 67 / 24 | 6.1 | 6/10 | $0.271 |
| pr:op | 10 | $0.238 | +0% | 11 | 128 / 52 | 12.1 | 5/10 | $0.476 |
| main:af+op+epr+occ | 10 | $0.172 | -5% | 11 | 165 / 19 | 9.1 | 5/10 | $0.344 |
| pr:af+op+epr+occ | 10 | $0.158 | -8% | 9 | 119 / 21 | 9.2 | 6/10 | $0.264 |

## Mechanism activity

Over the runs with the mechanism enabled, per tree. Actions: fused `then_run` calls, packed observations, verified reducer receipts, compactions.

| Tree | Mechanism | Enabled runs | Trigger rate | Intensity |
|---|---|--:|--:|--:|
| main | af | 10 | 0/10 | 0.0 |
| main | op | 20 | 2/20 | 1.0 |
| main | epr | 10 | 0/10 | 0.0 |
| main | occ | 10 | 0/10 | 0.0 |
| pr | af | 10 | 0/10 | 0.0 |
| pr | op | 20 | 4/20 | 1.8 |
| pr | epr | 10 | 0/10 | 0.0 |
| pr | occ | 10 | 0/10 | 0.0 |

main: the model called `update_plan` in 0 of 10 runs with Online Context Compact, 0 calls in all.

main: the model called `obs_recall` in 0 of 20 runs with ObservationPack, 0 calls in all.

pr: the model called `update_plan` in 0 of 10 runs with Online Context Compact, 0 calls in all.

pr: the model called `obs_recall` in 0 of 20 runs with ObservationPack, 0 calls in all.

## ObservationPack and the prompt cache

Cache-write tokens per agent request: on the requests in which a placeholder first replaced a result (the prompt cache is rewritten from that message on) against the other requests of the same runs.

| Arm | Replacement requests | Median write on them | Median write elsewhere | Mean write on them | Mean write elsewhere |
|---|--:|--:|--:|--:|--:|
| main:af+op+epr+occ | 1 | 10,927 | 708 | 10,927 | 1,686 |
| main:op | 1 | 10,194 | 815 | 10,194 | 2,657 |
| pr:af+op+epr+occ | 1 | 3,713 | 780 | 3,713 | 2,297 |
| pr:op | 6 | 6,185 | 869 | 5,525 | 4,515 |
