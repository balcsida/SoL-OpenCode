# Long-task benchmark for SoL-Pi on Claude

Design, 2026-11-03. Status: approved, then shelved the same day before any run: the remaining API budget ($125) does not cover it, and the alternative the user asked for, running Pi through pi-claude-bridge on the Claude subscription, cannot measure it (see "Why not the bridge").

## Intent

Short tasks showed nothing: on Terminal-Bench 2.0 and SWE-bench Verified, Sonnet 5.5 finishes in 4 to 50 requests and SoL-Pi's mechanisms barely act (`docs/benchmark.md`, `docs/benchmark-pi.md`). Replaying our own recorded sessions, which run to hundreds of turns, models a saving of about a fifth of the bill from ObservationPack alone (SoL-PiG `bench/replay_sessions.py`), but that is a counterfactual model, not a measurement. The paper's own numbers come from 2-hour and longer runs. We want measured cost and score for SoL-Pi against plain Pi on Claude in sessions of that length, on public tasks anyone can rerun, and a documented decision on whether to spend on EdgeBench.

## Goals

1. A runner for 2-hour, open-ended tasks on the existing Harbor stack (`bench/sweep_pi.py`, `bench/sol_pi_agent.py`, `bench/proxy.mjs`): Pi keeps working until the budget is spent, and we get score over time and cost over time per run.
2. A pilot on Anthropic's performance take-home (https://github.com/anthropics/original_performance_takehome): three arms, plain Pi, SoL-Pi upstream main with all four mechanisms, NVlabs/SoL-Pi#121 with all four, each repeated, reporting total cost, best valid cycle count, score at equal budget, cost per score, mechanism activity (replacements, recalls, compactions, fused calls, plan updates), tool-usage mix and cache read/write split.
3. A go/no-go for EdgeBench, decided from the pilot, and the plan for that stage if it is a go.

## Non-goals

