# Proposal: WebSocket Transport for MCPL

**Status:** Draft
**Authors:** Antra
**Date:** March 2026

## Summary

Add WebSocket as a first-class transport for MCPL connections, alongside MCP's existing stdio and Streamable HTTP transports.

## Motivation

MCP defines two standard transports: **stdio** (local child process) and **Streamable HTTP** (remote, stateless). MCPL extends MCP with bidirectional, stateful, low-latency message patterns that are poorly served by both:

| MCPL Pattern | stdio | Streamable HTTP | WebSocket |
|---|---|---|---|
| Push events (server → host) | Works | Requires open SSE stream + separate POST | Native bidirectional |
| Context hooks (host → server → host) | Works | Client must POST, server responds in SSE — awkward round-trip across two channels | Native request/response |
| State/update (server → host) | Works | Server cannot initiate; must piggyback on SSE from a GET | Native |
| Branches (server → host) | Works | Same issue | Native |
| Channels/incoming (server → host) | Works | Same issue | Native |
| Remote deployment | Not possible | Yes, but complex | Yes, simple |

**Streamable HTTP's core design tension with MCPL:** HTTP is client-initiated. The server can only send messages by: (a) responding to a client POST, or (b) pushing on an SSE stream the client opened via GET. For MCPL, where the server is an active participant that sends push events, state updates, channel messages, and branch requests at any time, this means the client must always maintain an open GET/SSE connection for the server to have a channel. This works, but adds complexity:

- The client must manage two concurrent channels (POST for outbound, SSE for inbound)
- Server-initiated requests (push/event, state/update, branches/create) arrive on the SSE stream but responses must go back via POST — splitting a single logical request/response across two HTTP paths
- Session management (Mcp-Session-Id) adds statefulness on top of a stateless protocol
- SSE reconnection and resumability add complexity (Last-Event-ID, per-stream event IDs)

**WebSocket is the natural transport for MCPL.** It provides:
- A single persistent bidirectional channel
- Both sides can send messages at any time (no client-initiated constraint)
- Request/response pairs stay on the same connection
- Built-in connection lifecycle (open, close, error, ping/pong)
- Session = connection (no separate session ID management needed)
- Wide support: every browser, every server framework, every cloud platform
- Lower latency than HTTP POST + SSE (no per-message HTTP overhead)

## Design

### Connection Establishment

The client connects to a server-provided WebSocket URL:

```
wss://example.com/mcpl
```

The URL is the server's advertised MCPL endpoint. The path is server-defined (not prescribed by the spec).

### Message Framing

Each WebSocket text message contains exactly one JSON-RPC 2.0 message (request, response, or notification). This is the same framing as stdio (newline-delimited JSON) but without the newline delimiter, since WebSocket already frames messages.

```
Client sends: {"jsonrpc":"2.0","method":"initialize","id":1,"params":{...}}
Server sends: {"jsonrpc":"2.0","id":1,"result":{...}}
Server sends: {"jsonrpc":"2.0","method":"notifications/initialized"}
```

Binary WebSocket frames are reserved for future use and MUST be ignored by implementations that do not understand them.

### Lifecycle

1. Client opens a WebSocket connection to the server's MCPL endpoint
2. Client sends `initialize` request (same as stdio/HTTP)
3. Server responds with capabilities (including `experimental.mcpl`)
4. Client sends `notifications/initialized`
5. Normal MCPL message exchange proceeds
6. Either side may close the WebSocket to terminate the session

### Session Management

The WebSocket connection IS the session. No separate session ID is needed. If the connection drops, the client reconnects and performs a new `initialize` handshake.

Servers MAY support reconnection with session continuity by:
1. Including a `sessionId` in the `InitializeResult`
2. Accepting a `sessionId` in subsequent `initialize` requests
3. Resuming the session state (enabled feature sets, checkpoint state, open channels)

This is OPTIONAL. The default behavior is that each connection is a fresh session.

### Authentication

WebSocket connections support authentication via:

1. **URL query parameters:** `wss://example.com/mcpl?token=<bearer-token>`
2. **Sec-WebSocket-Protocol header:** Client sends token as a subprotocol; server selects it to confirm
3. **First-message auth:** Client sends an authentication message before `initialize`

