#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
# SPDX-License-Identifier: MIT
"""Summarize SoL-OpenCode sweep jobs as Markdown: bench/report.py pilot sweep > report.md

Cost comes from the metering proxy's log (bench/jobs/proxy.jsonl), so it covers
every request a run made: agent steps, reducer calls, and compaction summaries.
Ratios compare a combination with "none" (plain OpenCode) on the same task and
average across tasks with a geometric mean.
"""

import json
import math
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

JOBS = Path(__file__).resolve().parent / "jobs"
MECHANISMS = ["af", "op", "epr", "occ"]


def seconds(span):
    if not span or not span.get("finished_at"):
        return None
    parse = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
    return (parse(span["finished_at"]) - parse(span["started_at"])).total_seconds()


def trials(jobs):
    proxy = defaultdict(list)
    for line in (JOBS / "proxy.jsonl").read_text().splitlines():
        row = json.loads(line)
        proxy[(row.get("job"), row.get("trial"))].append(row)
    for job in jobs:
        for result_path in sorted((JOBS / job).glob("*/result.json")):
            trial_dir = result_path.parent
            result = json.loads(result_path.read_text())
            config = json.loads((trial_dir / "config.json").read_text())
            rows = proxy[(job, trial_dir.name)]
            agent = [r for r in rows if r.get("kind") == "agent"]
            events = trial_dir / "agent" / "opencode.jsonl"
            tools = [json.loads(line)["part"] for line in (events.read_text().splitlines() if events.exists() else []) if '"type":"tool_use"' in line]
            yield {
                "task": result["task_name"],
                "combo": config["agent"]["kwargs"].get("mechanisms") or "none",
                "usd": sum(r.get("usd", 0) for r in rows),
                "requests": len(agent),
                "read": sum(r.get("read", 0) for r in rows),
                "write": sum(r.get("write", 0) for r in rows),
                "input": sum(r.get("input", 0) for r in rows),
                "output": sum(r.get("output", 0) for r in rows),
                "peak_kb": max((r.get("bytes", 0) for r in agent), default=0) / 1024,
                "reward": ((result.get("verifier_result") or {}).get("rewards") or {}).get("reward"),
                "error": (result.get("exception_info") or {}).get("exception_type"),
                "minutes": (seconds(result.get("agent_execution")) or 0) / 60,
                # Evidence that each mechanism fired, not just that it was enabled.
                "fused": sum("[then_run:" in str(t.get("state", {}).get("output", "")) for t in tools),
                "packed": max((r.get("placeholders", 0) for r in agent), default=0),
                "reduced": max((r.get("receipts", 0) for r in agent), default=0),  # verified receipts, not reducer calls
                "plans": sum(t.get("tool") == "update_plan" for t in tools),
                "compactions": sum(r.get("kind") == "summary" for r in rows),
            }


def geomean(values):
    values = [v for v in values if v > 0]
    return math.exp(sum(map(math.log, values)) / len(values)) if values else float("nan")


def pct(ratio):
    return "n/a" if math.isnan(ratio) else f"{round((ratio - 1) * 100):+d}%"  # round first: no "-0%"


