# Benchmark sweep

An indicative measurement of what SoL-OpenCode saves on long tasks: every on/off combination of the four mechanisms, run with real OpenCode 2.2.3 sessions on Terminal-Bench 2.0 and SWE-bench Verified tasks through [Harbor](https://github.com/harbor-framework/harbor). It spends real money and is not part of `npm run check`.

## What runs

- **Tasks** (`DATASETS` in `sweep.py`):
  - `terminal-bench@2.0`: five long tasks with small prebuilt images: regex-chess, circuit-fibsqrt, make-mips-interpreter, path-tracing, schemelike-metacircular-eval (expert estimates of 5 to 24 hours). The SoL-Pi paper's search tasks use Terminal-Bench 2's verifier interface; its Terminal-Bench 4 and EdgeBench are not in Harbor's registry.
  - `swebench-verified@1.0` (default): five of the 45 tasks its annotators rated "1-4 hours" or ">4 hours", one per repository.
- **Combinations:** `none` (plain OpenCode, no plugin) and every subset of `af` (Action Fusion), `op` (ObservationPack), `epr` (Evidence-Preserving Reducer), and `occ` (Online Context Compact): 16 in all.
- **Model:** `anthropic/claude-sonnet-5-5` by default. The reducer uses `claude-haiku-5-5`. `cacheWriteReadRatio` is 25, Sonnet 5.5's cache-write to cache-read price ratio.
- **The same for every combination:** OpenCode's defaults, except no title call, no web fetch or web search, no LSP or formatter, and no autoupdate. Each task's own agent and verifier timeouts.
- **Metering:** `proxy.mjs` sits between OpenCode and `api.anthropic.com`, holds the API key (containers never see it), and logs the provider-reported usage of every request, including reducer calls and compaction summaries. It prices each request from models.dev's prices and refuses new requests once `BUDGET_USD` (default 240) is spent.
- **Grading:** the benchmark's own tests, run by Harbor after the agent, so a saving that comes from failing the task shows up as a failure.

## Run it

Needs Docker, [Harbor](https://github.com/harbor-framework/harbor) (`uv tool install harbor`), `crane`, Node 22.19+, and an Anthropic API key in `~/.config/sol-opencode-bench/anthropic-api-key` (mode 600).

```bash
bench/stage.sh                                  # OpenCode, ripgrep, uv, and this checkout's plugin for the containers
NODE_USE_ENV_PROXY=1 node bench/proxy.mjs &     # metering proxy on 127.0.0.1:18789
bench/sweep.py --job tb-pilot --dataset terminal-bench@2.0 --combos 'none;af+op+epr+occ'
bench/sweep.py --job tb-grid --dataset terminal-bench@2.0      # all 16 combinations
bench/report.py tb-pilot tb-grid > bench/jobs/report.md
```

`node --test bench/` checks the proxy's metering without spending anything. Run the proxy and the sweeps in `tmux` (or similar) so they outlive the terminal that started them.

## Reading the report

- **Cost vs none:** per task, a combination's cost divided by plain OpenCode's, then the geometric mean over tasks. Repeated runs of a combination (a pilot plus the grid) are pooled.
- **Cost per resolved:** the SoL-Pi paper's token efficiency, its cost per score point.
- **Mechanism activity:** the paper's trigger rate (share of runs in which an enabled mechanism acted) and intensity (actions per triggered run). A mechanism that never acts cannot save anything: Action Fusion needs the model to pass `then_run`, and Online Context Compact needs it to call `update_plan`.
- **Average effect of each mechanism** (full grid only): per task, the 8 combinations with the mechanism on against the 8 with it off.

## Notes

- **Network.** The proxy also acts as the containers' forward proxy, for HTTPS (`CONNECT`) and plain HTTP (apt), chained through the host's own proxy when `HTTPS_PROXY`/`HTTP_PROXY` are set. `sweep.py` pulls task images on the host with `crane`. Both make the sweep work where Docker cannot reach the internet directly. `NODE_USE_ENV_PROXY=1` makes the proxy's own requests follow the host's proxy settings.
- **x86 images.** The task images are x86-64. On an arm64 host they run under emulation (`DOCKER_DEFAULT_PLATFORM=linux/amd64`), which slows builds and tests, not the model.
- **Grader.** SWE-bench images install `uv` from the internet at build time. `stage.sh` stages it and the agent links it where the grader looks for it in SWE-bench images (the ones with `/testbed`). Terminal-Bench tests install their own `uv`.
- **Noise.** Agent runs vary a lot between repeats, so read single cells with care.
- **Outputs** go to `bench/jobs/` (git-ignored): Harbor's trial directories, the proxy log, and each run's OpenCode event stream and data directory.