The spec does not prescribe a specific mechanism. Servers SHOULD document their authentication requirements.

Note: The standard `Authorization` header is not reliably supported by browser WebSocket APIs, which is why alternatives are needed.

### Heartbeat

Implementations SHOULD use WebSocket ping/pong frames for connection keepalive:
- Clients SHOULD send ping frames at least every 30 seconds
- Servers MUST respond with pong frames
- Either side MAY close the connection if no ping/pong is received within 60 seconds

### Relationship to Existing Transports

WebSocket is an ADDITIONAL transport, not a replacement:

| Transport | Use Case |
|---|---|
| **stdio** | Local development, host spawns server as child process |
| **Streamable HTTP** | Remote servers, environments where WebSocket is unavailable (corporate proxies, serverless) |
| **WebSocket** | Remote servers with persistent bidirectional communication (MCPL's primary use case) |

Servers MAY support multiple transports simultaneously. For example, the mcpl-editor serves:
- `wss://host/mcpl` — WebSocket for MCPL connections
- Browser clients on a separate `wss://host/ws` endpoint

### Capability Advertisement

Servers advertise their WebSocket endpoint in their deployment configuration or service discovery. This is out of scope for the protocol itself — it is an operational concern, similar to how stdio servers are configured via `command` + `args` in MCP client configs.

Example host configuration:

```jsonc
{
  "mcplServers": {
    "editor": {
      "url": "wss://mcpl-editor-production.up.railway.app/mcpl",
      "transport": "websocket",
      "token": "...",
      "enabledFeatureSets": ["editor.*"]
    }
  }
}
```

## Implementation

### mcpl-core-ts

Already implemented: `McplConnection.fromWebSocket(ws)` factory that bridges WebSocket frames to the existing `McplConnection` API. Uses `PassThrough` streams internally so the same message routing, request tracking, and timeout logic works unchanged.

### Server Side (mcpl-editor)

Already implemented: Express HTTP server with `ws` library, WebSocket upgrade handling at `/mcpl` path. The MCPL serve loop is transport-agnostic — it receives an `McplConnection` and doesn't know whether it's stdio, TCP, or WebSocket.

### Host Side (agent-framework)

Needs implementation: `McplServerConfig` gains an optional `url` field. When `url` is present (instead of `command`), the framework connects via WebSocket instead of spawning a child process. The `McplServerConnection` wraps the resulting `McplConnection` with the same event-based API used for stdio connections.

## Comparison with Streamable HTTP

| Aspect | Streamable HTTP | WebSocket |
|---|---|---|
| Server → client messages | Requires open SSE stream (GET) | Native (send anytime) |
| Client → server messages | HTTP POST per message | Native (send anytime) |
| Request/response pairing | Split across POST + SSE | Same connection |
| Session management | Mcp-Session-Id header | Connection = session |
| Reconnection | Last-Event-ID + resumability | Reconnect + re-initialize |
| Firewall traversal | Good (HTTP/HTTPS) | Good (WSS over 443) |
| Serverless compatibility | Good (stateless POST handlers) | Poor (requires persistent connections) |
| Browser compatibility | Partial (SSE yes, but auth headers limited) | Full (native WebSocket API) |
| Latency | HTTP overhead per message | Minimal (persistent connection) |
| Implementation complexity | High (two channels, session IDs, resumability) | Low (single bidirectional channel) |

Streamable HTTP is better for serverless environments and stateless deployments. WebSocket is better for persistent, bidirectional, low-latency connections — which is MCPL's primary use case.

## Open Questions

1. **Should WebSocket be specified in the MCPL spec or proposed upstream to MCP?** Since MCP allows custom transports, WebSocket could be an MCPL-specific transport. Alternatively, it could be proposed to the MCP spec as a third standard transport.

2. **Authentication standardization.** Should MCPL prescribe a specific auth mechanism for WebSocket, or leave it server-defined?

3. **Multiplexing.** Should a single WebSocket connection support multiple logical sessions (e.g., for multi-tenant servers)? Current design says no — one connection, one session.
