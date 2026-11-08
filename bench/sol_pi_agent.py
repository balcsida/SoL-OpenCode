# SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
# SPDX-License-Identifier: MIT
"""Harbor installed agent: Pi 1.3.0 with one SoL-Pi tree and one mechanism combination.

The task container gets bench/stage-pi (Node, Pi, ripgrep, uv, the SoL-Pi trees) as
a read-only mount at /sol-stage. Every model request goes to bench/proxy.mjs on
the host, which holds the API key and meters the request; the same proxy tunnels
the container's other HTTPS traffic. The proxy log for this agent is
bench/jobs/proxy-pi.jsonl (start the proxy with PROXY_LOG pointing there).
"""

import json
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template

BENCH = Path(__file__).resolve().parent
PROXY_LOG = BENCH / "jobs" / "proxy-pi.jsonl"
STAGE = "/sol-stage"
HOME = "/installed-agent/pi"
MECHANISMS = {
    "af": "actionFusion",
    "op": "observationPack",
    "epr": "evidencePreservingReducer",
    "occ": "onlineContextCompact",
}


class SolPi(BaseInstalledAgent):
    def __init__(
        self,
        *args,
        sol_pi: str = "",
        mechanisms: str = "",
        proxy: str = "http://host.docker.internal:18789",
        reducer_model: str = "claude-haiku-5-5",
        cache_write_read_ratio: float = 25,
        thinking: str = "medium",
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        # sol_pi names a staged tree, bench/stage-pi/sol-pi-<label>; empty means plain Pi.
        self.sol_pi = sol_pi
        self.mechanisms = [m for m in mechanisms.split("+") if m]
        unknown = set(self.mechanisms) - MECHANISMS.keys()
        if unknown:
            raise ValueError(f"unknown mechanisms {sorted(unknown)}; use {'+'.join(MECHANISMS)}")
        if self.mechanisms and not sol_pi:
            raise ValueError("mechanisms need a sol_pi tree label")
        self.proxy = proxy
        self.reducer_model = reducer_model
        self.cache_write_read_ratio = cache_write_read_ratio
        self.thinking = thinking

    @staticmethod
    def name() -> str:
        return "sol-pi"

    def get_version_command(self) -> str | None:
        return "pi --version"

    async def install(self, environment) -> None:
        await self.exec_as_root(
            environment,
            command=(
                f"ln -sf {STAGE}/node/bin/node /usr/local/bin/node && ln -sf {STAGE}/pi/node_modules/.bin/pi /usr/local/bin/pi"
                f" && ln -sf {STAGE}/rg /usr/local/bin/rg"
                # SWE-bench images (the ones with /testbed): the grader runs /root/.local/bin/uv, which the image build
                # fails to download here. Terminal-Bench's tests install their own uv there, so leave other images alone.
                f" && if [ -d /testbed ]; then mkdir -p /root/.local/bin && ln -sf {STAGE}/uv /root/.local/bin/uv; fi"
                " && pi --version"
            ),
        )

    def job_and_trial(self) -> tuple[str, str]:
        return self.logs_dir.parent.parent.name, self.logs_dir.parent.name

    def pi_files(self) -> dict[str, dict]:
        job, trial = self.job_and_trial()
        files = {
            # No cache warming: it would add requests of its own while a slow tool runs, which OpenCode never sends.
            "settings.json": {"cacheWarming": "off", "quietStartup": True},
            # The proxy adds the real key; the container never holds it.
            "models.json": {"providers": {"anthropic": {"baseUrl": f"{self.proxy}/t/{job}/{trial}", "apiKey": "added-by-proxy"}}},
        }
        if self.mechanisms:
            config = {"version": 1, **{MECHANISMS[m]: True for m in self.mechanisms}, "cacheWriteReadRatio": self.cache_write_read_ratio}
            if "epr" in self.mechanisms:
                config |= {"evidencePreservingReducerProvider": "anthropic", "evidencePreservingReducerModel": self.reducer_model}
            files["sol-pi.json"] = config
        return files

    @with_prompt_template
    async def run(self, instruction, environment, context) -> None:
        await self.exec_as_root(environment, command=f"mkdir -p {HOME}/sessions && chmod -R a+rwX {HOME}")
        for name, content in self.pi_files().items():
            await self._upload_config_text(environment, content=json.dumps(content, indent=2), remote_path=f"{HOME}/{name}", filename=name)
        logs = self.environment_logs_dir
        env = {
            "PI_CODING_AGENT_DIR": HOME,
            "PI_OFFLINE": "1",
            # Reach the host proxy directly even if Docker injects the host's proxy settings.
            "NO_PROXY": "host.docker.internal,localhost,127.0.0.1",
            "no_proxy": "host.docker.internal,localhost,127.0.0.1",
        }
        extension = f" -e {STAGE}/sol-pi-{self.sol_pi}/src/sol-pi/index.ts" if self.sol_pi else ""
        # Project-local Pi files in the task repository are ignored (-na), so every run gets the same loadout.
        # The session log is copied into the synced logs even when the run fails.
        await self.exec_as_agent(
            environment,
            env=env,
            command=(
                f"pi --mode json --model {shlex.quote(self.model_name)} --thinking {self.thinking} -na"
                f" --session-dir {HOME}/sessions{extension} -- {shlex.quote(instruction)}"
                f" < /dev/null > {logs}/pi.jsonl 2> {logs}/pi.stderr; status=$?;"
                f" cp -a {HOME}/sessions {logs}/pi-sessions 2>/dev/null; exit $status"
            ),
        )

    def populate_context_post_run(self, context) -> None:
        # The proxy's log is the metered truth for this trial: agent, reducer, and compaction requests alike.
        job, trial = self.job_and_trial()
        if not PROXY_LOG.exists():
            return
        rows = [r for r in map(json.loads, PROXY_LOG.read_text().splitlines()) if r.get("job") == job and r.get("trial") == trial]
        context.n_input_tokens = sum(r.get("input", 0) + r.get("read", 0) + r.get("write", 0) for r in rows)
        context.n_cache_tokens = sum(r.get("read", 0) for r in rows)
        context.n_output_tokens = sum(r.get("output", 0) for r in rows)
        context.cost_usd = sum(r.get("usd", 0) for r in rows)
