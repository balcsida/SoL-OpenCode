# Third-Party Notices

## SoL-Pi

SoL-OpenCode is a port of [NVlabs/SoL-Pi](https://github.com/NVlabs/SoL-Pi) (commit `1559b5cb12c72da4a485bc50fe326586b216fb19`) from Pi's extension API to the OpenCode v2 plugin API. The mechanism logic, configuration schema, tests, and documentation structure derive from SoL-Pi, which is released under the MIT License:

```text
Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

Source files carried over from SoL-Pi keep NVIDIA's SPDX copyright line alongside the SoL-OpenCode line. SoL-Pi's paper and blog describe the original research: [arXiv:2609.20519](https://arxiv.org/abs/2609.20519), <https://nvlabs.github.io/SoL-Pi/>. SoL-OpenCode is not an NVIDIA or OpenCode project.

## Runtime dependency

| Package | Pinned version | License | Source |
|---|---:|---|---|
| `@opencode/plugin` | 2.0.18 | MIT | <https://github.com/anomalyco/opencode> |

`@opencode/plugin` brings its own transitive dependencies (among them `effect`, `zod`, and the `@opencode/*` schema and client packages), which retain their licenses. SoL-OpenCode imports only `@opencode/plugin`. At runtime OpenCode supplies the plugin host.

## Development-only dependencies

`@types/node` (MIT), TypeScript (Apache-2.0), and Vitest (MIT) are used to type-check and test the repository. Exact versions and transitive metadata are recorded in `package-lock.json`.
