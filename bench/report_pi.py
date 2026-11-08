#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
# SPDX-License-Identifier: MIT
"""Summarize Pi sweep jobs (bench/sweep_pi.py) as Markdown: bench/report_pi.py pi-tb pi-swe > report.md

Like bench/report.py, but the arms are SoL-Pi trees with mechanism combinations
(`main:op`, `pr:af+op+epr+occ`, or `none` for plain Pi), the cost comes from
bench/jobs/proxy-pi.jsonl, and the mechanism evidence comes from Pi's JSON event
stream (agent/pi.jsonl) instead of OpenCode's.
"""

import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

from report import JOBS, MECHANISMS, geomean, pct, seconds

PROXY_LOG = JOBS / "proxy-pi.jsonl"


def tool_text(result) -> str:
    content = result.get("content", []) if isinstance(result, dict) else []
    return "\n".join(part.get("text", "") for part in content if isinstance(part, dict))


def trials(jobs):
    proxy = defaultdict(list)
    for line in PROXY_LOG.read_text().splitlines():
        row = json.loads(line)
        proxy[(row.get("job"), row.get("trial"))].append(row)
    for job in jobs:
        for result_path in sorted((JOBS / job).glob("*/result.json")):
            trial_dir = result_path.parent
            result = json.loads(result_path.read_text())
            kwargs = json.loads((trial_dir / "config.json").read_text())["agent"]["kwargs"]
            rows = proxy[(job, trial_dir.name)]
            agent = [r for r in rows if r.get("kind") == "agent"]
            events_path = trial_dir / "agent" / "pi.jsonl"
            events = []
            for line in events_path.read_text().splitlines() if events_path.exists() else []:
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
            tools = [e for e in events if e.get("type") == "tool_execution_end"]
            # A replacement request is one whose placeholder count grew: that is where the prompt cache is rewritten.
            replacement_writes, other_writes = [], []
            seen = 0
            for r in agent:
                (replacement_writes if r.get("placeholders", 0) > seen else other_writes).append(r.get("write", 0))
                seen = max(seen, r.get("placeholders", 0))
            yield {
                "task": result["task_name"],
                "combo": f"{kwargs['sol_pi']}:{kwargs['mechanisms']}" if kwargs.get("sol_pi") else "none",
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
                "fused": sum(t.get("toolName") in ("edit", "write") and "[then_run:" in tool_text(t.get("result")) for t in tools),
                "packed": max((r.get("placeholders", 0) for r in agent), default=0),
                "reduced": max((r.get("receipts", 0) for r in agent), default=0),  # verified receipts, not reducer calls
                "plans": sum(t.get("toolName") == "update_plan" for t in tools),
                "recalls": sum(t.get("toolName") == "obs_recall" for t in tools),
                "compactions": sum(e.get("type") == "compaction_end" for e in events),
                "replacement_writes": replacement_writes,
                "other_writes": other_writes,
            }


def main(jobs):
    runs = list(trials(jobs))
    if not runs:
        sys.exit(f"no finished trials in {', '.join(jobs)}")
    baseline = {task: geomean([r["usd"] for r in runs if r["task"] == task and r["combo"] == "none"]) for task in {r["task"] for r in runs}}
    baseline = {task: usd for task, usd in baseline.items() if usd == usd}  # drop NaN: tasks without a none run

    print(f"# SoL-Pi sweep: {', '.join(jobs)}\n")
    print(f"{len(runs)} runs, ${sum(r['usd'] for r in runs):.2f} metered in total.\n")

    print("## Runs\n")
    print("| Task | Arm | Cost | Requests | Output tok | Peak request | Minutes | Resolved | Fired: fused / packed / reduced / plans / recalls / compactions | Error |")
    print("|---|---|--:|--:|--:|--:|--:|:-:|---|---|")
    for r in sorted(runs, key=lambda r: (r["task"], r["combo"])):
        resolved = {1.0: "yes", 0.0: "no"}.get(r["reward"], "-")
        fired = f"{r['fused']} / {r['packed']} / {r['reduced']} / {r['plans']} / {r['recalls']} / {r['compactions']}"
        print(f"| {r['task']} | {r['combo']} | ${r['usd']:.3f} | {r['requests']} | {r['output']:,} | {r['peak_kb']:.0f} KB | {r['minutes']:.1f} | {resolved} | {fired} | {r['error'] or ''} |")

    print("\n## By arm\n")
    print("Cost vs none: geometric mean over tasks of this arm's cost divided by plain Pi's on the same task.\n")
    print("| Arm | Runs | Mean cost | Cost vs none | Mean requests | Mean cache read / write (K tok) | Mean minutes | Resolved | Cost per resolved |")
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

    print("\n## Mechanism activity\n")
    print("Over the runs with the mechanism enabled, per tree. Actions: fused `then_run` calls, packed observations, verified reducer receipts, compactions.\n")
    print("| Tree | Mechanism | Enabled runs | Trigger rate | Intensity |")
    print("|---|---|--:|--:|--:|")
    trees = sorted({r["combo"].split(":")[0] for r in runs if r["combo"] != "none"})
    for tree in trees:
        for m, key in zip(MECHANISMS, ["fused", "packed", "reduced", "compactions"]):
            enabled = [r for r in runs if r["combo"].startswith(f"{tree}:") and m in r["combo"].split(":")[1].split("+")]
            fired = [r[key] for r in enabled if r[key] > 0]
            if enabled:
                print(f"| {tree} | {m} | {len(enabled)} | {len(fired)}/{len(enabled)} | {sum(fired) / len(fired) if fired else 0:.1f} |")
    for tree in trees:
        planned = [r for r in runs if r["combo"].startswith(f"{tree}:") and "occ" in r["combo"].split(":")[1].split("+")]
        if planned:
            print(f"\n{tree}: the model called `update_plan` in {sum(r['plans'] > 0 for r in planned)} of {len(planned)} runs with Online Context Compact, {sum(r['plans'] for r in planned)} calls in all.")
        packed = [r for r in runs if r["combo"].startswith(f"{tree}:") and "op" in r["combo"].split(":")[1].split("+")]
        if packed:
            print(f"\n{tree}: the model called `obs_recall` in {sum(r['recalls'] > 0 for r in packed)} of {len(packed)} runs with ObservationPack, {sum(r['recalls'] for r in packed)} calls in all.")

    print("\n## ObservationPack and the prompt cache\n")
    print("Cache-write tokens per agent request: on the requests in which a placeholder first replaced a result (the prompt cache is rewritten from that message on) against the other requests of the same runs.\n")
    print("| Arm | Replacement requests | Median write on them | Median write elsewhere | Mean write on them | Mean write elsewhere |")
    print("|---|--:|--:|--:|--:|--:|")
    for combo, rs in sorted(by_combo.items()):
        if "op" not in combo.split(":")[-1].split("+"):
            continue
        repl = [w for r in rs for w in r["replacement_writes"]]
        other = [w for r in rs for w in r["other_writes"]]
        stat = lambda fn, values: f"{fn(values):,.0f}" if values else "-"
        print(f"| {combo} | {len(repl)} | {stat(statistics.median, repl)} | {stat(statistics.median, other)} | {stat(statistics.mean, repl)} | {stat(statistics.mean, other)} |")


if __name__ == "__main__":
    main(sys.argv[1:] or sys.exit(__doc__))
