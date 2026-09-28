# Security Policy

SoL-OpenCode is an OpenCode plugin. It runs inside the OpenCode server, with that process's filesystem, process, network, and credential permissions. It is not a sandbox or a permission boundary.

## Sensitive behavior

- **Action Fusion** runs a command requested by the model after a file mutation. The command goes through OpenCode's own `shell` tool, so OpenCode's shell permissions, agent rules, and `shell` hooks apply to it. The permission request is attributed to the `edit`/`write` call.
- **ObservationPack** stores large tool results under `<OpenCode data>/sol-opencode/<sessionID>/observation-pack/`.
- **Evidence-Preserving Reducer** archives diagnostic logs locally. When explicitly enabled, it sends eligible logs to its configured reducer model through `ctx.generate.text`, using OpenCode-managed credentials.
- The reducer skips text that matches its likely-secret detector, but that detector is a precaution, not a complete secret scanner. Do not enable remote reduction for workloads whose logs must remain local.
- The reducer may read a long `shell` result's full output file. It accepts only a regular, non-symlink `sh_*.out` file directly inside OpenCode's shell output directory for the current project, and only when the shell reported truncation. It copies eligible content into the session archive before any model call.
- **Online Context Compact** sends the session's older conversation to the session's own model to be summarized, through `ctx.session.generate`. See below for what it stores.
- **Project configuration.** OpenCode v2 has no project-trust gate, so a project's `.opencode/sol-pi.json` is read without one, just as its `.opencode/plugins/` code is loaded. Open untrusted repositories with care.

## Online Context Compact data

Online Context Compact is off by default. When enabled, it stores one record per session in OpenCode's plugin storage, under `occ/<sessionID>`. The record holds:

- the model-authored plan and concise progress fields;
- request counts, token-growth estimates, and compaction debt;
- the last compaction decision;
- the active checkpoint summary, which the model writes.

These values can include paths, command names, and design notes, and should be treated as sensitive as the rest of the conversation. The checkpoint summary enters outgoing requests in place of the older messages. The other state never enters the model context. The record is removed when OpenCode reports the session deleted while the plugin is loaded.

## Storage

Archives, the ObservationPack ledger, and the reducer journal stay local and are not deleted automatically. Remove `<OpenCode data>/sol-opencode/<sessionID>/` to delete a session's archives.

## Reporting a vulnerability

Use this repository's GitHub Security Advisories page to submit a private report. Do not open a public issue for a suspected vulnerability.

Include the affected commit, the configuration, the impact, reproduction steps, and any available mitigation. Send reports about OpenCode itself to the OpenCode project, and reports about the original mechanisms that also affect SoL-Pi to NVlabs/SoL-Pi.
