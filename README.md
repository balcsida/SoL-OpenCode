# SoL-OpenCode

SoL-OpenCode ports [SoL-Pi](https://github.com/NVlabs/SoL-Pi)'s four opt-in token-efficiency mechanisms (Action Fusion, ObservationPack, Evidence-Preserving Reducer, and Online Context Compact) from Pi's extension API to an [OpenCode v2](https://opencode.ai/v2/docs/build/plugins/) plugin built on `@opencode/plugin`.

The port is in progress. See [docs/port-audit.md](docs/port-audit.md) for the API mapping and design decisions.

## Development

```bash
npm ci --ignore-scripts
npm run check
```

## License

MIT. SoL-OpenCode derives from SoL-Pi (MIT, NVIDIA); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
