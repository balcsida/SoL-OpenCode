#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
# SPDX-License-Identifier: MIT
"""Run SoL-OpenCode mechanism combinations on SWE-bench Verified or Terminal-Bench 2.0 tasks through Harbor.

    bench/sweep.py --job pilot --combos 'none;af+op+epr+occ'
    bench/sweep.py --job sweep                  # all 16 combinations
    bench/sweep.py --job tb-pilot --dataset terminal-bench@2.0 --combos 'none;af+op+epr+occ'

Needs bench/stage.sh run once, and the metering proxy running:
    NODE_USE_ENV_PROXY=1 node bench/proxy.mjs
"""

import argparse
import itertools
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

BENCH = Path(__file__).resolve().parent
DATASETS = {
    # Five of the 45 tasks its annotators rated "1-4 hours" or ">4 hours", one per repository.
    "swebench-verified@1.0": {
        "tasks": ["django__django-13128", "sympy__sympy-13852", "pytest-dev__pytest-5787", "sphinx-doc__sphinx-9461", "pydata__xarray-6992"],
        "image": lambda task: f"swebench/sweb.eval.x86_64.{task.replace('__', '_1776_')}:latest",
    },
    # Five long tasks (expert estimates of 5 to 24 hours) with small prebuilt images.
    "terminal-bench@2.0": {
        "tasks": ["regex-chess", "circuit-fibsqrt", "make-mips-interpreter", "path-tracing", "schemelike-metacircular-eval"],
        # shortcut: the tag these five tasks' task.toml files name; read docker_image from task.toml before adding tasks.
        "image": lambda task: f"alexgshaw/{task}:20251031",
    },
}
MECHANISMS = ["af", "op", "epr", "occ"]
ALL_COMBOS = ["+".join(c) or "none" for n in range(len(MECHANISMS) + 1) for c in itertools.combinations(MECHANISMS, n)]


def ensure_image(image: str) -> None:
    # The Docker engine cannot reach the registry from this network, so pull on the host (through its proxy) and load.
    if subprocess.run(["docker", "image", "inspect", image], capture_output=True).returncode == 0:
        return
    print(f"pulling {image}", flush=True)
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["crane", "pull", "--platform", "linux/amd64", image, f"{tmp}/image.tar"], check=True)
        subprocess.run(["docker", "load", "-i", f"{tmp}/image.tar"], check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--job", required=True, help="Harbor job name, also the proxy log's job field")
    parser.add_argument("--combos", default="all", help="'all', or ';'-separated combinations such as 'none;af+op'")
    parser.add_argument("--dataset", default="swebench-verified@1.0", choices=DATASETS)
    parser.add_argument("--tasks", help="comma-separated task names (default: the dataset's five)")
    parser.add_argument("--model", default="anthropic/claude-sonnet-5-5")
    parser.add_argument("--concurrency", type=int, default=4)
    args = parser.parse_args()

    combos = ALL_COMBOS if args.combos == "all" else args.combos.split(";")
    for combo in combos:
        if combo != "none" and not set(combo.split("+")) <= set(MECHANISMS):
            parser.error(f"unknown combination {combo!r}")
    if not (BENCH / "stage" / "opencode").exists():
        parser.error("run bench/stage.sh first")
    try:
        no_proxy = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        health = json.load(no_proxy.open("http://127.0.0.1:18789/health", timeout=5))
    except OSError:
        parser.error("start the metering proxy first: NODE_USE_ENV_PROXY=1 node bench/proxy.mjs")
    print(f"proxy: ${health['spentUsd']:.2f} spent of ${health['capUsd']}", flush=True)

    dataset = DATASETS[args.dataset]
    tasks = args.tasks.split(",") if args.tasks else dataset["tasks"]
    for task in tasks:
        ensure_image(dataset["image"](task))

    jobs = BENCH / "jobs"
    jobs.mkdir(exist_ok=True)
    overlay = jobs / f"{args.job}.overlay.json"  # One per job, so concurrent sweeps never read a half-written file. Compose reads JSON as YAML.
    proxy = "http://host.docker.internal:18789"
    overlay.write_text(json.dumps({"services": {"main": {
        "volumes": [f"{BENCH / 'stage'}:/sol-stage:ro", f"{jobs / 'uv-cache'}:/uv-cache"],
        "extra_hosts": ["host.docker.internal:host-gateway"],
        # Internet for the agent's tools and the grader goes through the metering proxy (CONNECT for HTTPS,
        # forwarding for apt's plain HTTP). The graders' uv shares one cache across trials, and uses the system
        # CA store because uv 0.7.13's bundled roots no longer validate pypi.org.
        "environment": {
            "HTTP_PROXY": proxy, "HTTPS_PROXY": proxy, "http_proxy": proxy, "https_proxy": proxy,
            "NO_PROXY": "localhost,127.0.0.1,host.docker.internal", "no_proxy": "localhost,127.0.0.1,host.docker.internal",
            "UV_CACHE_DIR": "/uv-cache/cache", "UV_PYTHON_INSTALL_DIR": "/uv-cache/python", "UV_NATIVE_TLS": "1",
        },
    }}}, indent=2))
    config = {
        "job_name": args.job,
        "jobs_dir": str(jobs),
        "n_attempts": 1,
        "n_concurrent_trials": args.concurrency,
        "environment": {"extra_docker_compose": [str(overlay)]},
        "agents": [
            {"import_path": "sol_opencode_agent:SolOpenCode", "model_name": args.model, "kwargs": {"mechanisms": "" if c == "none" else c}}
            for c in combos
        ],
        "datasets": [{"name": args.dataset.split("@")[0], "version": args.dataset.split("@")[1], "task_names": tasks}],
    }
    config_path = jobs / f"{args.job}.config.json"
    config_path.write_text(json.dumps(config, indent=2))
    env = {**os.environ, "PYTHONPATH": str(BENCH), "DOCKER_DEFAULT_PLATFORM": "linux/amd64"}
    return subprocess.call(["harbor", "run", "-c", str(config_path)], env=env)


if __name__ == "__main__":
    sys.exit(main())
