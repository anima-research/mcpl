# MCP Live (MCPL)

MCPL is a backward-compatible extension to the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) that enables servers to be active participants in the inference lifecycle.

## Features

- **Push Events** — Servers can push events to hosts that may trigger model inference
- **Context Hooks** — Servers can inject context before inference, with observation and injection granted separately
- **Server-Initiated Inference** — Servers can request autonomous inference from the host
- **Capability Grants** — Host-controlled authorization for server behaviors
- **Feature Sets** — Named behavior bundles derived from the capability grant
- **Event Tags** — Semantic labels for host-controlled event treatment
- **Manifest Changes** — Hosts re-fetch and compare announced server changes
- **WebSocket Transport** — Persistent bidirectional connections with the same capability negotiation as other transports
- **Endpoint URIs** — `mcpl://` locators resolve to secure WebSocket endpoints
- **Bulk Content References** — Bounded references to large payloads, with host-controlled fetching and context inclusion
- **Tool Classes** — A coarse class per tool, a hint hosts can key policy on
- **Event Coalescing** — Servers can replace or withdraw their own unread events for a subject, or have the host ask for the content when a model is about to see it; what a model has seen is never rewritten
- **Tool Presence and Toolsets** — Hints about which tools belong in a model's stable tool list, which are available now, and which toolsets are open

## Specification

See [SPEC.md](./SPEC.md) for the full protocol specification.

[WebSocket transport](./SPEC.md#42-websocket-transport) is adopted separately from the
state/branches proposal; see the [accepted transport proposal](./proposals/001-websocket-transport.md).

## Status

Draft specification (v0.5.0-draft). Subject to change. SPEC.md is the authoritative
integrated text; RFC files preserve proposal and review history.

| RFC | Status | Integrated specification |
|---|---|---|
| [001: Event Tags](./RFC-001-event-tags.md) | Accepted; incorporated | [§16](./SPEC.md#16-event-tags) |
| [002: Capability Grants](./RFC-002-capability-grants.md) | Accepted; incorporated | [§5.4](./SPEC.md#54-capability-grants), [§6.7](./SPEC.md#67-negotiated-policy), [§14](./SPEC.md#14-channels-of-communication) |
| [003: Manifest Changes](./RFC-003-manifest-changes.md) | Accepted; incorporated | [§17](./SPEC.md#17-server-manifest-changes) |
| [004: Endpoint URIs](./RFC-004-mcpl-uri-scheme.md) | Accepted; incorporated | [§18](./SPEC.md#18-endpoint-uris) |
| [005: Bulk Content References](./RFC-005-bulk-content-references.md) | Draft; incorporated, acceptance pending executable vectors | [§19](./SPEC.md#19-bulk-content-references) |
| [006: Event Coalescing](./RFC-006-event-coalescing.md) | Draft; incorporated | [§20](./SPEC.md#20-event-coalescing) |
| [008: Tool Classes](./RFC-008-tool-classes.md) | Draft; incorporated, acceptance pending executable vectors | [§13.6](./SPEC.md#136-tool-classes) |
| [014: Tool Presence, Toolsets and Surfaces](./RFC-014-surfaces.md) | Draft; §1–§13 incorporated, without §8.6 and §10's item on surface hosts | [§21](./SPEC.md#21-tool-presence-toolsets-and-surfaces) |

RFC-005's incorporation into the draft does not waive its [acceptance criterion](./RFC-005-bulk-content-references.md#11-conformance-vectors):
freeze executable vectors under `conformance/` and run them against a strict schema/parser
implementation and a host-treatment implementation.

## License

MIT
