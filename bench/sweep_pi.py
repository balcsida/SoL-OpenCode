#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
# SPDX-License-Identifier: MIT
"""Run Pi with SoL-Pi trees and mechanism combinations on SWE-bench Verified or Terminal-Bench 2.0 tasks through Harbor.

    bench/sweep_pi.py --job pi-smoke --model anthropic/claude-haiku-5-5 --tasks circuit-fibsqrt --dataset terminal-bench@2.0 --arms 'none;pr:af+op+epr+occ'
    bench/sweep_pi.py --job pi-tb --dataset terminal-bench@2.0    # the default five arms

An arm is `none` (plain Pi) or `<tree>:<mechanisms>`, where the tree is a label staged by
bench/stage_pi.sh (bench/stage-pi/sol-pi-<label>) and the mechanisms are `+`-joined af, op, epr, occ.

Needs bench/stage_pi.sh run once, and the metering proxy running with its own log:
    PROXY_LOG=bench/jobs/proxy-pi.jsonl NODE_USE_ENV_PROXY=1 node bench/proxy.mjs
"""

import argparse
import json
import os
import subprocess
import sys
import urllib.request

from sweep import BENCH, DATASETS, MECHANISMS, ensure_image

DEFAULT_ARMS = "none;main:op;pr:op;main:af+op+epr+occ;pr:af+op+epr+occ"


def parse_arm(arm: str) -> dict:
    if arm == "none":
        return {"sol_pi": "", "mechanisms": ""}
    tree, _, mechanisms = arm.partition(":")
    if not tree or not mechanisms or not set(mechanisms.split("+")) <= set(MECHANISMS):
        raise ValueError(f"unknown arm {arm!r}; use none or <tree>:<mechanisms>")
    if not (BENCH / "stage-pi" / f"sol-pi-{tree}").is_dir():
        raise ValueError(f"no staged tree bench/stage-pi/sol-pi-{tree}; run bench/stage_pi.sh")
    return {"sol_pi": tree, "mechanisms": mechanisms}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--job", required=True, help="Harbor job name, also the proxy log's job field")
    parser.add_argument("--arms", default=DEFAULT_ARMS, help="';'-separated arms such as 'none;pr:af+op'")
    parser.add_argument("--dataset", default="swebench-verified@1.0", choices=DATASETS)
    parser.add_argument("--tasks", help="comma-separated task names (default: the dataset's five)")
    parser.add_argument("--model", default="anthropic/claude-sonnet-5-5")
    parser.add_argument("--thinking", default="medium", help="Pi thinking level for the main model")
    parser.add_argument("--concurrency", type=int, default=4)
    args = parser.parse_args()

    try:
        arms = {arm: parse_arm(arm) for arm in args.arms.split(";")}
    except ValueError as error:
        parser.error(str(error))
    if not (BENCH / "stage-pi" / "pi" / "node_modules" / ".bin" / "pi").exists():
        parser.error("run bench/stage_pi.sh first")
    try:
        no_proxy = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        health = json.load(no_proxy.open("http://127.0.0.1:18789/health", timeout=5))
    except OSError:
        parser.error("start the metering proxy first: PROXY_LOG=bench/jobs/proxy-pi.jsonl NODE_USE_ENV_PROXY=1 node bench/proxy.mjs")
    print(f"proxy: ${health['spentUsd']:.2f} spent of ${health['capUsd']}", flush=True)

    dataset = DATASETS[args.dataset]
    tasks = args.tasks.split(",") if args.tasks else dataset["tasks"]
    for task in tasks:
        ensure_image(dataset["image"](task))

    jobs = BENCH / "jobs"
    jobs.mkdir(exist_ok=True)
    overlay = jobs / f"{args.job}.overlay.json"
    proxy = "http://host.docker.internal:18789"
    overlay.write_text(json.dumps({"services": {"main": {
        "volumes": [f"{BENCH / 'stage-pi'}:/sol-stage:ro", f"{jobs / 'uv-cache'}:/uv-cache"],
        "extra_hosts": ["host.docker.internal:host-gateway"],
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
            {"import_path": "sol_pi_agent:SolPi", "model_name": args.model, "kwargs": {**kwargs, "thinking": args.thinking}}
            for kwargs in arms.values()
        ],
        "datasets": [{"name": args.dataset.split("@")[0], "version": args.dataset.split("@")[1], "task_names": tasks}],
    }
    config_path = jobs / f"{args.job}.config.json"
    config_path.write_text(json.dumps(config, indent=2))
    env = {**os.environ, "PYTHONPATH": str(BENCH), "DOCKER_DEFAULT_PLATFORM": "linux/amd64"}
    return subprocess.call(["harbor", "run", "-c", str(config_path)], env=env)


if __name__ == "__main__":
    sys.exit(main())
