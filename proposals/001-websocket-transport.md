# Proposal 001: WebSocket Transport

**Status:** Accepted — incorporated into [SPEC.md §4.2](../SPEC.md#42-websocket-transport).
**Proposed:** March 2026.
**Adopted:** 2026-09-30.
**Source:** WebSocket portion of [PR #1](https://github.com/anima-research/mcpl/pull/1).

WebSocket carries MCPL's bidirectional requests and notifications over one persistent
connection. The transport is implemented by `McplConnection.fromWebSocket()` in
mcpl-core-ts, the `/mcpl` endpoint in mcpl-editor, and `WebSocketTransport` in
agent-framework. SPEC.md is the authoritative contract.

The adopted section reconciles the March proposal with the current protocol:

- One single-line JSON-RPC object per WebSocket text **message**, with fragmentation
  handled by the WebSocket implementation. Existing stream adapters need no new framing.
- The host sends `notifications/initialized`, then completes the capability-grant exchange
  before privileged MCPL traffic begins.
- Reconnection repeats initialization and policy negotiation. The original optional
  `sessionId` resumption sketch is not adopted.
- Authentication remains endpoint-defined; no new authentication message or mandatory
  subprotocol is introduced. Ping/Pong follows WebSocket; timing remains deployment policy.
- Endpoint resolution uses §18, and reference authentication remains governed by §19.6.1.

The separate `state/update`, `state/get`, rollback-response extension, and `branches/*`
parts of PR #1 are **not adopted**. Their proposal is closed; experimental types or
producer/harness support do not establish a complete host implementation. Existing §8
state management and `state/rollback` are unchanged. Any future state-sync or branch
proposal needs its own concrete host use case and reconciliation with capability grants.
