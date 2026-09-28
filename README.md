# SoL-OpenCode

SoL-OpenCode brings [SoL-Pi](https://github.com/NVlabs/SoL-Pi)'s four token-efficiency mechanisms to [OpenCode v2](https://opencode.ai/v2/docs/build/plugins/) as a plugin built on `@opencode/plugin`. It is a port of SoL-Pi, which NVIDIA released under the MIT license for the Pi coding agent. SoL-OpenCode is not an NVIDIA or OpenCode project.

**Spend less without making the agent do less useful work.** Each mechanism is opt-in and disabled by default.

| Area | Mechanism | What changes |
|---|---|---|
| Tools | **Action Fusion** | `edit` and `write` accept an optional `then_run` command that runs in the same tool call, through OpenCode's own `shell` tool. |
| Observations | **ObservationPack** | Large tool results are sent in full twice, then replaced in outgoing requests by a stable placeholder, with exact paged recall through `obs_recall`. |
| Delegation | **Evidence-Preserving Reducer** | Long diagnostic logs become compact receipts through a reducer model, accepted only when every quote matches the archived source byte for byte. |
| Context | **Online Context Compact** | Completed plan steps (`update_plan`) become candidate compaction points, subject to an economic check (`cacheWriteReadRatio`) and window pressure. |

The rules carry over from SoL-Pi:

- **No OpenCode patches.** Only the public `@opencode/plugin` API is used.
- **Explicit opt-in.** A missing configuration leaves every mechanism disabled.
- **Preserve evidence.** Originals stay archived locally, and any mechanism failure leaves the original result or request unchanged.
- **Persisted history is never edited.** ObservationPack and Online Context Compact change only the outgoing request.
- **Use OpenCode's runtime choices.** Authentication, providers, the main model, and the shell stay under OpenCode's control. The reducer and the compaction summary go through `ctx.generate.text` and `ctx.session.generate`.

Online Context Compact works differently from SoL-Pi. OpenCode v2.0.18 gives plugins no way to request its own compaction, so a selected plan boundary is compacted in the outgoing request: the older messages are summarized once (reusing the cached prefix), and later requests carry the summary in their place. See [docs/compatibility.md](docs/compatibility.md) for this and the other differences.

## Requirements

- OpenCode **2.0.18** (`npm install -g @opencode/cli@2.0.18`)
- Node.js 22.19 or newer and npm, to install this package's dependencies

## Install

Clone the repository and install its locked dependencies:

```bash
git clone https://github.com/balcsida/SoL-OpenCode
cd SoL-OpenCode
npm ci --ignore-scripts
```

Then load it in one of two ways.

**Option 1: a `plugins` entry, with the configuration as options.** In `opencode.jsonc` (project or `~/.config/opencode/`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/SoL-OpenCode",
      "options": { "version": 1, "actionFusion": true, "observationPack": true }
    }
  ]
}
```

**Option 2: auto-discovery, with `sol-pi.json`.** Create `.opencode/plugins/sol-opencode.ts` in a project (or `~/.config/opencode/plugins/` for every project) containing:

```ts
export { default } from "/absolute/path/to/SoL-OpenCode/src/index.ts";
```

Then put the configuration in `.opencode/sol-pi.json` or `~/.config/opencode/sol-pi.json`.

## Configure

This conservative configuration enables only the two mechanisms that make no extra model calls:

```json
{
  "version": 1,
  "actionFusion": true,
  "observationPack": true,
  "evidencePreservingReducer": false,
  "onlineContextCompact": false,
  "cacheWriteReadRatio": 12.5
}
```

Plugin options, when present, replace the files; the project file replaces the global one. Sources are never merged. [sol-pi.example.json](sol-pi.example.json) lists every key, and [docs/configuration.md](docs/configuration.md) has the schema, defaults, and search order.

The reducer defaults to `openai/gpt-5.6-luna` through OpenCode's model runtime. Set `evidencePreservingReducerProvider` and `evidencePreservingReducerModel` to route it elsewhere. Credentials stay in OpenCode.

## Storage and security

- **Archives:** ObservationPack and the reducer archive originals under `<OpenCode data>/sol-opencode/<sessionID>/`, normally `~/.local/share/opencode/sol-opencode/`. The archives stay local and are not deleted automatically.
- **State:** Online Context Compact keeps its per-session state in OpenCode's plugin storage.
- **Remote reduction:** the reducer may send eligible diagnostic logs to its configured model.

Read [SECURITY.md](SECURITY.md) before enabling the reducer.

## Documentation

| Document | Purpose |
|---|---|
| [docs/configuration.md](docs/configuration.md) | Sources, schema, defaults, runtime inputs |
| [docs/compatibility.md](docs/compatibility.md) | OpenCode APIs used, host behaviour relied on, differences from SoL-Pi |
| [docs/verification.md](docs/verification.md) | Live results on OpenCode 2.0.18 |
| [docs/port-audit.md](docs/port-audit.md) | The Pi → OpenCode v2 API audit behind the port |
| [SECURITY.md](SECURITY.md) | Local storage, remote reduction, sensitive behavior |

## Development

```bash
npm ci --ignore-scripts
npm run check                     # tsc + the zero-spend test suite
scripts/live/verify.sh af-op      # real OpenCode session, Action Fusion + ObservationPack
scripts/live/verify.sh all        # real OpenCode session, all four mechanisms
```

The live checks need `opencode` 2.0.18 on `PATH`. They use a scripted local endpoint, so they need no credentials and cost nothing. `./upstream/` is an optional, git-ignored clone of SoL-Pi kept for reference.

## License

MIT. SoL-OpenCode derives from SoL-Pi (Copyright © 2026 NVIDIA Corporation & Affiliates, MIT); see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The research behind the mechanisms is described in the [SoL-Pi paper](https://arxiv.org/abs/2609.20519) and [blog](https://nvlabs.github.io/SoL-Pi/).