- Reproducing the paper's swarm setup on the take-home (coordinator plus 20 workers) or its GPT-5.6 backends.
- Optimizing the take-home kernel ourselves, or publishing solutions (the repo's license forbids redistributing solutions).
- Comparing harnesses (Codex, Claude Code) or the dropped prompt-rule change.

## Anti-goals

- A score that counts a cheated solution: the take-home README warns that models edit `tests/` to pass; the verifier must score with pristine tests.
- Single runs presented as effects. Repeats are part of the design, and every number carries its spread.
- Runaway spend: the metering proxy's cap bounds the whole pilot.

## Constraints

- Model: `anthropic/claude-opus-5-5` (the user's choice: closest to the paper's Opus 5), thinking `medium`, cache warming off, reducer `claude-haiku-5-5`, `cacheWriteReadRatio` 25 (Opus 5.5 lists $4 input, $20 output, $0.20 cache read, $5 cache write per million in Pi's registry; `bench/proxy.mjs` must get that price row, since it refuses unlisted models).
- Pi 1.3.0 and the two SoL-Pi trees staged by `bench/stage_pi.sh` (main at 2195680, PR at 9831c53).
- Host: this Mac with OrbStack; task images are x86-64 under emulation. The take-home is pure Python (the simulator runs the frozen tests in about 3 s natively, so tens of seconds emulated), which is acceptable.
- Secrets stay on the host: the proxy holds the API key, containers get a dummy one. Everything measured is public task material plus our own runs.
- Budget: the user sets the proxy cap before the pilot starts; the estimate below is what the design asks for.

## Approaches considered

1. EdgeBench at the 2-hour budget through its own harness, SForge, with a custom Pi agent. Paper-faithful and recognisable, 51 public tasks with an iterative judge. Needs a SForge fork for the Pi agent, a Linux Docker host (its network isolation edits host iptables) or its E2B cloud backend, and $15 to $40 per run, so $400 to $1,000 for 3 arms × 4 tasks × 2 repeats.
2. The take-home only, as a 2-hour Harbor task with a continuation loop. Reuses everything we have, $5 to $40 per run, a day of work, but one task.
3. Both in order: the take-home as the pilot of the long-session driver and of whether the mechanisms fire at all in 2-hour Sonnet sessions, EdgeBench only if they do. Chosen: option 1 alone risks $500+ to learn what option 2 tells us for a fraction, option 2 alone will not convince upstream.

## Design

### Task packaging (Harbor)

A custom task at `bench/tasks/perf-takehome/` in this repository, in Harbor's task layout (`task.toml`, `instruction.md`, `environment/Dockerfile`, `tests/test.sh`), referenced by `sweep_pi.py` through a new `--task-dir` option (a local task path instead of a registry dataset).

- `environment/Dockerfile`: `python:3.12-slim` plus `git`; clones the take-home at a pinned commit into `/app` (the agent's working directory) and keeps a pristine copy at `/opt/takehome-pristine`.
- `task.toml`: `agent.timeout_sec` 7,800 (the driver stops itself at 7,200), `verifier.timeout_sec` 900, `cpus` 2, `memory` 4G.
- `instruction.md`: optimize `KernelBuilder.build_kernel` in `perf_takehome.py` for the fewest simulated cycles; correctness is checked by `python tests/submission_tests.py`, which is the scoreboard; `tests/` and `problem.py` must not be modified, validation uses frozen copies; the budget is two hours and the agent should keep improving until told to stop. The wording is the builder's; it must not describe SoL-Pi's tools.
- `tests/test.sh` (verifier): restore `tests/` from the pristine copy, run `submission_tests.py` with a timeout against the best snapshot the driver kept (`/app/.best/perf_takehome.py`, see below) and against the final tree, parse `CYCLES:`; reward = clamp(ln(147734 / cycles) / ln(147734 / 1363), 0, 1) of the best snapshot when its correctness test passes, else 0 (EdgeBench scores the best submission the same way); also write both cycle counts, the pass/fail list and `git diff --stat` of `tests/` and `problem.py` into `/logs/verifier/` for the report. (My call: best valid, not final; a run that regresses in its last minutes keeps its earlier result.)
- Network: the agent container gets no outbound internet. The take-home has public write-ups, and a run that finds one measures lookup, not the mechanisms. The proxy gets a per-job switch that refuses `CONNECT` and plain-HTTP forwarding while still serving the metered API route; the sweep sets it for this task. This differs from the Terminal-Bench and SWE-bench sweeps, which tunnelled HTTPS for installs and graders. (My call.)

### Driver: Pi until the budget is spent

`sol_pi_agent.py` gains a `budget_sec` kwarg (0 = today's single run). With a budget:

1. Start the clock; run Pi with the instruction as today (`--mode json`, same session dir).
2. A background scorer runs every 5 minutes and whenever Pi exits: it scores the current tree with the pristine tests inside the container (a copy of `tests/` run against the agent's `perf_takehome.py`, bounded by a timeout), appends `{elapsed_sec, cycles, correct, trigger}` to `logs/progress.jsonl`, and when the result is correct and the best so far copies `perf_takehome.py` to `/app/.best/`. So the score curve has points even while Pi works for an hour without settling, like EdgeBench's auto-eval. (My call.)
3. If more than a margin (10 minutes) remains, relaunch `pi --mode json -c -- "<continue prompt>"`, continuing the same session, with the time left and the latest validated result in the prompt (the equivalent of EdgeBench's judge feedback). Repeat from 2.
4. Exit 0 at the margin; copy the session as today.

Guards (my calls): at least 30 seconds between relaunches; after three consecutive launches that make no metered request or exit within 30 seconds, the driver stops and marks the run `truncated` in `progress.jsonl`; a run the proxy cap or repeated API errors cut short is listed in the report but kept out of the arm averages, and is rerun only with the user's agreement.

One session per run, so the context grows across continuations; that is the point. Pi's own compaction stays at its default (Sonnet 5.5 has a 1M window in Pi's registry, so it should not trigger).

### Arms, repeats, scheduling

`none`, `main:op`, `pr:op`, `main:af+op+epr+occ`, `pr:af+op+epr+occ` (the user's choice: the `op`-only arms isolate ObservationPack, the only mechanism the PR changes); five repeats each, 25 runs, interleaved round-robin so an arm is never clustered in time; concurrency 3 (the simulator is CPU-bound under emulation). Estimated $40 to $80 per run on Opus 5.5 from the Pi sweep's request rate and context growth, so $1,000 to $2,000; proxy cap $2,000 unless the user sets another.

### Metrics and report

A `report_long.py` (or a mode of `report_pi.py`) that reads the proxy log, `progress.jsonl`, `pi.jsonl` and the verifier files, and prints, per run: cost, requests, peak prompt size, cache read/write tokens, final cycles and score, cycles at 30/60/90/120 minutes, replacements, recalls, compactions, fused calls, plan updates, tool mix, `tests/` diff status. Per arm: mean and median cost and score with min/max, cost per score, and cost at equal score: the target is the median of the final best scores over all runs of all arms; for each run, the cost it had spent (proxy log, by timestamp) when `progress.jsonl` first reached the target; the arm shows the median of its runs that reached it and the count that never did. (My call.) Results go to `docs/benchmark-long.md` with the setup and the spread stated.

### EdgeBench stage (conditional)

Go if, in the pilot, both SoL arms (main and PR) average at least one ObservationPack replacement per run and show at least one recall or compaction across their runs, and for at least one SoL arm the mean cost differs from plain Pi's by more than the larger of the two arms' standard deviations over the repeats. (My call on the exact rule; it releases the EdgeBench spend, so the user can veto it.) Then: fork SForge and add a `pi` agent (install Node 22 and Pi 1.3.0 in the work container, fetch the SoL-Pi tree as a tarball, write `models.json` pointing at the proxy from the harness's base-URL env, `resume_cmd` = `pi --mode json -c -- "Continue working."`), run on an OrbStack Ubuntu VM or the E2B backend, four public tasks with cheap CPU profiles (candidates: `integer_compression_codec`, `vliw_kernel_optimization`, `ad_placement_optimization`, `vehicle_routing_time_windows`) at `--timeout 7200`, three arms, one or two repeats, with its own approval of budget ($400 to $1,000).

## Left to the builder

The Dockerfile base and pinned commit, the exact continue-prompt wording, timeouts for the in-container scoring, how `--task-dir` maps onto Harbor's config, and the report's table layout. Anything that changes the arms, the budget, the model or the scoring formula comes back to the user.

## Decisions taken by the user

1. Five repeats per arm.
2. Opus 5.5 as the main model.
3. `op`-only arms for both trees in addition to the all-four arms: 25 runs.

## Why not the bridge

pi-claude-bridge runs the model through Claude Code (Agent SDK), which owns the transcript. Its session sync compares only message counts (`priorMessages.length >= cursor` in `syncSharedSession`), so a tool result that ObservationPack replaces in Pi's projection never changes in Claude Code's session, and Pi's compaction forces a full session rebuild instead of a priced rewrite. Verified on 2026-11-03 with Haiku: SoL-Pi's ledger recorded the placeholder from request 4, while the prompt grew monotonically (18.4k, 19.4k, 19.9k, 20.0k, 20.6k tokens) with a 139-token cache write at that request. Claude Code also truncates large tool results itself (the 50 KB result cost 1,049 cache-write tokens). A benchmark on the bridge would measure Claude Code's context handling, not SoL-Pi's. The same count-based sync is in pig-claude-bridge (`internal/bridge/sync.go`).

## If it is ever run

With a small budget, equal money beats equal time: give every run the same API budget (the proxy can cap per trial) and compare best valid cycles at the cap, cycles over cost, and requests per dollar. Three arms (`none`, `main:op`, `pr:op`) × 3 repeats at $8 on Sonnet 5.5 is about $75; Haiku 5.5 at the 2-hour budget is about $1 to $2 per run.
