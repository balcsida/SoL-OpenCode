# Security Policy

SoL-OpenCode is an OpenCode plugin. It runs inside the OpenCode server, with that process's filesystem, process, network, and credential permissions. It is not a sandbox or a permission boundary.

## Sensitive behavior

- **Action Fusion** runs a command requested by the model after a file mutation. `then_run` is offered, and its command run, only for an agent whose current request includes OpenCode's `shell` tool. The command goes through that tool, so OpenCode's shell permissions, agent rules, and `shell` hooks apply to it. The permission request is attributed to the `edit`/`write` call. A command the user declines is not run.
- **ObservationPack** stores large tool results under `<OpenCode data>/sol-opencode/<sessionID>/observation-pack/`. A stored result can hold whatever the tool printed, including file contents.
- **Evidence-Preserving Reducer** archives diagnostic logs locally. When explicitly enabled, it sends eligible logs to its configured reducer model through `ctx.experimental.generate.text`, using OpenCode-managed credentials.
- The reducer does not send a log that looks like it carries a credential. It looks for a credential word followed by an assignment (`api_key=`, `Authorization:`, `client_secret:`), a quoted value assigned to a password, private key, or auth token (`password = "…"`), an assignment in an environment dump, connection string, query string, or command line (`…TOKEN=`, `Password=`, `?sig=`, `--password …`), `user:password@` in a URL, a private key block, a JWT, and the token formats of AWS, GitHub, GitLab, OpenAI, Anthropic, Stripe, Slack, Google, npm, and Hugging Face. It does not recognize an unquoted `password: value` or `password=value`, which read like the code that test logs quote. This check is a precaution, not a complete secret scanner. Do not enable remote reduction for workloads whose logs must remain local.
- The reducer may read a long `shell` result's full output file. It accepts only a regular, non-symlink `sh_*.out` file directly inside OpenCode's shell output directory for the current project, and only when the shell reported truncation. It does not read a file larger than 1.8 MB, which is more than the reducer accepts. It copies eligible content into the session archive before any model call.
- **Online Context Compact** asks OpenCode to compact the session (`ctx.session.compact`), which sends the conversation to the session's own model to be summarized, as `/compact` does. See below for what it stores.
- **Project configuration.** OpenCode v2 has no project-trust gate, so a project's `.opencode/sol-pi.json` is read without one, just as its `.opencode/plugins/` code is loaded. Open untrusted repositories with care.

## Online Context Compact data

Online Context Compact is off by default. When enabled, it stores one record per session in OpenCode's plugin storage, under `occ/<sessionID>`. The record holds:

- the model-authored plan and the progress notes of its latest completed steps;
- request counts, token-growth estimates, and compaction debt;
- the last compaction decision.

These values can include paths, command names, and design notes, and should be treated as sensitive as the rest of the conversation. None of this state enters the model context. The compaction summary is OpenCode's own, and OpenCode stores it in the session. The record is removed when OpenCode reports the session deleted while the plugin is loaded.

## Storage

Archives, the ObservationPack ledger, and the reducer journal stay on this machine. On POSIX systems only their owner can read the directories and files. Each mechanism removes what it stored for a session when OpenCode reports the session deleted while the plugin is loaded with that mechanism enabled. A session deleted at any other time leaves `<OpenCode data>/sol-opencode/<sessionID>/` behind; remove that directory to delete its archives.

## Reporting a vulnerability

Use this repository's GitHub Security Advisories page to submit a private report. Do not open a public issue for a suspected vulnerability.

Include the affected commit, the configuration, the impact, reproduction steps, and any available mitigation. Send reports about OpenCode itself to the OpenCode project, and reports about the original mechanisms that also affect SoL-Pi to NVlabs/SoL-Pi.