def main(jobs):
    runs = list(trials(jobs))
    if not runs:
        sys.exit(f"no finished trials in {', '.join(jobs)}")
    # Repeats of a combination (e.g. a pilot plus the grid) are pooled; the baseline is the geometric mean of a task's "none" runs.
    baseline = {task: geomean([r["usd"] for r in runs if r["task"] == task and r["combo"] == "none"]) for task in {r["task"] for r in runs}}
    baseline = {task: usd for task, usd in baseline.items() if not math.isnan(usd)}

    print(f"# SoL-OpenCode sweep: {', '.join(jobs)}\n")
    print(f"{len(runs)} runs, ${sum(r['usd'] for r in runs):.2f} metered in total.\n")

    print("## Runs\n")
    print("| Task | Combination | Cost | Requests | Output tok | Peak request | Minutes | Resolved | Fired: fused / packed / reduced / plans / compactions | Error |")
    print("|---|---|--:|--:|--:|--:|--:|:-:|---|---|")
    for r in sorted(runs, key=lambda r: (r["task"], r["combo"])):
        resolved = {1.0: "yes", 0.0: "no"}.get(r["reward"], "-")
        fired = f"{r['fused']} / {r['packed']} / {r['reduced']} / {r['plans']} / {r['compactions']}"
        print(f"| {r['task']} | {r['combo']} | ${r['usd']:.3f} | {r['requests']} | {r['output']:,} | {r['peak_kb']:.0f} KB | {r['minutes']:.1f} | {resolved} | {fired} | {r['error'] or ''} |")

    print("\n## By combination\n")
    print("Cost vs none: geometric mean over tasks of this combination's cost divided by plain OpenCode's on the same task.\n")
    print("| Combination | Runs | Mean cost | Cost vs none | Mean requests | Mean cache read / write (K tok) | Mean minutes | Resolved | Cost per resolved |")
    print("|---|--:|--:|--:|--:|--:|--:|--:|--:|")
    by_combo = defaultdict(list)
    for r in runs:
        by_combo[r["combo"]].append(r)
    for combo, rs in sorted(by_combo.items(), key=lambda kv: (kv[0] != "none", kv[0].count("+"), kv[0])):
        ratio = geomean([r["usd"] / baseline[r["task"]] for r in rs if baseline.get(r["task"])])
        resolved = sum(r["reward"] == 1.0 for r in rs)
        mean = lambda key: sum(r[key] for r in rs) / len(rs)
        per_resolved = f"${sum(r['usd'] for r in rs) / resolved:.3f}" if resolved else "n/a"
        cache = f"{mean('read') / 1000:,.0f} / {mean('write') / 1000:,.0f}"
        print(f"| {combo} | {len(rs)} | ${mean('usd'):.3f} | {pct(ratio)} | {mean('requests'):.0f} | {cache} | {mean('minutes'):.1f} | {resolved}/{len(rs)} | {per_resolved} |")

    # The SoL-Pi paper's activation metrics (section 3.4): trigger rate is the share of runs in which a mechanism
    # acted at least once; intensity is its mean number of actions per triggered run.
    print("\n## Mechanism activity\n")
    print("Over the runs with the mechanism enabled. Actions: fused `then_run` calls, packed observations, verified reducer receipts, compactions.\n")
    print("| Mechanism | Enabled runs | Trigger rate | Intensity |")
    print("|---|--:|--:|--:|")
    for m, key in zip(MECHANISMS, ["fused", "packed", "reduced", "compactions"]):
        enabled = [r for r in runs if m in r["combo"].split("+")]
        fired = [r[key] for r in enabled if r[key] > 0]
        if enabled:
            print(f"| {m} | {len(enabled)} | {len(fired)}/{len(enabled)} | {sum(fired) / len(fired) if fired else 0:.1f} |")
    planned = [r for r in runs if "occ" in r["combo"].split("+")]
    if planned:
        print(f"\nOnline Context Compact can act only at `update_plan` boundaries; the model called `update_plan` in {sum(r['plans'] > 0 for r in planned)} of {len(planned)} runs.")

    if len(by_combo) == 16:  # main effects need the full grid
        print("\n## Average effect of each mechanism\n")
        print("Over all 16 combinations: per task, the geometric mean cost of the 8 combinations with the mechanism on, divided by the 8 with it off; then the geometric mean over tasks.\n")
        print("| Mechanism | Cost effect | Resolved with / without |")
        print("|---|--:|--:|")
        for m in MECHANISMS:
            has = lambda r: m in r["combo"].split("+")
            ratios = []
            for task in {r["task"] for r in runs}:
                on = [r["usd"] for r in runs if r["task"] == task and has(r)]
                off = [r["usd"] for r in runs if r["task"] == task and not has(r)]
                if on and off:
                    ratios.append(geomean(on) / geomean(off))
            with_m = [r for r in runs if has(r)]
            without = [r for r in runs if not has(r)]
            resolved = lambda rs: sum(r["reward"] == 1.0 for r in rs)
            print(f"| {m} | {pct(geomean(ratios))} | {resolved(with_m)}/{len(with_m)} vs {resolved(without)}/{len(without)} |")


if __name__ == "__main__":
    main(sys.argv[1:] or sys.exit(__doc__))
