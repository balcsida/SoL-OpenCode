# SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
# SPDX-License-Identifier: MIT
"""Harbor installed agent: OpenCode 2.2.3 with one SoL-OpenCode mechanism combination.

The task container gets bench/stage (OpenCode, ripgrep, uv, the plugin) as a
read-only mount at /sol-stage. Every model request goes to bench/proxy.mjs on the
host, which holds the API key and meters the request; the same proxy tunnels the
container's other HTTPS traffic.
"""

import json
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template

BENCH = Path(__file__).resolve().parent
STAGE = "/sol-stage"
HOME = "/installed-agent"
MECHANISMS = {
    "af": "actionFusion",
    "op": "observationPack",
    "epr": "evidencePreservingReducer",
    "occ": "onlineContextCompact",
}


class SolOpenCode(BaseInstalledAgent):
    def __init__(
        self,
        *args,
        mechanisms: str = "",
        proxy: str = "http://host.docker.internal:18789",
        reducer_model: str = "claude-haiku-5-5",
        cache_write_read_ratio: float = 25,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self.mechanisms = [m for m in mechanisms.split("+") if m]
        unknown = set(self.mechanisms) - MECHANISMS.keys()
        if unknown:
            raise ValueError(f"unknown mechanisms {sorted(unknown)}; use {'+'.join(MECHANISMS)}")
        self.proxy = proxy
        self.reducer_model = reducer_model
        self.cache_write_read_ratio = cache_write_read_ratio

    @staticmethod
    def name() -> str:
        return "sol-opencode"

    def get_version_command(self) -> str | None:
        return "opencode --version"

    async def install(self, environment) -> None:
        await self.exec_as_root(
            environment,
            # SWE-bench images (the ones with /testbed): the grader runs /root/.local/bin/uv, which the image build
            # fails to download here. Terminal-Bench's tests install their own uv there, so leave other images alone.
            command=(
                f"ln -sf {STAGE}/opencode /usr/local/bin/opencode && ln -sf {STAGE}/rg /usr/local/bin/rg"
                f" && if [ -d /testbed ]; then mkdir -p /root/.local/bin && ln -sf {STAGE}/uv /root/.local/bin/uv; fi"
                " && opencode --version"
            ),
        )

    def opencode_config(self) -> dict:
        job, trial = self.logs_dir.parent.parent.name, self.logs_dir.parent.name
        config = {
            "$schema": "https://opencode.ai/config.json",
            # The proxy adds the real key; the container never holds it.
            "providers": {"anthropic": {"settings": {"baseURL": f"{self.proxy}/t/{job}/{trial}/v1", "apiKey": "added-by-proxy"}}},
            # Same for every combination: no title call, no web access (the container is offline), no LSP or formatter downloads.
            "agents": {"title": {"disabled": True}},
            "permissions": [{"action": "webfetch", "resource": "*", "effect": "deny"}],
            "websearch": False,
            "share": "disabled",
            "update": "disable",
            "formatter": False,
            "lsp": False,
        }
        if self.mechanisms:
            options = {"version": 1, **{MECHANISMS[m]: True for m in self.mechanisms}, "cacheWriteReadRatio": self.cache_write_read_ratio}
            if "epr" in self.mechanisms:
                options |= {"evidencePreservingReducerProvider": "anthropic", "evidencePreservingReducerModel": self.reducer_model}
            config["plugins"] = [{"package": f"{STAGE}/sol-opencode", "options": options}]
        return config

    @with_prompt_template
    async def run(self, instruction, environment, context) -> None:
        await self.exec_as_root(environment, command=f"mkdir -p {HOME}/config/opencode {HOME}/data {HOME}/state {HOME}/cache")
        await self._upload_config_text(
            environment,
            content=json.dumps(self.opencode_config(), indent=2),
            remote_path=f"{HOME}/config/opencode/opencode.json",
            filename="opencode.json",
        )
        logs = self.environment_logs_dir
        env = {
            "XDG_CONFIG_HOME": f"{HOME}/config",
            "XDG_DATA_HOME": f"{HOME}/data",
            "XDG_STATE_HOME": f"{HOME}/state",
            "XDG_CACHE_HOME": f"{HOME}/cache",
            "OPENCODE_DISABLE_AUTOUPDATE": "1",
            "OPENCODE_DISABLE_MODELS_FETCH": "1",
            "OPENCODE_DISABLE_PROJECT_CONFIG": "1",
            "OPENCODE_DISABLE_CLAUDE_CODE": "1",
            # Reach the host proxy directly even if Docker injects the host's proxy settings.
            "NO_PROXY": "host.docker.internal,localhost,127.0.0.1",
            "no_proxy": "host.docker.internal,localhost,127.0.0.1",
        }
        # Copy OpenCode's data (session database, SoL archives) into the synced logs even when the run fails.
        await self.exec_as_agent(
            environment,
            env=env,
            command=(
                f"opencode run --standalone --auto -m {shlex.quote(self.model_name)} --format json -- {shlex.quote(instruction)}"
                f" < /dev/null > {logs}/opencode.jsonl 2> {logs}/opencode.stderr; status=$?;"
                f" cp -a {HOME}/data {logs}/opencode-data 2>/dev/null; exit $status"
            ),
        )

    def populate_context_post_run(self, context) -> None:
        # The proxy's log is the metered truth for this trial: agent, reducer, and compaction requests alike.
        job, trial = self.logs_dir.parent.parent.name, self.logs_dir.parent.name
        log = BENCH / "jobs" / "proxy.jsonl"
        if not log.exists():
            return
        rows = [r for r in map(json.loads, log.read_text().splitlines()) if r.get("job") == job and r.get("trial") == trial]
        context.n_input_tokens = sum(r.get("input", 0) + r.get("read", 0) + r.get("write", 0) for r in rows)
        context.n_cache_tokens = sum(r.get("read", 0) for r in rows)
        context.n_output_tokens = sum(r.get("output", 0) for r in rows)
        context.cost_usd = sum(r.get("usd", 0) for r in rows)
