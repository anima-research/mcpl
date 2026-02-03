# MCP Live (MCPL)

MCPL is a backward-compatible extension to the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) that enables servers to be active participants in the inference lifecycle.

## Features

- **Push Events** — Servers can push events to hosts that may trigger model inference
- **Context Hooks** — Servers can inject or modify context before and after inference
- **Server-Initiated Inference** — Servers can request autonomous inference from the host
- **Feature Sets** — Fine-grained access control for server behaviors
- **Scoped Access** — Granular permission control within feature sets

## Specification

See [SPEC.md](./SPEC.md) for the full protocol specification.

## Status

Draft specification (v0.3.0-draft). Subject to change.

## License

MIT
