# Configuration

SoL-OpenCode reads one effective configuration when the plugin loads. Every mechanism is disabled unless the configuration enables it.

## Sources

The first source that exists wins. Sources are never merged.

1. **Plugin options.** Any non-empty `options` object on the plugin's entry in `opencode.json(c)`. The options must be a complete configuration in the schema below.
2. `<location directory>/.opencode/sol-pi.json`, where the location directory is the project OpenCode runs in.
3. `<OpenCode config directory>/sol-pi.json`. The directory is `$OPENCODE_CONFIG_DIR` when set, otherwise `$XDG_CONFIG_HOME/opencode`, normally `~/.config/opencode`.
4. Built-in defaults, with everything disabled.

OpenCode v2 has no project-trust concept and loads code from `.opencode/plugins/` automatically. The project file is therefore read without a trust check: a project that can ship `sol-pi.json` can already ship a plugin.

## Schema

```json
{
  "version": 1,
  "actionFusion": false,
  "observationPack": false,
  "evidencePreservingReducer": false,
  "evidencePreservingReducerProvider": "openai",
  "evidencePreservingReducerModel": "gpt-5.6-luna",
  "onlineContextCompact": false,
  "cacheWriteReadRatio": 12.5
}
```

The schema is SoL-Pi's.

- **`version`:** must be `1`.
- **Feature keys:** may be omitted and then default to `false`.
- **`cacheWriteReadRatio`:** defaults to `12.5`. When present it must be a finite, non-negative number; `0` explicitly means a cache write adds no cost relative to a cache read.
- **`evidencePreservingReducerProvider` / `evidencePreservingReducerModel`:** default to `openai` / `gpt-5.6-luna`, OpenCode's counterpart of SoL-Pi's `openai-codex/gpt-5.6-luna`. When present each must be a non-empty string. Surrounding whitespace is removed.
- **Fatal errors:** unknown keys, an unsupported version, malformed JSON, non-boolean feature values, invalid ratios, and invalid reducer fields all stop the plugin from loading, with a direct error.

Validate a file before starting OpenCode:

```bash
node scripts/check-sol-pi-config.mjs --config /absolute/path/to/sol-pi.json
node scripts/check-sol-pi-config.mjs --config /absolute/path/to/sol-pi.json --require-all-enabled
```

## Feature behavior

- **`actionFusion`:** adds an optional `then_run: { command, timeout? }` (timeout in milliseconds) to OpenCode's built-in `edit` and `write` tools. After a successful mutation, the command runs through OpenCode's `shell` tool.
- **`observationPack`:** projects large repeated tool results as placeholders in outgoing requests, and registers `obs_recall`.
- **`evidencePreservingReducer`:** reduces long diagnostic logs through the configured reducer route, and registers `evidence_recall`.
- **`evidencePreservingReducerProvider` / `evidencePreservingReducerModel`:** the OpenCode `providerID` and model `id` passed to `ctx.generate.text`. OpenCode resolves the model and its credentials. Never put credentials in `sol-pi.json`.
- **`onlineContextCompact`:** registers `update_plan` and compacts at completed plan steps when the economic gate or window pressure selects it.
- **`cacheWriteReadRatio`:** the single ratio Online Context Compact's economic gate uses. It is fixed for the loaded plugin, does not read model prices, and is not a cost report.

## Runtime inputs

- **Storage:** archives and journals live under `<OpenCode data>/sol-opencode/<sessionID>/`. The data directory is `$XDG_DATA_HOME/opencode`, normally `~/.local/share/opencode`. Online Context Compact state lives in the plugin's `ctx.storage` under `occ/<sessionID>`.
- **Context window:** read from `ctx.model.list()` for the request's model.
- **Provider-counted context size:** read from `session.step.ended` events.

SoL-OpenCode reads no dedicated environment variables. It follows OpenCode's own `XDG_*` and `OPENCODE_CONFIG_DIR` so that its files sit beside OpenCode's.

## Example: plugin options

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
