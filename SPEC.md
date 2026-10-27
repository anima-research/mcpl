# MCP Live (MCPL) Protocol Specification

**Version:** 0.5.0-draft  
**Status:** Draft  
**Authors:** Antra  
**Date:** September 2026

---

## Abstract

MCP Live (MCPL) is a backward-compatible extension to the Model Context Protocol (MCP) that adds:

1. **Push Events** — Servers can push events to hosts that may trigger model inference
2. **Context Hooks** — Servers can inject context before inference (multimodal)
3. **Server-Initiated Inference** — Servers can request autonomous inference from the host
4. **Capability Grants** — Host-computed, hierarchical authorization separating observation from authority to alter
5. **Feature Sets** — Named behavior bundles, derived from the grant
6. **Event Tags** — Namespaced semantic labels letting hosts route attention portably
7. **Manifest Changes** — Servers announce that their surface changed; hosts re-fetch and diff rather than trusting a payload
8. **Endpoint URIs** — `mcpl://` names an MCPL endpoint as such; resolves deterministically to `wss://` and confers nothing
9. **Bulk Content References** — Small testimony about large payloads; a server can veto context inclusion but never expand it
10. **Channels** — Named, host-controlled destinations: a server registers the channels it handles, delivers their inbound messages, and delivers what the host publishes to them
11. **State Management** — Stateful tools with checkpoints, branching and rollback, opt-in for hosts
12. **Model Information** — Servers can ask the host which model is in use, and which others it exposes
13. **WebSocket Transport** — One persistent, bidirectional connection, alongside MCP's stdio and Streamable HTTP transports
14. **Tool Classes** — Servers say what each tool does in a coarse, fixed vocabulary; hosts key policy on it, and an unclassed tool gets the strictest handling
15. **Event Coalescing** — Unconsumed events are mutable by their sender; consumed events are history, and history is never rewritten
16. **Tool Presence and Toolsets** — Hints about tools (whether each belongs in a model's stable tool list, whether it is available now, which toolset it belongs to) and toolsets the host opens and closes; how tools reach a model is left to the host

MCPL enables servers to be active participants in the inference lifecycle rather than passive tool providers.

---

## Table of Contents

- [Conventions and terms](#conventions-and-terms)

1. [Motivation](#1-motivation)
2. [Design Goals](#2-design-goals)
3. [Compatibility](#3-compatibility)
4. [Protocol Overview](#4-protocol-overview)
   - [WebSocket Transport](#42-websocket-transport)
5. [Capability Negotiation](#5-capability-negotiation)
6. [Feature Sets](#6-feature-sets)
7. [Scoped Access — removed in 0.5.0](#7-scoped-access--removed-in-050)
8. [State Management](#8-state-management)
9. [Push Events](#9-push-events)
10. [Context Hooks](#10-context-hooks)
11. [Server-Initiated Inference](#11-server-initiated-inference)
12. [Model Information](#12-model-information)
13. [Security Considerations](#13-security-considerations)
14. [Channels of Communication](#14-channels-of-communication)
15. [Examples](#15-examples)
16. [Event Tags](#16-event-tags)
17. [Server Manifest Changes](#17-server-manifest-changes)
18. [Endpoint URIs](#18-endpoint-uris)
19. [Bulk Content References](#19-bulk-content-references)
20. [Event Coalescing](#20-event-coalescing)
21. [Tool Presence, Toolsets and Surfaces](#21-tool-presence-toolsets-and-surfaces)

- [Appendix A: Error Codes](#appendix-a-error-codes)
- [Appendix B: Schema](#appendix-b-schema)
- [Changelog](#changelog)

---

## Conventions and terms

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be
interpreted as described in BCP 14 ([RFC 2119](https://www.rfc-editor.org/rfc/rfc2119),
[RFC 8174](https://www.rfc-editor.org/rfc/rfc8174)) when, and only when, they appear in all
capitals, as shown here.

Some sections and notes are marked non-normative (§11.5, the implementation note in §17.10,
§19.12, §20.8, §20.9), and §13.6, §19, §20 and §21 carry Draft strength within this draft, as
their status notes explain.

Terms used throughout:

- **Host.** The application that connects to servers and runs model inference. It computes
  each connection's effective grant (§5.4) and decides what reaches model context.
- **Server.** The other end of a connection. It is an MCP server, and an MCPL server when it
  advertises `experimental.mcpl` (§3, §5.1).
- **Agent.** The model-driven participant on whose behalf the host runs inference. An event
  can be addressed to it (§16.2), `channels/publish` delivers its speech (§13.1), and the
  host tells it or an operator about manifest changes (§17.6). This term doesn't define the
  word in tag names such as `chat:from-agent` (§16.2).
- **Capability path**, **effective grant.** Defined in §5.4.
- **Manifest.** The complete `experimental.mcpl` object a server presents (§5.1, §17.1).
- **Testimony.** What a server states about itself or its content, such as its feature sets,
  tags, manifest revision and reference-block fields. The host weighs testimony, and
  testimony confers no authority (§5.4, §16.6, §17.1, §19.1).
- **Wake.** The host starting an inference because of an event, such as a `push/event`, a
  `channels/incoming` message or a change receipt (§17.6). Host policy decides whether an
  event wakes the agent (§16).
- **Wake text.** What the host assembles into context to present the event that caused a
  wake.

---

## 1. Motivation

MCP provides a solid foundation for model-context integration:

- **Resources** allow models to read external data (passive, pull-based)
- **Resource subscriptions** notify when resources change (but don't trigger inference)
- **Sampling** (`sampling/createMessage`) enables server-initiated inference with human-in-the-loop approval
- **Tools** let models take actions

However, gaps remain:

- **External events cannot trigger inference.** A GitLab webhook, calendar reminder, or sensor reading has no direct path to the model without polling.
- **Context cannot be dynamically shaped.** Memory systems, RAG pipelines, and personalization layers must be implemented inside the host rather than as composable servers.
- **Autonomous inference is awkward.** Servers needing inference without human approval (e.g., background summarization) must work around `sampling`'s HITL design.

MCPL addresses these gaps as an orthogonal extension:

- Resources remain passive (MCPL doesn't change this)
- Push events add a proactive event lane (semantically richer than "resource changed")
- Context hooks enable lifecycle participation
- Server-initiated inference provides autonomous inference with host policy control
- Capability grants provide granular, host-computed permissions, and feature sets name bundles of behavior derived from them (§5.4, §6)

---

## 2. Design Goals

| Goal | Rationale |
|------|-----------|
| **Backward compatible** | MCPL servers degrade gracefully in MCP hosts; MCP servers work unchanged in MCPL hosts |
| **Orthogonal extension** | Doesn't modify MCP semantics; adds new capabilities alongside existing ones |
| **Host-controlled** | Hosts decide ordering, cost limits, and trust levels; protocol expresses server preferences |
| **Granular permissions** | Capability grants let hosts allow specific capabilities without all-or-nothing trust; feature sets let users select named behaviors within the grant |
| **Minimal complexity** | Only capabilities that require protocol-level support; trust hosts and servers to be reasonable |

---

## 3. Compatibility

### 3.1 MCPL as Extension

MCPL is advertised as an experimental capability extension, not a protocol version change. This keeps MCP's `protocolVersion` semantics intact.

```jsonc
// Server capability advertisement
{
  "capabilities": {
    "tools": {},
    "resources": {},
    "experimental": {
      "mcpl": {
        "version": "0.5",
        "pushEvents": true,
        "contextHooks": { ... },
        "inferenceRequest": { ... },
        "featureSets": { ... }
      }
    }
  }
}
```

### 3.2 MCPL Server → MCP Host

The MCP host ignores `experimental.mcpl`. The server's push handlers, context hooks, and inference requests are never invoked. The server functions as a normal MCP server.

### 3.3 MCP Server → MCPL Host

The host detects missing `experimental.mcpl` and skips extended features:

- No push event handling
- No context hook invocations  
- No inference request handling

The server functions normally for tools, resources, and prompts.

---

## 4. Protocol Overview

MCPL extends the MCP message flow. MCP's own methods (`tools/call`, `resources/read`,
`sampling/createMessage`, and the rest) keep their semantics; MCPL adds the methods listed in
§4.1.

All messages use JSON-RPC 2.0, consistent with MCP.

### 4.1 Request vs Notification

Per JSON-RPC 2.0:

- **Requests** include an `id` field and expect a response with the same `id`
- **Notifications** omit `id` and expect no response

| Method | Type | Direction | Section |
|--------|------|-----------|---------|
| `push/event` | Request | Server → Host | §9 |
| `context/beforeInference` | Request | Host → Server | §10.1 |
| `inference/lifecycle` | Notification | Host → Server | §10.5 |
| `inference/request` | Request | Server → Host | §11 |
| `inference/chunk` | Notification | Host → Server | §11.4 |
| `model/info` | Request | Server → Host | §12 |
| `featureSets/update` | Notification **or Request** | Host → Server | §5.3, §6.7 |
| `state/rollback` | Request | Host → Server | §8.5 |
| `channels/register` | Request | Server → Host | §14.3, §14.5 |
| `channels/changed` | Notification **or Request** | Server → Host | §14.3, §14.5 |
| `channels/list` | Request | Either | §14.3 |
| `channels/open` | Request | Host → Server | §14.3 |
| `channels/close` | Request | Host → Server | §14.3 |
| `channels/outgoing/chunk` | Notification | Host → Server | §14.3 |
| `channels/outgoing/complete` | Notification | Host → Server | §14.3 |
| `channels/publish` | Notification or Request | Host → Server | §14.3 |
| `channels/incoming` | Request | Server → Host | §14.3 |
| `mcpl/manifestChanged` | Notification | Server → Host | §17.3 |
| `mcpl/manifest` | Request | Host → Server | §17.4 |
| `push/render` | Request | Host → Server | §20.5.2 |
| `toolsets/open` | Request | Host → Server | §21.5.2 |
| `toolsets/close` | Request | Host → Server | §21.5.2 |
| `toolsets/list` | Request | Host → Server | §21.5.3 |
| `tools/hints` | Notification | Server → Host | §21.6.1 |
| `channels/acknowledge` | Not specified | Not specified | §14.1 |
| `channels/typing` | Not specified | Not specified | §14.1 |

### 4.2 WebSocket Transport

MCPL defines WebSocket as an additional transport alongside
[MCP's stdio and Streamable HTTP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
It carries requests, responses, and notifications in both directions on
one persistent connection. The methods, capability grants, and policy ordering are the
same regardless of transport. Servers MAY offer more than one transport.

#### 4.2.1 Endpoints

The host is the WebSocket client and connects to the server's configured endpoint, for
example `wss://example.com/mcpl`. The endpoint path is server-defined; `/mcpl` is an
example, not a required path. Endpoint selection and host configuration formats are
operational concerns, not protocol fields.

`wss://` provides TLS; `ws://` remains available when explicitly configured, for example
`ws://localhost:3000/mcpl` for local development. An `mcpl://` locator resolves to
`wss://` according to §18, never to plaintext `ws://`. Opening the socket does not establish
MCPL support or grant any capability (§18.5, §5.4).

#### 4.2.2 Message framing

Each WebSocket **text message** MUST contain exactly one JSON-RPC 2.0 object: a request,
response, or notification. Senders MUST serialize the object on a single line, with
newlines within string values escaped. No newline delimiter is needed; receivers MAY
tolerate trailing whitespace for compatibility with stream adapters. Senders MUST NOT
batch multiple JSON-RPC objects into one WebSocket message.

The boundary is a complete WebSocket message, not an individual frame. The WebSocket
implementation reassembles any fragments before delivering the message to the JSON-RPC
parser, as specified by [RFC 6455 §5.4](https://www.rfc-editor.org/rfc/rfc6455.html#section-5.4).
Both peers can send messages without waiting for the other to initiate a request; response
IDs match the corresponding requests as in §4.1.

Binary messages have no defined MCPL meaning. Senders MUST use text messages for MCPL
JSON-RPC traffic. WebSocket control frames (Ping, Pong, Close) belong to the transport
and are not JSON-RPC messages.

#### 4.2.3 Initialization and policy

1. The host opens the WebSocket connection, satisfying the endpoint's authentication
   requirements (§4.2.6).
2. The host sends the MCP `initialize` request with its capabilities (§5.2).
3. The server returns the initialize result with its capabilities (§5.1).
4. The **host** sends `notifications/initialized` (a notification, without an `id`).
5. For an MCPL connection, the host sends `featureSets/update` as a Request carrying the
   effective grant, and waits for the server's receipt (§5.3, §6.7).
6. Privileged MCPL traffic proceeds under the resulting policy. Until the initial policy
   exchange completes, capability-dependent behavior remains unavailable and the host
   rejects inbound privileged methods (§5.3).
7. Either peer may close the WebSocket to end the connection.

An endpoint lacking `experimental.mcpl` is an MCP-only peer (§3.3); when reached through
an `mcpl://` locator, the host MUST apply §18.5's explicit fallback-or-failure rule.
Transport selection never substitutes for capability negotiation.

#### 4.2.4 Connection lifetime and reconnection

One WebSocket connection carries one protocol session; this transport defines neither
session multiplexing nor a resumable `sessionId`. On connection loss, outstanding requests
fail locally. A reconnect MUST open a new connection and repeat initialization and the
initial policy exchange in §4.2.3. A previous connection's grant MUST NOT become effective
on the new connection without that exchange.

Servers re-register connection-bound channels under the new grant before delivering
channel content (§14.5). Application data may persist across connections, but persistence
does not restore connection authority or channel registration. Retry and backoff are host
policy; reconnecting does not itself replay requests or imply that an interrupted operation
did not execute.

#### 4.2.5 Liveness

Implementations SHOULD use WebSocket Ping/Pong for liveness where their API permits it.
Control-frame handling follows [RFC 6455 §5.5](https://www.rfc-editor.org/rfc/rfc6455.html#section-5.5),
including Pong responses to Ping. Keepalive intervals and connection timeouts are
deployment policy; MCPL defines no fixed heartbeat interval or application-level heartbeat
method. Either peer MAY close an unresponsive connection. Transport liveness does not
replace request timeouts or the hook timeout policy (§10.6).

#### 4.2.6 Authentication

Authentication is endpoint-defined. Servers SHOULD document the mechanism, and hosts need
a compatible client API. Existing deployments use a token in the upgrade URL's query;
other deployments may authenticate the HTTP upgrade through headers or a transport-native
identity. This section mandates no query parameter, WebSocket subprotocol, or authentication
message before `initialize`.

Transport authentication does not grant MCPL capabilities: the host still computes and
negotiates the effective grant (§5.4, §6.7). Endpoint credential policy remains as described
in §18.3. Authentication used to fetch content references remains host-private and subject
to the dialed-origin binding in §19.6.1; adopting WebSocket creates no additional reference
access.

---

## 5. Capability Negotiation

### 5.1 Server Capabilities

Servers advertise MCPL support under `experimental.mcpl`:

```jsonc
{
  "capabilities": {
    // Standard MCP
    "tools": {},
    "resources": { "subscribe": true },
    "prompts": {},
    
    // MCPL extension
    "experimental": {
      "mcpl": {
        "version": "0.5",
        "revision": "sha256:QLXa7BigUFzNlw_IWPSqpYbDzdvBX7PVQIPS5lgnkaw",  // §17.2, optional
        "pushEvents": true,
        "contextHooks": {
          "beforeInference": {
            "observe": true,
            "inject": { "system": false, "beforeUser": true, "afterUser": true }
          }
        },
        "inferenceLifecycle": true,
        "inferenceRequest": { "streaming": true },
        "modelInfo": true,
        "channels": { "register": true, "publish": true, "incoming": true },
        "featureSets": { ... }  // See Section 6
      }
    }
  }
}
```

**Advertisement mirrors the capability paths.** A capability with sub-capabilities is
advertised as a nested object whose members are the leaves of §6.2's vocabulary. A boolean
`true` at any level is shorthand for "every leaf beneath this node"; `false` or absence means
none. `"beforeInference": true` therefore remains valid and means observe plus all three
injection positions — but a server that only injects should say so, and the host computes the
grant against leaves either way (§5.4).

This object is the server's **manifest**. A server that supports manifest changes (§17)
includes a `revision` member carrying its canonical content digest (§17.2); servers that do
not may omit it, and their manifest is fixed for the life of the connection.

A server that sends tool hints also advertises `toolHints`, and can declare `toolsets` and a
`surface` hint (§21.5.1, §21.6.3).

### 5.2 Host Support

The host advertises its MCPL support under `capabilities.experimental.mcpl` (mirroring the server shape). Initial feature configuration is performed via `featureSets/update` after initialization.

```jsonc
{
  "protocolVersion": "2024-11-05",  // MCP version unchanged
  "capabilities": {
    // Standard MCP capabilities here ...

    "experimental": {
      "mcpl": {
        "version": "0.5",
        "pushEvents": true,
        "contextHooks": { "beforeInference": true },
        "inferenceLifecycle": true,
        "inferenceRequest": { "streaming": true },
        "channels": { "register": true, "publish": true, "incoming": true },
        "featureSets": true
      }
    }
  }
}
```

A host that supports event coalescing also advertises `eventCoalescing` (§20.10), and one
that supports tool hints advertises `toolHints` (§21.6.3).

### 5.3 Initial Policy

After initialization, hosts **MUST** send `featureSets/update` as a **Request** (§6.7)
carrying the effective capability grant, and MUST do so:

- before the first context-hook fan-out, and
- before accepting any inbound privileged method,

and **even when nothing is enabled or disabled** — a server defaulted to fully disabled has
to be told.

Until the initial policy exchange completes, a server MUST treat every capability-dependent
behavior as unavailable, and a host MUST reject inbound privileged methods.

```jsonc
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "featureSets/update",
  "params": {
    "effectiveCapabilities": ["tools", "channels.publish",
                              "contextHooks.beforeInference.observe"],
    "deniedCapabilities": ["contextHooks.beforeInference.inject.system"],
    "enabled": ["memory.retrieval"],
    "disabled": ["memory.extraction"]
  }
}
```

The response is a degradation receipt — see §6.7.

**Field semantics:**

- **Absent `effectiveCapabilities` in a Request is a grant of nothing**, not "no change".
  Absence is denial (§5.4) and there is no unspecified state; treating it as no-alteration
  would leave a previous, wider grant standing — the §6.7 stale-authority hole.
- **Absent `enabled` constrains nothing**: capability derivation (§6.4) alone governs.
  **Present `enabled` is an allowlist**: a declared feature set it does not name is disabled
  with reason `not_selected`. Naming a set in `enabled` never supplies capabilities its
  `uses` lacks — selection narrows, it cannot widen.
- **`disabled` always subtracts**, from either form.

---

### 5.4 Capability Grants

The **capability grant** is the security boundary. Feature sets (§6) are a cooperative
convenience derived from it, and are **not** a confidentiality boundary: on a hook response
the `featureSet` is supplied by the server (§6.5), and once any enabled feature causes the
host to send a process a payload, all code in that process can read it.

- The server advertises what it **can** do in `initialize`.
- The host computes the **effective grant** per connection: what this server **may** do or
  receive. Advertisement is an input, never an authorization.
- Capability paths are dot-separated (§6.2). Matching is over full paths with `*` wildcards,
  and implementations MUST perform a **generic recursive walk** — a hardcoded set of
  nestable keys is non-conforming, since the vocabulary is depth 4 and will grow.

**`*` matches exactly one path segment, and segment counts MUST be equal.** `channels.*`
grants `channels.publish` but not `channels.publish.anything`; `contextHooks.*` grants
**none** of the depth-4 injection leaves; a bare `*` matches only depth-1 paths. A trailing
`*` is NOT a subtree match. There is no multi-segment wildcard. This is the deny-safe
reading — a mistaken narrow pattern can only under-grant, which the host observes and
corrects, while a suffix wildcard silently widens the grant class this section exists to
narrow.

**A bare parent path does not grant its leaves.** §5.1's boolean-`true` shorthand is an
*advertisement* convention only; it is not restated for the grant. `channels` in
`effectiveCapabilities` grants only the path `channels`, which no method requires.

**`effectiveCapabilities` is the sole normative allowlist**: the intersection of the
server's advertisement as the host understands it and host policy. **Every path not present
is denied**; absence is the denial, and there is no unspecified state.
`deniedCapabilities` is derived diagnostic data only, MAY be omitted, and MUST NOT
participate in any authorization decision. If a path appears in both, the receiving side
MUST fail closed and reject the policy message as malformed.

**A denied capability behaves as if never advertised.** The host MUST NOT deliver a message
requiring one, MUST reject an inbound method requiring one, and MUST NOT accept a response
contribution requiring one.

**Enforcement is evaluated at response-receipt.** For any host-initiated request whose
response carries a contribution — `beforeInference` injections, and any contribution-bearing
response added later — the host MUST authorize **each contribution** against the grant
**current when the response is received**, not when the request was sent. This makes
per-injection `position` checks well-defined when one response carries a mixed array, and
closes the in-flight window on revocation without additional machinery (§10.6 recommends a
5s hook timeout, so a hook dispatched before a revocation can return after it).

Authorization MUST NOT use the `featureSet` or `namespace` supplied in a response.

---

## 6. Feature Sets

Feature sets are named bundles of behavior, derived from the capability grant (§5.4). They
provide ergonomics and honest self-reporting; they do not provide security.

### 6.1 Declaration

Servers declare feature sets in their capabilities:

```jsonc
{
  "experimental": {
    "mcpl": {
      "featureSets": {
        "memory.retrieval": {
          "description": "Retrieve relevant memories before inference",
          "uses": ["contextHooks.beforeInference.observe",
                   "contextHooks.beforeInference.inject.system"]
        },
        "memory.extraction": {
          "description": "Extract new memories from conversations",
          "uses": ["inferenceLifecycle"]
        },
        "memory.consolidation": {
          "description": "Summarize and consolidate memories using AI inference",
          "uses": ["inferenceRequest"]
        },
        "memory.proactive": {
          "description": "Push reminders based on triggers",
          "uses": ["pushEvents"]
        }
      }
    }
  }
}
```

### 6.2 Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `description` | `string` | Yes | Human-readable description |
| `uses` | `string[]` | Yes | Capabilities used (see below) |

**Valid `uses` values** are capability paths (§5.4):

```
pushEvents
tools
modelInfo
inferenceRequest
inferenceRequest.streaming
inferenceLifecycle

contextHooks.beforeInference.observe
contextHooks.beforeInference.inject.system
contextHooks.beforeInference.inject.beforeUser
contextHooks.beforeInference.inject.afterUser

channels.register
channels.lifecycle
channels.publish
channels.incoming
channels.streaming
channels.acknowledge
channels.typing
```

`uses` MUST contain only these values. A feature set whose `uses` is absent, empty, or
contains an unrecognized value is **invalid**: the host disables it with reason
`invalid_uses` (§6.6).

### 6.3 Hierarchical Naming

Feature sets use dot-separated names enabling bulk operations:

```
memory.retrieval
memory.extraction  
memory.consolidation
```

Hosts MAY support wildcards: `memory.*` enables/disables all `memory.` features.

### 6.4 Derivation from the capability grant

Feature sets do not carry authority of their own. A denied capability disables every
declared feature set whose `uses` requires it.

The derivation MUST fail closed:

1. **Absent, empty, or unrecognized `uses`** ⇒ the declaration is invalid; the feature set
   is disabled with reason `invalid_uses`. The host does not guess what it meant.
2. **Valid but incomplete `uses`** ⇒ the connection grant still protects. When the server
   later exercises a capability its feature set did not declare, the host rejects that use
   and emits a **declaration-mismatch** diagnostic. Security never depended on the
   declaration.
3. **A server MAY report further needs in its receipt** (§6.7), from knowledge of its own
   implementation. That is testimony, not host derivation, and confers nothing.

Implementations SHOULD warn at declaration time when a server exercises a capability absent
from the exercising feature set's `uses`.

### 6.5 Tagging Messages

**Server-initiated messages** (push events, inference requests) MUST include `featureSet`:

```jsonc
{
  "jsonrpc": "2.0",
  "method": "push/event",
  "id": 1,
  "params": {
    "featureSet": "memory.proactive",
    ...
  }
}
```

**Host-initiated messages** (context hooks) do NOT include `featureSet`. The server includes `featureSet` in its response:

```jsonc
// Host → Server (no featureSet)
{
  "jsonrpc": "2.0",
  "method": "context/beforeInference",
  "id": 5,
  "params": { "inferenceId": "inf_xyz", ... }
}

// Server → Host (includes featureSet)
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "featureSet": "memory.retrieval",
    "contextInjections": [...]
  }
}
```

### 6.6 Rejection and diagnostics

Rejection is **diagnostics, not authorization** — authorization is the grant (§5.4). A
server MUST NOT depend on being told; the negotiated policy of §6.7 is what informs it.

When a host does reject, it MUST use a JSON-RPC **error object**, not a result carrying a
failure flag, and MUST populate the documented code:

```jsonc
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32001,
    "message": "Feature set not enabled",
    "data": { "featureSet": "memory.consolidation" }
  }
}
```

For unknown feature sets, hosts SHOULD reject with `-32003`; for a denied capability,
`-32002` with `data: { capability }`.

**A method that will never be answered MUST return an error.** Silently sending no response
to a request bearing an `id` leaves the caller hanging and makes the surface impossible to
evaluate — apparent disuse becomes a measurement artifact rather than a signal.

### 6.7 Negotiated policy

`featureSets/update` (Host → Server) MAY be sent as a Notification or as a Request — the
same optional-ACK idiom §14.3 uses for `channels/publish`.

Hosts **MUST** send it as a Request for **any change to the effective grant**: initial
policy (§5.3), reductions, and expansions. Notifications remain valid only for purely
descriptive feature metadata that does not alter the grant, and a Notification **cannot
establish a ready state**.

**Server handling of a non-conforming Notification** (one that nevertheless carries grant
fields): apply a narrowing `disabled` list — a reduction binds whatever carries it, as
below — and **ignore everything else** with a diagnostic. `effectiveCapabilities`,
`enabled`, and any widening are discarded: honouring a widening from an unacknowledgeable
message would have the server acting on a path the host cannot know it accepted.

**The response is a degradation receipt**, not an acknowledgement:

```jsonc
{
  "jsonrpc": "2.0", "id": 7,
  "result": {
    "accepted": true,
    "mode": "degraded",
    "unavailableFeatures": [
      { "featureSet": "memory.extraction",
        "missingCapabilities": ["inferenceLifecycle"],
        "effect": "disabled" }
    ],
    "notes": []
  }
}
```

Or a refusal, which names its own consequence rather than leaving the host to guess:

```jsonc
{ "accepted": false, "fallback": "mcp-only", "missingCapabilities": [...], "reason": "…" }
```

**`fallback` is REQUIRED when `accepted` is `false`** — naming the consequence is the
server's job, and its absence is a silent value at exactly the point the host chooses
between mcp-only and closing the transport. Each `unavailableFeatures` entry MUST carry
`effect`. When nothing degraded, **omit `mode`** rather than inventing a value — an absent
field cannot be misread as a claim.

**Consequence testimony is not policy authority.** The receipt reports what the server
*will do*; it does not assert what the server is *entitled to*. The host **MUST NOT** widen
any grant in response to a receipt. A refusal MAY be surfaced to a human for a new decision;
it MUST NOT reach the policy engine as an input. Otherwise refusal becomes a coercion lever
— *"I will not start unless you grant `inject.system`"* — and a host that widens to satisfy
a refusal has inverted the trust direction.

`accepted: false` does **not** mean close the transport. MCPL is an experimental extension
(§3.1) and §3.2 already defines the weaker outcome: disable MCPL, retain tools, resources
and prompts. The server names which applies via `fallback: "mcp-only" | "close"`. The host
MAY close regardless.

**Revocation and expansion have mirrored orderings.** A security-reducing change takes
effect **atomically first**, then the host sends the Request and the server acknowledges or
refuses; security cannot wait on consent. An expansion is the reverse: the host sends the
Request, waits for the receipt, and **only then** begins fan-out on newly granted hooks or
accepts newly granted inbound methods. Reducing late leaves a window of over-permission;
expanding early sends on a path the recipient does not yet believe it has. An unanswered
expansion simply does not activate.

Servers MUST immediately respect a reduction.

**`featureSets/changed` is removed in 0.5.0.** It carried a server-authored account of what
had changed, which is the self-attestation defect §5.4 exists to remove.

The manifest mechanism of §17 (`mcpl/manifestChanged` + `mcpl/manifest`) lets a server
announce a changed manifest and the host re-fetch and diff it, rather than trust a payload.

---

## 7. Scoped Access — removed in 0.5.0

Removed in 0.5.0. The Changelog keeps why it was removed and the form any return of mid-run
elevation would take. Per-channel narrowing (patterns like `discord:acme/*`)
attaches to the grant entry (§14.5), not to a separate layer.

---

## 8. State Management

MCPL supports stateful tools with branching state. Servers choose per-response whether to include state data for host persistence or manage state internally.

Hosts are not required to implement the full checkpoint tree or branching. A minimal host may track only the latest checkpoint, or ignore state entirely. Branching and rollback are opt-in capabilities that hosts advertise and implement to the extent they choose.

Compatibility note: MCPL extends MCP `tools/call` with optional parameters such as `state` and `checkpoint`. Servers MUST tolerate and ignore unknown request fields, and hosts MUST tolerate unknown response fields, to preserve backward compatibility.

### 8.1 Capability Declaration

Feature sets declare rollback support:

```jsonc
{
  "featureSets": {
    "notes.edit": {
      "description": "Manage notes",
      "uses": ["tools"],
      "rollback": true
    },
    "git.commit": {
      "description": "Git operations",
      "uses": ["tools"],
      "rollback": true
    }
  }
}
```

### 8.2 Checkpoints and Lineage

Responses from stateful operations include checkpoint information:

```jsonc
{
  "result": {
    "content": [...],
    "state": {
      "checkpoint": "chk_def",
      "parent": "chk_abc"
    }
  }
}
```

Checkpoints form a tree. Rolling back and performing new operations creates branches:

```
chk_abc
├── chk_def (original branch)
└── chk_xyz (branch after rollback to abc)
```

### 8.3 State Data

Servers may include `data` or `patch` in state responses. When present, host stores it and provides it back with subsequent requests.

**Full state:**

```jsonc
{
  "state": {
    "checkpoint": "chk_abc",
    "parent": null,
    "data": { "notes": [] }
  }
}
```

**Delta (JSON Patch, RFC 6902):**

```jsonc
{
  "state": {
    "checkpoint": "chk_def",
    "parent": "chk_abc",
    "patch": [
      { "op": "add", "path": "/notes/-", "value": { "id": 1, "text": "Remember to..." } }
    ]
  }
}
```

Host applies patches to reconstruct current state. Server may send `data` (full state) or `patch` (delta) as appropriate.

When no `data` or `patch` is included, the checkpoint is an opaque reference and the server manages state internally.

### 8.4 State in Requests

Host includes whatever state it has with requests:

```jsonc
// Host has state data (server previously included data/patch)
{
  "method": "tools/call",
  "params": {
    "name": "add_note",
    "state": { "notes": [{ "id": 1, "text": "Remember to..." }] },
    "arguments": { "text": "Buy groceries" }
  }
}

// Host has only checkpoint reference (server manages state internally)
{
  "method": "tools/call",
  "params": {
    "name": "git_commit",
    "checkpoint": "chk_def",
    "arguments": { "message": "Fix bug" }
  }
}
```

Server processes the request and returns new state:

```jsonc
{
  "result": {
    "content": [{ "type": "text", "text": "Note added" }],
    "state": {
      "checkpoint": "chk_ghi",
      "parent": "chk_def",
      "patch": [
        { "op": "add", "path": "/notes/-", "value": { "id": 2, "text": "Buy groceries" } }
      ]
    }
  }
}
```

### 8.5 state/rollback (Host → Server, Request)

Host requests rollback to a previous checkpoint:

```jsonc
{
  "jsonrpc": "2.0",
  "method": "state/rollback",
  "id": 1,
  "params": {
    "featureSet": "notes.edit",
    "checkpoint": "chk_abc"
  }
}
```

### 8.6 Rollback Response

```jsonc
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "checkpoint": "chk_abc",
    "success": true
  }
}
```

If rollback fails (e.g., irreversible external effects):

```jsonc
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "checkpoint": "chk_abc",
    "success": false,
    "reason": "External API call cannot be undone"
  }
}
```

Rollback is best-effort. Servers may not be able to undo all operations.

### 8.7 Checkpoint Retention

Servers decide checkpoint retention policy. Hosts SHOULD NOT assume checkpoints are retained indefinitely. If a rollback targets a pruned checkpoint, server returns an error:

```jsonc
{
  "error": {
    "code": -32005,
    "message": "Checkpoint not found",
    "data": { "checkpoint": "chk_old" }
  }
}
```

---

## 9. Push Events

Push events allow servers to notify the host of external occurrences that may warrant model inference. This is a separate proactive lane from MCP's passive resource subscriptions.

### 9.1 push/event (Server → Host, Request)

```jsonc
{
  "jsonrpc": "2.0",
  "method": "push/event",
  "id": 1,
  "params": {
    "featureSet": "gitlab.notifications",
    "eventId": "evt_abc123",
    "timestamp": "2026-01-23T10:30:00Z",
    "origin": {
      "server": "gitlab-integration",
      "webhook": "push",
      "repository": "acme/backend"
    },
    "payload": {
      "content": [
        { "type": "text", "text": "New commit on main by alice: 'fix auth bug' in acme/backend" }
      ]
    }
  }
}
```

### 9.2 Parameters

`push/event` params MAY carry `tags: string[]` (§16) — namespaced semantic labels the host
may route attention on. Tags are descriptive claims and never authority (§16.6).

Params can also carry `coalesce`, for event coalescing, which includes deferred events and
the `push/render` request (§20, §20.5). Params can also carry `hints`, `toolset` and
`instance`, for tool hints and toolsets (§21.6.1, §21.7).

`payload.content` MAY contain reference blocks (§19). Hosts MUST apply the §19.5 stub
treatment *before* wake-text assembly, so an attached payload never inflates the cost of
the wake that announces it (§19.4).


| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `featureSet` | `string` | Yes | Declaring feature set |
| `eventId` | `string` | Yes | Unique event identifier (for idempotency) |
| `timestamp` | `string` (ISO 8601) | Yes | When the event occurred |
| `origin` | `object` | No | Provenance metadata (arbitrarily detailed, server-defined) |
| `payload` | `object` | Yes | Event payload |
| `payload.content` | `ContentBlock[]` | Yes | Content for the model to interpret |

### 9.3 Response

```jsonc
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "accepted": true,
    "inferenceId": "inf_xyz"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `accepted` | `boolean` | Whether the event was accepted |
| `inferenceId` | `string` | Present if inference was triggered |
| `reason` | `string` | Present if `accepted: false` |

When the event carried `coalesce`, the result can also carry a `coalesce` member reporting the
coalescing outcome (§20.7).

### 9.4 Idempotency

Hosts SHOULD deduplicate events by `eventId`. Servers SHOULD use stable `eventId` values for retries.

§20.3.1 amends this rule, at Draft strength: deduplication is by occurrence, including on
`channels/incoming`, and occurrences carrying `coalesce` get a guaranteed retry window.
§21.6.1 adds, at Draft strength, that a push carrying `hints` is never retried.

---

## 10. Context Hooks

Context hooks allow servers to inject or modify context at inference boundaries. Injections support multimodal content.

### 10.1 context/beforeInference (Host → Server, Request)

```jsonc
{
  "jsonrpc": "2.0",
  "method": "context/beforeInference",
  "id": 1,
  "params": {
    "inferenceId": "inf_xyz",
    "conversationId": "conv_123",
    "turnIndex": 7,
    "userMessage": null,
    "model": {
      "id": "claude-opus-4-5-20251101",
      "vendor": "anthropic",
      "contextWindow": 200000,
      "capabilities": ["vision", "tools"]
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `inferenceId` | `string` | Unique identifier for this inference |
| `conversationId` | `string` | Persistent across turns |
| `turnIndex` | `integer` | 0-indexed turn number |
| `userMessage` | `string \| null` | User input. `null` for continued generation, **and `null` whenever `contextHooks.beforeInference.observe` is not granted** |
| `model` | `ModelInfo` | Current model metadata |

**Observation and injection are independently granted.** A host MUST still invoke
`context/beforeInference` for a server granted any `inject.*` leaf but denied `observe`, and
MUST send `userMessage: null` in that case. The hook is *how injection happens*; withholding
the call would deny injection along with observation.

This is what makes write-without-read real rather than nominal. A server that appends a body
status line has no need of the user's text, and under this rule is never handed it.
`inferenceId`, `conversationId` and `turnIndex` are correlation identifiers rather than
content, and are sent regardless.

Hosts MUST NOT rely on servers ignoring fields they were not granted — the field is absent,
not merely discouraged.

### 10.2 beforeInference Response

```jsonc
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "featureSet": "memory.retrieval",
    "contextInjections": [
      {
        "namespace": "memory",
        "position": "system",
        "content": [
          {
            "type": "text",
            "text": "<memories>\nUser is scaling mannequin installation to 8-10 units.\n</memories>"
          }
        ],
        "metadata": { "memoryIds": ["mem_a1"] }
      }
    ]
  }
}
```

### 10.3 Content Blocks

Injections use MCP content blocks for multimodal support. The canonical shapes below adopt `mimeType` and support either inline `data` (base64) or `uri` forms where applicable.

```jsonc
"content": [
  { "type": "text", "text": "Relevant context..." },
  {
    "type": "image",
    "data": "iVBORw0KGgo...",
    "mimeType": "image/png"
  },
  {
    "type": "resource",
    "uri": "memory://facts/12345"
  }
]
```

Either `data`+`mimeType` or `uri` MAY be used for media types (hosts MAY choose which to support).

**Supported content types:**

| Type | Description |
|------|-------------|
| `text` | Plain text content |
| `image` | Image via `{ data, mimeType }` or `{ uri }`; the `uri` form MAY carry the §19.3 reference fields |
| `audio` | Audio via `{ data, mimeType }` or `{ uri }`; the `uri` form MAY carry the §19.3 reference fields |
| `resource` | URI reference to a resource; MAY carry the §19.3 reference fields (`mimeType`, `sizeBytes`, `digest`, `expiresAt`, `name`, `disposition`) |

Every `uri`-form block is server **testimony** about a payload the host does not hold.
Receipt never triggers dereference, and host policy — not the block — decides what, if
anything, reaches model context (§19). `disposition: "never"` is the one server-authored
value that binds the host, and only subtractively (§19.3.1).

For convenience, `content` MAY be a plain string (equivalent to a single text block):

```jsonc
"content": "Simple text injection"
// Equivalent to:
"content": [{ "type": "text", "text": "Simple text injection" }]
```

### 10.4 Injection Properties

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `namespace` | `string` | Yes | Server-defined namespace |
| `position` | `"system" \| "beforeUser" \| "afterUser"` | Yes | Where to inject |
| `content` | `string \| ContentBlock[]` | Yes | Content to inject |
| `metadata` | `object` | No | Arbitrary metadata |

### 10.5 inference/lifecycle (Host → Server, Notification)

`context/afterInference` is **removed in 0.5.0** and replaced by a metadata-only lifecycle
signal. Gated on `inferenceLifecycle`.

```jsonc
{
  "jsonrpc": "2.0",
  "method": "inference/lifecycle",
  "params": {
    "inferenceId": "inf_xyz",
    "conversationId": "conv_123",
    "turnIndex": 7,
    "phase": "completed",
    "model": { "…": "…" },
    "usage": { "inputTokens": 1250, "outputTokens": 340 }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `inferenceId` | `string` | Identifies this inference |
| `conversationId` | `string` | Persistent across turns |
| `turnIndex` | `integer` | 0-indexed turn number |
| `phase` | `"started" \| "completed" \| "aborted" \| "failed"` | Lifecycle position |
| `model` | `ModelInfo` | OPTIONAL; only if `modelInfo` is granted |
| `usage` | `object` | OPTIONAL; `completed` only |

**It MUST NOT carry message content** — no `userMessage`, no `assistantMessage`, no injected
context, no tool arguments or results. The content fields do not exist.

**Pairing, best-effort.** `inference/lifecycle` is an unacknowledged Notification, so its
delivery guarantee is **best-effort**, deliberately:

- A host MUST attempt exactly one terminal phase — `completed`, `aborted`, or `failed` —
  per emitted `started`, on every exit path it controls.
- A host that loses control (crash, kill, transport loss) MAY never send the terminal. There
  is no outbox, replay, acknowledgement, or event identity, and this specification does not
  add one.
- A terminal with no preceding `started`, or a second terminal for an already-terminated
  `inferenceId`, is a conformance defect and SHOULD be logged.

**Consumers MUST be defensive**: deduplicate terminals by `inferenceId`, tolerate a missing
terminal, and **retain a safety timeout** for any state machine gated on turn completion.

> **Why the replacement.** `context/afterInference` handed every subscribing server the user
> message plus the joined assistant message — including prose destined for *other* servers'
> surfaces and text the host's routing withheld. That was the broadest content-exfiltration
> surface in MCPL, and broader than the per-channel moderated view a server already gets from
> `channels/outgoing/complete`.
>
> `modifiedResponse` and the blocking form are removed with it. Response rewriting was the
> only authority in MCPL to alter model output, and no server ever produced one. Servers
> needing the *content* of a turn should take it per-channel and moderated via
> `channels/outgoing/complete`, scoped to a surface they own.
>
> `phase: "started"` additionally removes pure observers from the blocking critical path,
> and explicit `aborted`/`failed` mean an observer usually learns of a dead turn instead of
> inferring it from silence — which shortens how long a safety timeout sits armed, without
> removing the need for one.

### 10.6 Hook Timeouts

Hosts SHOULD enforce timeouts on context hooks:

- `beforeInference`: Recommended 5 seconds

`inference/lifecycle` is a Notification and has no timeout.

On timeout, hosts SHOULD proceed without the hook's contribution and MAY log the timeout.

### 10.7 Loop Prevention

Context hooks MUST NOT trigger `inference/request` calls. Servers needing inference for hook processing should do so asynchronously outside the hook response path.

Hosts MAY track hook depth and reject nested hook invocations.

### 10.8 Ordering

When multiple servers provide injections, hosts group by `position` and determine order within each position.

Each returned injection MUST be authorized independently, by its typed `position` against
the connection grant, at response-receipt (§5.4). A single response carries one claimed
`featureSet` but an array of injections at differing positions; authorizing per response
would let one permitted position carry others.

---

## 11. Server-Initiated Inference

Servers may request autonomous inference from the host. Unlike MCP's `sampling/createMessage`, this is designed for background/autonomous use without human-in-the-loop approval.

### 11.1 inference/request (Server → Host, Request)

```jsonc
{
  "jsonrpc": "2.0",
  "method": "inference/request",
  "id": 1,
  "params": {
    "featureSet": "memory.consolidation",
    "conversationId": "conv_123",
    "stream": false,
    "messages": [
      { "role": "user", "content": "Summarize these memories: ..." }
    ],
    "preferences": {
      "maxTokens": 500,
      "temperature": 0.7
    }
  }
}
```

### 11.2 Parameters

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `featureSet` | `string` | Yes | Declaring feature set |
| `conversationId` | `string` | No | Associate with conversation |
| `stream` | `boolean` | No | Stream response. Default: `false` |
| `messages` | `Message[]` | Yes | Messages for inference |
| `preferences.maxTokens` | `integer` | No | Max output tokens |
| `preferences.temperature` | `number` | No | Sampling temperature |

Hosts MAY accept additional advisory keys in `preferences` (e.g., `model`, `modelTier`, `costTier`). Such hints are host-defined and not guaranteed to be honored. Servers SHOULD NOT rely on them for correctness.

### 11.3 Response

```jsonc
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": "Consolidated memory summary...",
    "model": "claude-haiku-4-5-20251001",
    "finishReason": "end_turn",
    "usage": {
      "inputTokens": 450,
      "outputTokens": 120
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `content` | `string` | Generated content |
| `model` | `string` | Actual model used |
| `finishReason` | `"end_turn" \| "max_tokens" \| "stop_sequence"` | Why generation stopped |
| `usage` | `object` | Token usage |

### 11.4 Streaming

When `stream: true`, host sends chunks before the final response:

**inference/chunk (Host → Server, Notification):**

```jsonc
{
  "jsonrpc": "2.0",
  "method": "inference/chunk",
  "params": {
    "requestId": 1,
    "index": 0,
    "delta": "Consolidated "
  }
}
```

Chunks are followed by the full response.

### 11.5 Host Routing Guidance (Non-normative)

Hosts typically route `inference/request` by feature set and policy:

- Key: Use `(serverId, featureSet)` as the stable routing key; optionally include `conversationId` for pinning.
- Scope: Only route feature sets whose `uses` includes `inferenceRequest`.
- Patterns: Support wildcards like `memory.*` for bulk policies; default conservatively for unknown feature sets.
- Inputs: Optionally estimate tokens from `messages` to up-tier models when context is large.
- Pinning: Allow per-`conversationId` overrides to keep model consistency across a task.
- Hints: If supported, accept advisory `preferences` keys (e.g., `model`, `modelTier`); treat as non-binding.
- Audit: Include `result.model` in logs for verification and cost attribution.

Example policy (illustrative):

```jsonc
{
  "routing": {
    "default": "claude-haiku-4-5",
    "byFeature": {
      "memory.consolidation": "claude-haiku-4-5",
      "compliance.redaction": "claude-opus-4-5",
      "summarization.light": "gpt-4o-mini",
      "summarization.high": "gpt-4.1"
    },
    "wildcards": { "memory.*": "claude-haiku-4-5" },
    "overrides": { "conversation:conv_123": "claude-opus-4-5" }
  }
}
```

---

## 12. Model Information

Gated on `modelInfo`. A host that does not support or does not grant `model/info` MUST reply
with an error, not silence (§6.6).

Beyond identifying the text model, `model/info` is how a server discovers other models a
host exposes, such as image generation.

### 12.1 model/info (Server → Host, Request)

```jsonc
{
  "jsonrpc": "2.0",
  "method": "model/info",
  "id": 1,
  "params": {}
}
```

### 12.2 Response

```jsonc
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "id": "claude-opus-4-5-20251101",
    "vendor": "anthropic",
    "contextWindow": 200000,
    "capabilities": ["vision", "tools", "computer_use"]
  }
}
```

---

## 13. Security Considerations

### 13.1 Trust Model

MCPL expands server capabilities significantly. The capability grant (§5.4) provides granular control:

| Capability | Risk | Mitigation |
|------------|------|------------|
| `pushEvents` | Cost, attention | Deny the capability; gate treatment by tags (§16) |
| `contextHooks.beforeInference.observe` | Reads user input | Deny; grantable separately from injection |
| `contextHooks.beforeInference.inject.system` | **Writes the system position** | Deny. The most consequential grant in MCPL |
| `contextHooks.beforeInference.inject.beforeUser`/`.afterUser` | Writes conversational context | Deny independently of `system` |
| `inferenceLifecycle` | Turn timing metadata | Deny. Carries no content by construction (§10.5) |
| `inferenceRequest` | Consumes inference budget | Deny |
| `channels.incoming` | Injects content, wakes the agent | Deny; narrow per-channel (§14.5) |
| `channels.publish` | Speaks as the agent | Deny; narrow per-channel |

Every row is a distinct capability path, separately grantable. Observation is never bundled
with authority to alter — that separation is the point of §5.4.

### 13.2 Audit Logging

Hosts SHOULD log MCPL operations with:

- `serverId`
- `featureSet`
- `inferenceId` (when applicable)
- Timestamp
- Outcome (success/failure/timeout)

This enables debugging, cost attribution, and security review.

### 13.3 Hook Failure Policy

`beforeInference` is the only remaining blocking hook. On timeout or error hosts SHOULD
proceed without that server's contribution (fail-open) — a context enricher that is slow or
broken should not block the turn.

Blocking `afterInference` and its `modifiedResponse` are removed (§10.5), so there is no
longer a hook that can withhold or rewrite a completed response.

### 13.4 Context Injection Safety

The control is the grant, not the instruction. `contextHooks.beforeInference.inject.system`
MUST be separately grantable and SHOULD be denied by default: for an untrusted server, write
access to the system position is a larger hazard than read access to output.

Hosts authorize each returned injection by its typed `position` at response-receipt (§5.4,
§10.8), and MAY additionally validate injected content.

Servers MUST NOT inject content that attempts to override system instructions. This is a
conformance expectation for cooperative servers, and nothing more: a MUST NOT addressed to
the untrusted party is not a control.

### 13.5 Locators and References

Two kinds of URI cross the protocol, and neither carries authority:

- **Endpoint URIs** (§18). Possessing or resolving an `mcpl://` URI grants nothing; every
  question of authority is answered after connection by the grant (§18.6). Resolution is
  subject to host egress/SSRF policy, and a host follows no redirect that changes the
  canonical origin without a new authorization decision (§18.6).
- **Reference URIs in content blocks** (§19). Server-supplied metadata is testimony at a
  security boundary. Receipt MUST NOT trigger a fetch; the fetcher allowlists schemes and
  origins, bounds redirects, streams under an actual-byte ceiling, and verifies digests
  before presenting (§19.7). The connection's credential is a host-private authentication
  context applied only by a host-mediated fetcher and only to the dialed origin — never
  forwarded cross-origin, never model-visible (§19.6.1). Under `disposition: "never"` the
  raw URI never reaches model context (§19.5).

### 13.6 Tool Classes

A host executes tools it did not write and cannot classify. It knows a tool's name, its
schema, and which connection provides it. It does not know whether calling the tool sends a
message to another person, writes the agent's diary, runs a shell command, or moves the
mouse. Every policy question that turns on that distinction — what to show an observer, what
to approve, what to audit, what to cap — is answered today by tool-name pattern lists that
each operator writes by hand and that break when a server renames a tool.

This section lets the providing server say what each tool **does**, in a rough, fixed
vocabulary of **classes**:

```
comms  memory  notes  files  shell  web  computer  media  body  control
```

The class rides on the MCP tool definition, in `_meta`, as `mcpl/class`. It is a hint, in
the same trust tier as MCP's `annotations`. The host computes an **effective class** per tool
from the server's hint, its own knowledge of its built-in tools, and operator overrides, and
uses it as a key for policy. A tool with no class is treated as the most restrictive class
for every question asked of it, so classing is how a server earns looser handling, never how
it is denied.

> **Status within the draft.** Merged from RFC-008 revision 2 (Draft). This section opens
> with RFC-008 §1 (its summary) and carries RFC-008 §3–§7 as §13.6.1–§13.6.5. RFC-008 §10
> makes freezing its conformance vectors as executable vectors under `conformance/`, run
> against at least one host implementation, a precondition for Accepted status. That freeze
> has not happened yet; until it does, this section carries Draft strength within the
> 0.5.0-draft. The vectors are in RFC-008 §10.

#### 13.6.1 The class slot

Tools are MCP tool definitions (`tools/list`). MCP reserves `_meta` on `Tool` for
extensions, with prefixed keys. This section uses:

```jsonc
{
  "name": "send_message",
  "description": "Send a message to a channel or user",
  "inputSchema": { "…": "…" },
  "_meta": { "mcpl/class": ["comms"] }
}
```

- **`mcpl/class`** is an array of one or more `ToolClass` strings (§13.6.2).
- It is an array because tools straddle: a tool that sends a file to a person is `comms` and
  `files`. A host applies the **union of restrictions** across every class named, so naming
  more classes can only make handling stricter (§13.6.3).
- Unknown class strings are ignored for policy and SHOULD be logged; a tool whose only
  classes are unknown is unclassed (§13.6.3).
- The slot is at MCP level, so a plain MCP server (not MCPL) can carry it too, and an MCPL
  host reads it from either.

**The key.** MCP (2025-06-18, Basic → General fields → `_meta`) defines a key as an optional
prefix — dot-separated labels followed by a slash — and a name, and reserves for itself any
prefix whose labels include `mcp` or `modelcontextprotocol` followed by a further label
(`mcp.dev/`, `tools.mcp.com/`). `mcpl/` is a single label followed by a slash, so it is a
valid prefix and is not in MCP's reserved space; `class` is a valid name. **The `mcpl/`
prefix is reserved for keys this specification defines.** Servers and hosts MUST NOT use
`mcpl/`-prefixed `_meta` keys for anything else, and a host MUST ignore an `mcpl/` key that
this specification does not define (and SHOULD log it), rather than guess at its meaning.

Servers SHOULD class every tool they expose. A server that changes a tool's class announces
it as any tool change, via `notifications/tools/list_changed`; the host recomputes the
effective class on re-list.

#### 13.6.2 Vocabulary

| Class | The tool… |
|---|---|
| `comms` | sends to, or reads from, **other parties**: chat, DM, email, posting, calls, voice to a person. Both directions. |
| `memory` | reads or writes the **agent's own** recall: journals, diaries, memory stores, history of its own context. |
| `notes` | reads or writes **documents the agent authors**: wiki pages, task lists, drafts, knowledge bases. |
| `files` | reads or writes a **filesystem** or blob store: paths, contents, listings. |
| `shell` | **executes** commands or code: shells, interpreters, build and test runners. |
| `web` | fetches, searches, or browses the **public network**. |
| `computer` | drives a **GUI**: screen capture, pointer, keyboard, window management. |
| `media` | **generates or plays** images, audio, or video that are not messages to a person. |
| `body` | the agent's **embodiment and presence**: avatar, expression, status, TTS output not addressed to a person. |
| `control` | **host and agent settings**: spawning, lifecycle, configuration, grants, budgets. |

Edges, decided:

- Speech that reaches a person is `comms`, wherever it goes. A `say` tool that publishes to a
  chat surface is `comms`, not `body`, even when the same server also animates a mouth.
- Reading a person's messages is `comms`. The direction does not change what the data is.
- A memory tool that stores *other people's* words verbatim is `memory` and `comms`.
- A tool that runs code which may do anything (`execute_python`) is `shell`. Its
  consequences are unknowable; the class describes the tool, not the script.
- `web` is for the public network. A tool that fetches from the agent's own services or
  private documents is `files` or `notes`.

The vocabulary is deliberately coarse. A finer taxonomy would be argued about per tool and
would not be applied consistently across servers written by different people. Ten classes
that every author places a tool in within a few seconds are worth more than fifty that need
a guide. New classes are added by amendment to Appendix B.4, not by servers inventing them.

#### 13.6.3 Effective class

**Sources.**
A host computes each tool's effective class from, in precedence order:

1. **Operator override**, by host policy, keyed on the model-facing tool name (pattern
   syntax host-defined, as for §14.5 narrowing).
2. **The host's own knowledge** of tools it implements itself.
3. **The server's declaration** in `mcpl/class`.

The first source that yields a class wins entirely; sources are not merged. An override that
names a tool replaces the server's declaration, so that an operator can correct a
misclassed tool or tighten one.

**Unclassed.**
A tool with no effective class is **unclassed**. For every policy question a host asks of
class, an unclassed tool MUST be treated as the most restrictive answer any class would give.
Under RFC-007, that is: metadata may be observed under grant, arguments never. Under an
approval policy, it asks. Under a cap, it counts against the tightest cap.

This is the deny-safe reading. A server that says nothing is handled as if its tool might
be `comms`; classing is how it earns anything looser.

**Multiple classes.**
Where a tool has several classes, a host MUST apply the union of restrictions: the tool is
subject to every rule that applies to any of its classes. A host asking "may this tool's
arguments be shown?" answers no if any class says no. A host asking "does this call need
approval?" answers yes if any class says yes.

#### 13.6.4 Trust

The class is the providing server's statement about its own tools, at the same tier as MCP
`annotations`: **a hint, not a claim the host verifies.** What a lie can do:

- A server that **over-classes** (says `comms` for a shell tool) gets its tool handled more
  strictly. It harms only itself.
- A server that **under-classes** (says `shell` for a messaging tool) can cause a host to
  treat its arguments as less sensitive than they are — for example, to send them to an
  RFC-007 observer. The data so exposed is data the lying server already holds and could
  forward out of band. The class cannot affect how *another* server's tools are handled.

So misclassing widens exposure only of what the liar already has. That is why the hint is
sufficient for policy without being a security boundary. The boundary remains the grant
(§5.4); the class decides how a host exercises its own discretion under it. Operators who
distrust a server's classing override it (§13.6.3) or, as always, narrow the grant.

Hosts SHOULD show a tool's effective class and its source to operators next to the grant
(§13.2), so that a surprising class is visible before it matters.

#### 13.6.5 What class does not do

- It confers no authority and gates no method. A tool's class does not change whether the
  agent may call it, or whether the providing server may do anything.
- It is not a description for the model. Hosts MUST NOT alter a tool's model-facing
  description or schema based on class. The model sees the tool as the server wrote it.
- It is not a content type. Whether an argument is an image or a string is the schema's job.
- It is not a rating of danger. MCP's `destructiveHint` and `openWorldHint` remain the place
  for that, and hosts may use both.

---

## 14. Channels of Communication

Channels represent named destinations for messages (e.g., `ui`, `discord:#general`, `telegram:123456`, `signal:+15551234`). Channels are runtime-extensible and host-controlled. Channels are independent of moderation; hosts may run moderation on content before routing/publishing.

### 14.1 Capabilities

Servers and hosts advertise channel support under `experimental.mcpl.channels`.

```jsonc
{
  "capabilities": {
    "experimental": {
      "mcpl": {
        "version": "0.5",
        "channels": {
          "register": true,
          "publish": true,
          "incoming": true,
          "lifecycle": true,
          "streaming": true,
          "acknowledge": true,
          "typing": true
        }
      }
    }
  }
}
```

Channel methods are authorized by the connection grant (§5.4), keyed on method and channel
id — **not** by a `featureSet` field, which channel methods do not carry:

| Method | Required capability |
|---|---|
| `channels/register`, `channels/changed` | `channels.register` |
| `channels/list` (either direction) | `channels.register` |
| `channels/open`, `channels/close` | `channels.lifecycle` |
| `channels/publish` | `channels.publish` |
| `channels/incoming` | `channels.incoming` |
| `channels/outgoing/chunk`, `channels/outgoing/complete` | `channels.streaming` |
| `channels/acknowledge` | `channels.acknowledge` |
| `channels/typing` | `channels.typing` |

`channels.incoming` is deliberately distinct from any "observe" grant: `channels/incoming`
is server→host content injection plus wake authority — a write, and one of the most
consequential a server has.

Feature sets MAY still name these capabilities in `uses` for ergonomics and honest
degradation reporting (§6.4), but they are not the authorization.

### 14.2 Channel Descriptors

```jsonc
// ChannelDescriptor
{
  "id": "discord:#general",          // unique within this connection
  "type": "discord",                  // platform/provider
  "label": "#general (Acme Discord)", // human label
  "direction": "outbound",            // "outbound" | "inbound" | "bidirectional"
  "address": { "guild": "acme", "channel": "#general" },
  "metadata": { "serverId": "discord-connector" }
}
```

### 14.3 Methods

- `channels/register` (Server → Host, Request): Register channels handled by the server.

```jsonc
{
  "jsonrpc": "2.0",
  "method": "channels/register",
  "id": 1,
  "params": { "channels": [ /* ChannelDescriptor[] */ ] }
}
```

- `channels/changed` (Server → Host, Notification or Request; §14.5): Notify added/removed/updated channels.

```jsonc
{
  "jsonrpc": "2.0",
  "method": "channels/changed",
  "params": {
    "added": [ /* ChannelDescriptor[] */ ],
    "removed": ["discord:#random"],
    "updated": [ /* ChannelDescriptor[] */ ]
  }
}
```

- `channels/list` (Request, either direction): List known channels for this connection.
  A host that does not implement the inbound form MUST reply with an error, not silence
  (§6.6).

```jsonc
{
  "jsonrpc": "2.0",
  "method": "channels/list",
  "id": 2,
  "params": {}
}
```

- `channels/open` (Host → Server, Request): Request server to open/connect a channel.

```jsonc
{
  "jsonrpc": "2.0",
  "method": "channels/open",
  "id": 3,
  "params": {
    "type": "discord",
    "address": { "guild": "acme", "channel": "#general" },
    "metadata": {}
  }
}
```

Response:

```jsonc
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "channel": {
      "id": "discord:#general",
      "type": "discord",
      "label": "#general (Acme Discord)",
      "direction": "bidirectional",
      "address": { "guild": "acme", "channel": "#general" }
    }
  }
}
```

- `channels/close` (Host → Server, Request): Request server to close/disconnect a channel.

```jsonc
{
  "jsonrpc": "2.0",
  "method": "channels/close",
  "id": 4,
  "params": {
    "channelId": "discord:#general"
  }
}
```

Response:

```jsonc
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": { "closed": true }
}
```

- `channels/outgoing/chunk` (Host → Server, Notification): Moderated outgoing
  text deltas, streamed while the model is still generating. Semantics:

  - **Opt-in**: sent only to servers granted `channels.streaming` (§14.1,
    §5.4). Servers not granted it MUST NOT receive these notifications.
  - **Recipient**: the server that registered the target channel (the one
    whose `channels/publish` will eventually deliver the same content). This
    enables live consumers — streamed message rendering, voice synthesis —
    on the owning surface.
  - **Moderated, fail-closed**: a chunk stream MUST NOT contain text the
    host's delivery path would refuse to deliver (e.g. text with no resolved
    destination, private/skip segments). When routing is undecided, the host
    withholds; it never streams speculatively.
  - **Ordering**: `index` is monotonically increasing per `inferenceId`
    (a single counter across all channels of that inference). Per-channel
    deltas concatenated in `index` order reconstruct that channel's streamed
    text.
  - **Advisory only**: chunks are an observer surface. The authoritative
    delivery remains `channels/publish`; servers MUST NOT treat a chunk
    stream as delivered content.

```jsonc
{
  "jsonrpc": "2.0",
  "method": "channels/outgoing/chunk",
  "params": {
    "inferenceId": "inf_abc",
    "conversationId": "conv_123",
    "channelId": "discord:#general",
    "index": 0,
    "delta": "Hello team,"
  }
}
```

- `channels/outgoing/complete` (Host → Server, Notification): Closes an
  outgoing stream. Sent once per (inferenceId, channelId) that received
  chunks, on every inference exit path (complete, abort, error), carrying the
  full moderated text for that channel. Consumers use it to finalize (settle
  a rendered message, end a synthesized utterance) and to reconcile any
  dropped chunks. Same opt-in and advisory semantics as
  `channels/outgoing/chunk`.

```jsonc
{
  "jsonrpc": "2.0",
  "method": "channels/outgoing/complete",
  "params": {
    "inferenceId": "inf_abc",
    "conversationId": "conv_123",
    "channelId": "discord:#general",
    "content": [ { "type": "text", "text": "…" } ]
  }
}
```

- `channels/publish` (Host → Server, Notification or Request): Ask the server to deliver content to a channel.

```jsonc
{
  "jsonrpc": "2.0",
  "method": "channels/publish",
  "params": {
    "conversationId": "conv_123",
    "channelId": "discord:#general",
    "stream": false,
    "content": [ { "type": "text", "text": "Hello team" } ]
  }
}
```

If an ACK is desired, send as a Request and return `{ delivered: true, messageId: "..." }`.

- `channels/incoming` (Server → Host, Request): Deliver inbound messages from a channel. Supports batching for busy channels. The host decides how to map messages to conversations and user turns and whether to trigger inference.

```jsonc
{
  "jsonrpc": "2.0",
  "method": "channels/incoming",
  "id": 5,
  "params": {
    "messages": [
      {
        "channelId": "discord:#general",
        "messageId": "dmsg_123",
        "threadId": "t_42",
        "author": { "id": "u_777", "name": "Alice" },
        "timestamp": "2026-03-05T10:30:00Z",
        "content": [ { "type": "text", "text": "What's the status?" } ],
        "metadata": { "mentions": ["@bob"] }
      },
      {
        "channelId": "discord:#general",
        "messageId": "dmsg_124",
        "threadId": "t_42",
        "author": { "id": "u_888", "name": "Bob" },
        "timestamp": "2026-03-05T10:30:05Z",
        "content": [ { "type": "text", "text": "I was wondering the same" } ],
        "metadata": {}
      }
    ]
  }
}
```

Response (per-message results for partial acceptance):

```jsonc
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "results": [
      { "messageId": "dmsg_123", "accepted": true, "conversationId": "conv_123" },
      { "messageId": "dmsg_124", "accepted": true, "conversationId": "conv_123" }
    ]
  }
}
```

A message can also carry `eventId` and `coalesce`, and its per-message result a `coalesce`
member; §20 also adds the refusal reason `coalesce_invalid` (§20.3.1, §20.7, §20.13).

### 14.4 beforeInference Channel Context

Hosts MAY include channel context in `context/beforeInference` params so servers can adapt:

```jsonc
"channels": {
  "incoming": { "channelId": "discord:#general", "messageId": "dmsg_123", "threadId": "t_42" },
  "defaultOutgoing": { "channelId": "discord:#general" },
  "candidates": ["ui", "discord:#general", "telegram:123456"]
}
```

Servers MAY supply channel-related `contextInjections` (e.g., thread context). The host controls ordering and whether to include this field.

### 14.5 Security and Scoping

**Per-descriptor authorization.** `channels/register` and `channels/changed` carry *arrays*
of descriptors, not a single trusted `channelId`. The host MUST authorize **each descriptor
independently**. A server MUST NOT be able to widen its registration by bundling one
permitted descriptor with nine forbidden ones — whole-request authorization on an array is
one attacker-chosen token standing in for many independent decisions.

`channels/changed` is therefore **dual-mode**. As a Notification it cannot carry a result, so
neither whole-rejection nor itemized reporting is expressible. A host whose policy can reject
descriptors MUST require the Request form; a server MUST use it when signalled. The Request
form returns an itemized result, one entry per submitted descriptor:

```jsonc
{ "results": [
    { "id": "discord:#general", "accepted": true },
    { "id": "discord:#admin",   "accepted": false, "reason": "capability_denied" }
] }
```

The same shape applies to `channels/register`. A host receiving a Notification it has to
partially reject MUST filter itemwise **and** emit a diagnostic — never silently, since
silent filtering leaves the two sides disagreeing about which channels exist.

**Receipt-time validation.** `channels/incoming` MUST be validated at receipt against the
**current** grant and the **actually registered** channel — not against the channel id the
message claims, and not against the grant as it stood at registration. A channel registered
under a grant that has since narrowed does not keep its old authority.

**Per-channel narrowing** (patterns like `discord:acme/*`) attaches to the grant entry.

**Delivery is never a side effect of a lifecycle event.** A server MUST NOT deliver content
to its surface in response to a host lifecycle notification or hook. Delivery occurs only via
`channels/publish`. Hosts SHOULD treat a server-side send triggered by `inference/lifecycle`,
`channels/outgoing/chunk`, or `channels/outgoing/complete` as a conformance defect.

Hosts SHOULD moderate content before routing/publishing.

### 14.6 Error Codes

Channel methods use these codes, defined in Appendix A: `-32002` (Capability denied),
`-32017` (Channel not permitted), `-32023` (Unknown channel) and `-32024` (Channel open
failed).

---

## 15. Examples

### 15.1 Memory Server

**Capabilities:**

```jsonc
{
  "capabilities": {
    "experimental": {
      "mcpl": {
        "version": "0.5",
        "contextHooks": { "beforeInference": true },
        "inferenceLifecycle": true,
        "inferenceRequest": { "streaming": true },
        "pushEvents": true,
        "featureSets": {
          "memory.retrieval": {
            "description": "Retrieve relevant memories",
            "uses": ["contextHooks.beforeInference.observe",
                     "contextHooks.beforeInference.inject.system"]
          },
          "memory.extraction": {
            "description": "Learn from conversations",
            "uses": ["inferenceLifecycle"]
          },
          "memory.consolidation": {
            "description": "Summarize memories using AI",
            "uses": ["inferenceRequest"]
          },
          "memory.proactive": {
            "description": "Surface reminders proactively",
            "uses": ["pushEvents"]
          }
        }
      }
    }
  }
}
```

**Memory retrieval flow:**

```jsonc
// Host → Server
{
  "jsonrpc": "2.0",
  "method": "context/beforeInference",
  "id": 5,
  "params": {
    "inferenceId": "inf_xyz",
    "conversationId": "conv_123",
    "turnIndex": 7,
    "userMessage": "How's the mannequin project?",
    "model": { "id": "claude-opus-4-5-20251101", "vendor": "anthropic", "contextWindow": 200000, "capabilities": ["vision"] }
  }
}

// Server → Host
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "featureSet": "memory.retrieval",
    "contextInjections": [{
      "namespace": "memory",
      "position": "system",
      "content": [
        { "type": "text", "text": "<memories>\nScaling mannequin installation to 8-10 units. DMX lighting, X32 audio routing.\n</memories>" }
      ],
      "metadata": { "memoryIds": ["mem_a1", "mem_a2"] }
    }]
  }
}
```

**Proactive reminder:**

```jsonc
{
  "jsonrpc": "2.0",
  "method": "push/event",
  "id": 10,
  "params": {
    "featureSet": "memory.proactive",
    "eventId": "evt_reminder_001",
    "timestamp": "2026-01-23T14:00:00Z",
    "origin": {
      "server": "memory",
      "memoryId": "mem_followup"
    },
    "payload": {
      "content": [
        { "type": "text", "text": "You mentioned following up with Alice today" }
      ]
    }
  }
}
```

### 15.2 Embodiment Server (write-without-read)

A server bridging a physical body. It needs to know when a turn starts and ends, and to
prepend one line of body status — but it never needs to read what the user said. Under the
split capability vocabulary it can be granted exactly that.

**Capabilities:**

```jsonc
{
  "capabilities": {
    "experimental": {
      "mcpl": {
        "version": "0.5",
        "contextHooks": { "beforeInference": true },
        "inferenceLifecycle": true,
        "pushEvents": true,
        "featureSets": {
          "body.presence": {
            "description": "Report body state and track attention",
            "uses": ["pushEvents",
                     "inferenceLifecycle",
                     "contextHooks.beforeInference.inject.beforeUser"]
          }
        }
      }
    }
  }
}
```

Note the absence of `contextHooks.beforeInference.observe`. The host will call the hook and
accept the injection, but `userMessage` is not this server's to read.

**Turn start — host signals, server marks busy:**

```jsonc
{
  "jsonrpc": "2.0",
  "method": "inference/lifecycle",
  "params": { "inferenceId": "inf_abc", "conversationId": "conv_456",
              "turnIndex": 3, "phase": "started" }
}
```

**Injection — one line, no read:**

```jsonc
{
  "jsonrpc": "2.0",
  "id": 15,
  "result": {
    "featureSet": "body.presence",
    "contextInjections": [
      { "namespace": "body", "position": "beforeUser",
        "content": "[body] online, battery 62%, attention mode: ambient" }
    ]
  }
}
```

The host authorizes this injection by its `position` — `beforeUser` — against the grant, at
response-receipt (§5.4). Had the same server returned a `system` injection it would be
rejected, without the server's claimed `featureSet` entering the decision.

**Turn end — one terminal phase, best-effort, on every exit path the host controls:**

```jsonc
{
  "jsonrpc": "2.0",
  "method": "inference/lifecycle",
  "params": { "inferenceId": "inf_abc", "phase": "aborted" }
}
```

§10.5's terminal phases are best-effort, so the server still keeps a safety timeout — but it
now learns of an aborted turn directly in the common case, rather than waiting the timeout
out on every failure.

---

## 16. Event Tags

A multi-valued **`tags`** dimension lets a producer label what an event *is*, so a consumer
can decide *how to treat it* — including whether it wakes the model. Tags are namespaced,
discrete (never an ordered scale), and their meaning is assigned by the consumer.

### 16.1 The field

`tags: string[]` is OPTIONAL on `push/event` params (§9.2) and on `channels/incoming`
messages (§14.3).

- A tag is `namespace:value`, optionally `namespace:key=value` for faceted tags.
- The `chat:` (§16.2) and `mcpl:` namespaces are reserved. All others are producer-defined
  and SHOULD match the producer's declared name. At Draft strength, §21.7 also reserves
  `surface:`.
- Tags are a **set** — unordered, deduplicated.
- Producers **MUST NOT** emit un-namespaced tags. A bare `"mention"` is not a tag.

### 16.2 Reserved core vocabulary: `chat:*`

| Facet | Tag | Meaning |
|---|---|---|
| Addressing | `chat:addressed` | Umbrella: directed at the agent |
| | `chat:mention` | Explicitly named/@-mentioned |
| | `chat:reply` | A reply to the agent's own message |
| | `chat:dm` | A direct/private 1:1 message |
| | `chat:ambient` | Overheard; not addressed |
| | `chat:broadcast` | Channel-wide ping |
| | `chat:to-self` | Acts on the agent's own content |
| Sender | `chat:from-human` / `chat:from-bot` / `chat:from-self` / `chat:from-agent` | Authorship |
| Lifecycle | `chat:edited` / `chat:deleted` / `chat:reaction` / `chat:reaction-remove` | Plain creation is the implicit default and carries no tag |
| Kind | `chat:system` | A notice from the platform or the place, not a message anyone sent. Plain messages carry no kind tag |
| Content | `chat:has-image` / `chat:has-audio` / `chat:has-file` / `chat:has-link` / `chat:command` | Modality |
| Locus | `chat:private` / `chat:group` / `chat:thread` | Conversation shape |

`chat:reaction-remove` is distinct from `chat:reaction`: emitting the latter for a removal
makes "wake on reactions to my messages" fire on un-reactions.

**System notices.** `chat:system` marks an event about the place a conversation happens in,
not a turn in the conversation: someone joined or left, a message was pinned, the channel was
renamed, the weather changed in a world. `chat:ambient` says nobody spoke *to* the agent;
`chat:system` says nobody *spoke*. Producers SHOULD emit it on such notices, and MAY emit it
alongside `chat:ambient`, so that rules written for ambient traffic keep matching them.
Producers SHOULD NOT put it on anything someone said.

Kind is independent of addressing: a notice can also be addressed by its place (a pin in a
DM carries `chat:dm`, hence `chat:addressed`), and is still a notice. Sender tags on a
notice, if present, name who it is about (who joined), not a speaker. What a consumer does
with a notice is its own call, as for every tag.

### 16.3 Normative core closure

These implications are defined by this specification. Hosts MUST expand them, and MUST do so
**without consulting any producer ontology**:

```
chat:mention  ⇒ chat:addressed
chat:reply    ⇒ chat:addressed
chat:dm       ⇒ chat:addressed, chat:private
```

Expansion is transitive and purely additive. Producers SHOULD **also** emit every applicable
core tag directly; both are conforming, and direct emission is more robust.

**Mutual exclusion.** `chat:addressed` and `chat:ambient` are opposites. Because closure is
additive it can produce both. After expansion a host MUST resolve this by **dropping
`chat:ambient`**: an event carrying both is not interpretable by a first-match-wins rule
list, where the outcome would depend on rule ordering rather than on the event. Producers
SHOULD NOT emit `chat:ambient` alongside anything implying `chat:addressed`.

The exclusion does not touch `chat:system`, which answers a different question (kind, not
addressing).

**Producer-declared `implies` edges are advisory** and MUST NOT be applied automatically —
in particular an edge targeting a reserved `chat:*` tag MUST NOT be applied unless the host
or operator has explicitly accepted that producer's ontology (§16.5). An arbitrary declared
edge lets a producer promote its own traffic into whatever band the consumer reserved for
being spoken to, without the consumer ever writing a rule about it.

### 16.4 Producer ontology

Producers SHOULD advertise the tags they emit as an open-world ontology on their feature-set
declaration — a hint catalog, not a closed schema. Hosts MUST tolerate undescribed tags.

Fields (all optional): `coreTags` (which reserved tags this server emits, descriptions
inherited from §16.2); per-tag `desc`, `facet`, `implies`, `suggestedTreatment`, `stability`;
`keyed` families; a top-level `suggestedTreatment` rule list; and `open`.

The ontology is part of the manifest, so the host learns it at `initialize` and again
whenever it fetches the manifest (§17.4). There is no ontology-specific query method, and a
changed ontology invalidates prior acceptance rather than inheriting it (§17.5).

### 16.5 Suggested treatment is a hint, not policy

A producer's `suggestedTreatment` **MUST NOT** be applied automatically. It is inspectable
configuration, surfaced to a host or operator and applied only on **explicit acceptance**.
Absent acceptance the precedence chain is **consumer rules → host default**; there is no
producer tier.

> Otherwise an untrusted server suggests `immediate` for everything and **purchases
> inference by declaration**, without the consumer ever writing a rule. Wake-ups cost money,
> attention, and context.

Accepted suggestions SHOULD remain attributable and revocable.

### 16.6 Tags are never authority

Admission is decided **before** tags are read: whether a `push/event` or `channels/incoming`
message enters the host at all is decided by the capability grant (§5.4) and channel
authorization (§14.5). Tags influence *treatment* only after admission.

- A tag or ontology MUST NOT widen a capability grant.
- A tag MUST NOT authorize a channel or cause a message on an unauthorized channel to be
  admitted.
- A tag MUST NOT bypass source-aware gate policy.
- Tags are **untrusted claims** authored by the producer, exactly like `origin` and
  `metadata`. A host MAY disbelieve them.

### 16.7 Consumer treatment (recommended)

Hosts SHOULD evaluate treatment as an ordered, first-match-wins rule list with `tagsAny` /
`tagsAll` / `tagsNone` matchers (globs allowed), composable with `source` / `channel`, over
the closure-expanded tag set.

---

## 17. Server Manifest Changes

A server's manifest became **consequential** in 0.5.0: capabilities determine the grant
(§5.4), `uses` determines degradation (§6.4), and ontology acceptance is bound to a snapshot
(§17.5). A stale manifest is therefore no longer cosmetic, and discovery at `initialize`
alone is insufficient.

This section adds two optional methods:

- **`mcpl/manifestChanged`** (Server → Host, Notification) — an opaque revision plus the set
  of changed domains. A hint, nothing more.
- **`mcpl/manifest`** (Host → Server, Request) — fetch the canonical current manifest.

The host validates and **diffs** the fetched manifest, applies §6.7's existing consequences,
and emits one normalized change receipt using a closed, host-derived vocabulary. This
section adds a **trigger** for existing machinery; it adds no new policy.

### 17.1 The manifest and its revision

The **manifest** is the complete `experimental.mcpl` object a server presents at
`initialize` (§5.1), exactly as initialized — capability members at the top level, with
`featureSets` as one member among them. There is no nested `capabilities` wrapper.

A server that supports this section includes a `revision: string` member in that object.

Three change **domains** partition it, and §21.5.1 adds a fourth, `toolsets`, at Draft strength:

| Domain | Members |
|---|---|
| `capabilities` | every member other than `version`, `revision`, and `featureSets` (and, under §21.5.1 at Draft strength, `toolHints`, `toolsets` and `surface`) |
| `featureSets` | the `featureSets` member, excluding any `tagOntology` within it |
| `tagOntology` | the `tagOntology` of any feature set |
| `toolsets` | the `toolHints`, `toolsets` and `surface` members (§21.5.1, Draft strength) |

`version` and `revision` are not a domain: `version` is protocol identity, not surface, and
`revision` is derived (§17.2).

- The revision **MUST** be the canonical content digest of §17.2. It **MUST NOT** be
  hand-maintained or tied to a package version, and **MUST** be stable across process
  restarts.
- The revision is nonetheless **server-authored and untrusted**. A host **MUST NOT** treat an
  unchanged revision as proof that nothing changed.
- Hosts **MUST NOT** parse or order revisions. Equality is the only defined operation.
- The host's **diff of the fetched manifest is authoritative** for every decision. The
  revision exists to make the common case cheap, not to be believed.

> **Why content-derived is normative rather than advice.** A hand-maintained revision fails
> the way every hand-maintained invariant fails — silently, and precisely when someone is
> busy shipping something else. A content digest moves on its own, so a cooperative server
> **cannot accidentally** change without announcing. That does not make this a security
> mechanism (§17.9); it moves silent change from *likely-by-accident* to *only-by-intent*.
> Stating it as an invariant rather than as a library API also makes it portable: any
> implementation in any language can satisfy it, and a host can check it by fetching twice.

**Package version is not surface identity.** A protocol- or package-version field is useful
for validation and migration, and **MUST NOT** substitute for comparing the manifest.

### 17.2 Canonical digest

The digest **MUST** be computed as:

```
revision = "sha256:" + base64url_unpadded( SHA-256( JCS( manifest_without_revision ) ) )
```

- **`JCS`** is JSON Canonicalization Scheme (RFC 8785).
- **`manifest_without_revision`** is the complete `experimental.mcpl` object with the
  `revision` member removed, so the digest never covers itself. Nothing else is stripped —
  `version` is included.
- **`base64url_unpadded`** is RFC 4648 §5 without `=` padding.

**Array semantics.** Canonicalization fixes object member order but not array order, so each
array is declared set-like or list-like:

| Field | Semantics |
|---|---|
| `uses` | **Set** — sorted (see below), duplicates removed |
| `coreTags`, `tagOntology.tags.*.implies` | **Set** — same treatment |
| `keyed.*.values` | **List** — order is meaningful and preserved |

Any array not listed is a list; its order is part of the manifest and **MUST** be
deterministic across restarts. That default covers `suggestedTreatment`'s
`tagsAny`/`tagsAll`/`tagsNone` matchers: semantically unordered, but **lists here** — this
is deliberate, restated so it cannot be reopened by inference. (The cost is known: two
servers with identical matching behaviour but reordered matchers produce different
revisions. The alternative — set semantics by semantic judgment rather than by enumeration —
is how two implementations drift.)

**The digest is total.** Set semantics apply **only when the value actually is an
all-string array** at one of the three named locations, in the object-keyed `featureSets`
shape those paths are written against. A set-declared array containing any non-string
member is non-conforming input: hashed verbatim — no sort, no dedupe, no identifier
check — since the identifier refusal exists solely to keep the sort-order divergence
unreachable, and an array that is never sorted cannot diverge. A wrong-typed value in a set position (`"uses": "tools"`), an
array-shaped `featureSets`, or any other non-conforming structure is **hashed verbatim** —
canonicalized by JCS, never set-normalized, never refused. Validation (§6.4) is where a
wrong type fails; the digest's job is to give any two libraries the same answer for the
same bytes, including bytes that will then fail validation.

The **only** input the digest refuses is an identifier-charset violation
(`identifier_charset`): hashing a non-ASCII identifier makes the UTF-8/UTF-16 ordering
divergence reachable inside a set-valued array, which is the failure the ASCII rule exists
to prevent. Identifier positions are: capability member names at every depth, feature-set
names, `uses` entries, `coreTags`, `tags` keys, `implies` entries, `keyed` keys and their
`values` entries, and `suggestedTreatment` rule matchers. Free-text fields (`description`,
`desc`) are not identifiers.

Two structural pins, both consequences of "nothing else is stripped": the root `revision`
member is stripped and **only** the root one — a nested member named `revision` is ordinary
content; and §5.1's boolean-`true` shorthand is **not expanded** before hashing — shorthand
and expanded forms are different manifests with different digests, since expansion would
bind the digest to the leaf vocabulary of the day.

**Set ordering.** Sort by **UTF-8 byte sequence**, ascending. Not "code point order" and not
a language's default string comparison: JavaScript compares UTF-16 code units and Rust
compares UTF-8 bytes, and the two disagree above U+FFFF, so an unqualified "sort" is not
interoperable.

Additionally, **capability paths and tag identifiers MUST be ASCII** — `[A-Za-z0-9._:*-]`.
For ASCII strings UTF-8 byte order, UTF-16 code-unit order, and code-point order coincide,
so the ordering question cannot arise for the values this actually applies to. The UTF-8
rule governs anything else.

#### Test vector

Implementations **MUST** reproduce this exactly. It is the interoperability check: two
implementations that agree here agree on canonicalization, set ordering, hashing, and
encoding.

Manifest (`revision` absent):

```json
{"version":"0.5","pushEvents":true,"contextHooks":{"beforeInference":true},
 "inferenceLifecycle":true,"channels":{"register":true,"publish":true,"incoming":true},
 "featureSets":{"demo.messaging":{"description":"Demo",
   "uses":["channels.publish","channels.incoming","pushEvents","tools"]}}}
```

Canonical bytes after set-sorting `uses` and applying JCS:

```
{"channels":{"incoming":true,"publish":true,"register":true},"contextHooks":{"beforeInference":true},"featureSets":{"demo.messaging":{"description":"Demo","uses":["channels.incoming","channels.publish","pushEvents","tools"]}},"inferenceLifecycle":true,"pushEvents":true,"version":"0.5"}
```

Expected:

```
revision = sha256:_YZTS0h1tqTAMZI6eElCszSQE2WNx3xhAhmgUvNI9H4
```

Note `uses` is reordered (set semantics) while object members are reordered by JCS — both
are needed, and neither alone yields this value.

A host **MAY** recompute the digest from a fetched manifest and compare. A mismatch is a
**conformance defect**, not grounds to reject the manifest — the manifest's *content* is
what the host acts on, and the digest is only the cheap path (§17.1).

### 17.3 `mcpl/manifestChanged` (Server → Host, Notification)

```jsonc
{
  "jsonrpc": "2.0",
  "method": "mcpl/manifestChanged",
  "params": {
    "revision": "sha256:QLXa7BigUFzNlw_IWPSqpYbDzdvBX7PVQIPS5lgnkaw",
    "domains": ["capabilities", "featureSets"]
  }
}
```

`domains` is a subset of `capabilities | featureSets | tagOntology`, extended to `toolsets` at
Draft strength (§21.5.1). It carries **no payload** — no diff, no list of what was added or removed, no policy conclusion. Everything
a server might assert about the change is something the host would have to re-derive anyway,
and asserting it invites the self-attestation defect this specification removes in §5.4 and
§7.

A host **MAY** ignore the notification entirely. A host that acts on it **MUST** fetch
(§17.4) before changing anything.

**Deriving `domains`:** an **absent** member and an **empty** one are different manifests —
they canonicalize differently — so a member appearing or disappearing IS a change to its
domain. Going from `{"version":"0.5"}` to `{"version":"0.5","featureSets":{}}` announces
`featureSets` (and `tagOntology`, whose carrier appeared).

**No capability path gates this.** That is deliberate and is an exception worth stating:
announcing conveys no authority, and gating it would perversely silence exactly the servers
whose grants had just been narrowed. The cost of the announcement is the host's re-fetch,
which §17.8 bounds.

### 17.4 `mcpl/manifest` (Host → Server, Request)

```jsonc
{ "jsonrpc": "2.0", "id": 21, "method": "mcpl/manifest", "params": {} }
```

Returns the server's **current, complete** manifest in the same shape it would present at
`initialize`:

```jsonc
{
  "jsonrpc": "2.0", "id": 21,
  "result": {
    "revision": "sha256:QLXa7BigUFzNlw_IWPSqpYbDzdvBX7PVQIPS5lgnkaw",
    "version": "0.5",
    "pushEvents": true,
    "contextHooks": { "beforeInference": true },
    "channels": { "register": true, "publish": true, "incoming": true },
    "featureSets": { "…": "…" }
  }
}
```

The result is the `experimental.mcpl` object itself — the same shape `initialize` carries,
not a re-wrapped one.

- Complete, never a delta. Deltas would require the host to trust the server's account of
  its own previous state.
- A server that does not implement it **MUST** return an error, not silence (§6.6).
- Hosts **MAY** call it at any time, not only after a notification — for example on a
  schedule, or before a security-sensitive operation.

### 17.5 Host processing

On a fetched manifest the host **MUST**:

1. **Validate** it exactly as at `initialize`, including `uses` (§6.4). Invalid declarations
   fail closed with `invalid_uses`.

   **A partially invalid manifest MUST NOT leave broader authority standing.** If the
   manifest parses but some declarations are invalid, the host **MUST** still apply every
   **removal** it can determine — a capability or feature set absent from the new manifest
   is revoked, regardless of whether some other declaration failed validation. Invalid
   *additions* are simply ignored; they could not have been granted without negotiation
   anyway (§6.7).

   This follows from §6.7's existing asymmetry rather than adding policy: removals are safe
   to apply eagerly, additions are not. Applying removals eagerly costs a cooperative server
   nothing, and closes the case where a server narrows one capability while malforming
   another and the host keeps sending under the old, broader grant.

   If the manifest **does not parse at all**, the host has learned nothing — no narrowing can
   be inferred — so the previous manifest stands. Repeated unparseable responses are a
   conformance defect; a host **MAY** then suspend MCPL privileges and fall back to MCP-only
   (§3.2), but **MUST NOT** do so on a single failure.
2. **Diff** it against the manifest currently in force.
3. **Apply §6.7 consequences**, unchanged:
   - **Removals and narrowing** revoke **host-first**, then the Request and receipt.
   - **Additions never auto-grant.** A newly advertised capability is an input to the host's
     grant computation, nothing more. If policy widens the grant, that follows
     tell → receipt → activate.
   - **Changed or now-invalid `uses`** revalidates fail-closed.
   - **A changed `tagOntology` invalidates prior acceptance** (§16.5) rather than inheriting
     standing. Accepted suggestions and `implies` edges do not carry over a revision they
     were not accepted against.
4. **Emit one receipt** (§17.6). One per manifest change, not one per affected item.

In-flight requests need no new rule: §5.4 already authorizes response contributions against
the grant **current at response-receipt**, so a hook dispatched before a narrowing returns
into the narrowed grant.

### 17.6 The change receipt

The host emits a single normalized, privacy-minimal receipt to the agent or operator.
Impacts use a **closed, host-derived vocabulary** — never a server-authored flag such as
`requiresReview`:

| Impact | Meaning |
|---|---|
| `capability-revoked` | A capability in force is no longer granted |
| `capability-expansion-pending` | Newly advertised; awaiting a policy decision |
| `feature-degraded` | A feature set was disabled by derivation |
| `feature-restored` | A previously degraded feature set is available again |
| `ontology-acceptance-invalidated` | Accepted tag ontology no longer applies (§16.5) |
| `ontology-reference-undeclared` | A consumer gate rule references a tag the server no longer declares |
| `surface-changed` | Tools, resources, prompts or channels changed (§17.7) |

Each impact carries a disposition: `applied` | `decision-needed` | `informational`.

Whether a receipt **wakes** the agent is ordinary §16 policy evaluated against tags the
host attaches — not a property of the change and not the server's to decide.

`ontology-reference-undeclared` is **informational by default**, and the name is deliberate.
Tag ontologies are open-world, so a tag absent from the new declaration may still be emitted
when `open: true`, and a consumer rule matches raw event tags regardless of what is declared.
The certain fact is narrower — the accepted *description* disappeared, not that the rule
stopped matching. The agent may well want to know, because it often *precedes* a rule going
dead, but the host cannot assert that it has.

### 17.7 Relationship to existing change notifications

MCP's `notifications/tools/list_changed` (and the resources/prompts equivalents) and MCPL's
`channels/changed` (§14.5) **remain unchanged**. They are specialized, they carry no manifest
authority, and they already work.

The host **SHOULD** coalesce them into the same agent-facing changelog surface, so the
agent sees one account of "what changed about this server" rather than four unrelated
ones.

### 17.8 Rate limiting

`mcpl/manifestChanged` is cheap to send and causes a fetch. Unbounded, that is an
amplification vector.

**The limiter is the host's.** A server **SHOULD** coalesce rapid changes into one
notification, but a host **MUST NOT** depend on it. Hosts **MUST** bound the fetch rate per
connection, and **MAY** coalesce multiple notifications into a single fetch. Exceeding the
host's limit is a **conformance defect**, not a negotiation: the host drops the excess and
**SHOULD** surface the defect, rather than fetching or renegotiating anything.

### 17.9 What this is not

**This is cooperative-only. It is not a security mechanism.**

A server that changes silently and never announces is undetectable between fetches. §17 buys
*freshness* from well-behaved servers. What protects against the others is the grant (§5.4),
which is enforced continuously and does not depend on any announcement. Stated plainly so
that a stale revision is never later mistaken for a safety property — the same posture as
feature sets: ergonomics, not a boundary.

Hosts that want assurance rather than freshness should re-fetch on their own schedule
(§17.4), which needs no cooperation at all.

**Out of scope.** Mid-run capability *elevation* — a server asking for a capability it lacks
— is a different mechanism with a coercion profile of its own; `manifestChanged` announces
what a server *is*, not what it *wants*. Signed or attested manifests would move this from
freshness to assurance and need an identity story MCPL does not have.

### 17.10 Backward compatibility

- Both methods are optional. A server that implements neither behaves exactly as before: its
  manifest is fixed at `initialize`.
- A server **MAY** implement `mcpl/manifest` without `mcpl/manifestChanged`, which lets a
  host poll. The reverse is useless and hosts **SHOULD** warn on it.
- `revision` is an added field; hosts that ignore it lose only the cheap-path optimization.
- No change to the grant, the receipt, or any §6.7 ordering rule.

**Implementation note (non-normative).** Conformance requires only §17.1–§17.6, but the two
sides track **different facts**, and implementations that conflate them tend to reintroduce
self-attestation. A *server* library should canonicalize the complete manifest, compute the
digest, diff old against new to derive changed domains, install atomically, coalesce rapid
edits (a batch API, so six related edits produce one announcement rather than six
intermediate manifests), emit `mcpl/manifestChanged` per connection where the last-announced
revision differs, and answer `mcpl/manifest` from the same canonical snapshot — servers
should call something like `setManifest(next)` and never hand-author an announcement. Seed
each connection's last-announced revision from the `initialize` handshake, or a fresh
connection starts empty and fires a redundant announcement immediately after initialize,
which already carried the manifest. A *host* should retain, per connection: last fetched and
validated manifest digest; last negotiated effective grant with timestamp and provenance;
accepted ontology digest; current feature degradation; last receipt delivered. The server
tracks what it announced; the host tracks what it fetched, validated, negotiated, and
delivered. A server's announcement log is not evidence the host acted on it. The server
library **MUST NOT** generate agent-facing prose or policy conclusions — the impact
vocabulary of §17.6 is host-derived precisely so that what the agent is told about a change
is not authored by the party that made it.

---

## 18. Endpoint URIs

MCPL servers are reached by a transport URL holding `ws://` or `wss://`, plus a transport
selector. That says *how to dial*, not *what is there*. This section defines an
**endpoint URI and nothing else** — not discovery, not identity, not trust, not mobility
(§18.8). A `mcpl://` URI names a protocol rather than a socket; it is pasteable; and it lets
introspection separate *what was configured* from *what was dialled* (§18.4).

```text
mcpl://example.com/path?hint=value
        ↓ deterministic resolution
wss://example.com/path?hint=value
```

It confers no authority and changes no grant; §5.4 remains the sole source of what a
connected server may do (§18.6).

### 18.1 Scheme

```
mcpl-URI = "mcpl://" authority path-abempty [ "?" query ]
```

- **`mcpl://` is secure by default.** It resolves to `wss://`, default port **443**.
- There is **no `mcpls://`**. A second scheme differing only in security invites the mistake
  of reaching for the shorter one.
- **`mcpl://` never resolves to `ws://`.** Plaintext is reachable only by writing `ws://`
  explicitly, which is deliberately more effort than writing `mcpl://`.
- **`mcpl://localhost` is not special.** It resolves to `wss://localhost/` like any other
  authority (port 443 implied and elided, §18.7 vector 9). Local development uses an
  explicit `ws://localhost:PORT`. A scheme that silently weakens for one hostname is a scheme
  whose security property cannot be stated in one sentence.

#### 18.1.1 Rejected forms

A host **MUST** reject each of the following, before any parsing or substitution (§18.2).
Each is a string-level check on the input, and each exists because the alternative is a
silent change of meaning rather than an error.

| Form | Example | Why rejected |
|---|---|---|
| Fragment | `mcpl://h/x#frag` | No defined meaning. Ignoring one discards something the author believed significant. Reserved for a future revision. |
| Userinfo | `mcpl://u:p@h/x` | RFC 3986 §3.2.1 deprecates the production; parsers and loggers handle it inconsistently enough that behaviour cannot be specified portably. A **syntax** rule, not a credential one — see §18.3. |
| Empty authority | `mcpl:///x` | **Silently retargets.** See below. |
| Dot segments | `mcpl://h/a/../b`, `mcpl://h/a/%2e%2e/b` | Cannot survive resolution intact; preserving them is unimplementable and unenforceable. See §18.2.2. |

**Empty authority is the dangerous one.** `mcpl:///evil` looks like a path-only URI, but
under §18.2 the scheme is substituted and the result is parsed as `wss:///evil` — and a
WHATWG URL parser reinterprets the first path segment as the **host**, yielding
`wss://evil/`. A URI that names no host would dial one. Reject at the string level, before
substitution; the parser will not raise it for you.

#### 18.1.2 Compatibility

`ws://` and `wss://` remain fully accepted wherever a URL is accepted today. This section
adds a spelling; it deprecates nothing and breaks no existing configuration.

A host **MUST** accept all three forms. A host **SHOULD** preserve whichever the operator or
agent wrote (§18.4).

### 18.2 Resolution and canonicalization

Resolution is a **pure syntactic rewrite**. No lookup, no negotiation, no probing.

```
1. Reject the forms in §18.1.1 — string-level checks on the input, before anything else.
2. Substitute the scheme: mcpl: → wss:
3. Parse the result with a WHATWG-URL-conformant parser.
   That parsed value IS the resolved transport target.
4. The canonical mcpl:// form is that same value with the scheme mapped back to mcpl:.
```

**Resolve first, then canonicalize.** This ordering is the whole design, and it is not
arbitrary — see §18.2.1.

Step 3 delivers, for free and identically in every conformant implementation: host
lowercasing, IDNA/punycode conversion, elision of the default port 443, empty-path
normalization to `/`, IPv6 literal lowercasing, and dot-segment removal (which cannot occur,
having been rejected in step 1).

The **query is preserved verbatim** — order kept, duplicates kept, nothing sorted. Query
parameters are server-defined (`?world=abc` means something to the server and nothing to
MCPL), so normalizing them would change their meaning. This is deliberately unlike the
manifest digest of §17.2, which normalizes because it *hashes* the value rather than
transmitting it. A WHATWG parser preserves query order and duplicates, so this needs no
special handling — but an implementation that round-trips through `URLSearchParams` and
re-serializes will break it.

#### 18.2.1 Why not canonicalize the `mcpl://` form directly

**`mcpl:` is a non-special scheme.** WHATWG URL applies host and path normalization only to
its special schemes (`http`, `https`, `ws`, `wss`, `ftp`, `file`). Parsing an `mcpl://` URI
directly therefore performs **almost none** of the normalization this section requires:

| Input | Parsed as `mcpl:` (non-special) | Parsed as `wss:` (special) |
|---|---|---|
| `…//EIDOVERSE.Animalabs.AI:443/x` | host `EIDOVERSE.Animalabs.AI:443` — case kept, port kept | host `eidoverse.animalabs.ai` — lowercased, port elided |
| `…//ünicode.example/x` | `%C3%BCnicode.example` — percent-encoded UTF-8 | `xn--nicode-2ya.example` — IDNA A-label |
| `…///x` | host `""` — accepted | host `x` — first path segment promoted |

The middle row is the one that forces the design: the same input yields **two different
hosts** depending on which form an implementation normalizes. Not a formatting difference —
a different endpoint. An implementation that canonicalizes `mcpl://` directly and one that
resolves first would disagree about identity, deduplication, and what "already connected"
means.

So: **a host MUST NOT rely on a URL library's normalization of the `mcpl://` form.** Canonical
identity is defined by the resolved `wss:` value, which every conformant parser computes the
same way.

#### 18.2.2 Dot segments are rejected, not preserved

WHATWG URL removes dot segments even for non-special schemes: `mcpl://h/a/../b` parses to
`mcpl://h/b`, and `%2e%2e` collapses identically. Preserving them literally would require
every implementation to hand-roll a parser, and would still not hold — HTTP and WebSocket
infrastructure between the host and the server may normalize again in transit. The spec
would be promising something it cannot deliver past the first proxy.

Rejecting instead gives the same security property — no silent retargeting — without
depending on a guarantee nothing downstream honours. `.`, `..`, and their percent-encoded
forms (`%2e`, `%2E`, in either position) **MUST** be rejected as complete path segments.
Percent-encoded separators are *not* affected: `a%2fb` is one literal segment containing a
slash and remains valid.

### 18.3 Credentials

**This section is deliberately unopinionated about credentials.** It defines no credential
parameter, forbids none, and makes no claim about what may appear in a query string:

- An invite token that resolves to a **new** principal is a thing you hand someone, and
  handing someone a URI is how. A prohibition here would contradict that design.
- Credential *policy* belongs to the host and to whatever identity mechanism a future
  revision defines. A locator that legislated it would be claiming authority it does not
  have — the same overreach this specification removed from feature sets and from
  `scope.label`.

What remains true regardless, and is stated in §18.6: **possessing or resolving an `mcpl://`
URI grants nothing.**

Hosts retain complete freedom to attach credentials out of band (resolving per-dial so
nothing above the transport holds a credential), to redact whatever they choose when
displaying or logging a URI, and to refuse URIs they consider unsafe. None of that requires
this section's permission, and this section does not constrain it. (Contrast §19.6, where
a *reference* URI carried in a content block is subject to a no-embedded-credential rule —
that rule is about content blocks reaching model context, not about endpoint locators.)

### 18.4 Three values, not one

An endpoint has **three** distinct values. A host **MUST** retain all three and **MUST NOT**
derive one by overwriting another:

| Value | What it is | Used for |
|---|---|---|
| `configuredUri` | Exactly what the operator or agent wrote, byte for byte | Provenance — what was *intended* |
| `canonicalUri` | The §18.2 normalized `mcpl://` form | Equality, deduplication, "already connected" |
| `resolvedTransport` | The `wss://` target actually dialled | Debugging, logs, what the socket did |

```jsonc
{
  "id": "eidoverse",
  "configuredUri":    "mcpl://EIDOVERSE.Animalabs.AI?world=abc",
  "canonicalUri":     "mcpl://eidoverse.animalabs.ai/?world=abc",
  "resolvedTransport": "wss://eidoverse.animalabs.ai/?world=abc"
}
```

Collapsing any pair loses something that cannot be recovered. Overwriting `configuredUri`
with the canonical form destroys **intent** — a config that says `mcpl://` asserts "this is
an MCPL endpoint, reached securely", and rewriting it makes that assertion look like an
implementation detail to the next reader. Overwriting `canonicalUri` with the configured
form destroys **identity** — two spellings of one endpoint stop comparing equal, and
deduplication silently fails.

Host introspection surfaces (e.g. a connection listing) **SHOULD** expose all three as
separate fields, alongside advertised capabilities, the effective grant (§5.4), and manifest
freshness (§17) — which are likewise distinct facts that have historically been shown as
one.

### 18.5 Connection semantics

Resolution supplies the WebSocket target; connection and initialization follow §4.2.
Resolution does not establish that MCPL is present.

- The peer **MUST** complete MCP `initialize` and advertise `experimental.mcpl` (§5.1).
- If it does not, the host **MUST** either fail the connection or take the **explicit**
  MCP-only fallback of §3.3 — as a recorded decision, surfaced to the operator.
- A host **MUST NOT** infer MCPL support from successful resolution, from the scheme, or from
  the socket opening. `mcpl://` states an *intent* about what should be there; only the
  handshake establishes what is.

Guessing here would make the scheme load-bearing for a fact it cannot carry, which is the
failure mode §18.6 exists to prevent.

### 18.6 Security

**Possession of an `mcpl://` URI, and successful resolution of one, grant nothing.**

The URI is a locator. Every question of authority is answered after connection, by the
capability grant of §5.4. Specifically, connecting via `mcpl://`:

- does not grant any capability, and does not pre-authorize any;
- does not accept a producer tag ontology (§16.4) — acceptance stays explicit;
- does not register or authorize any channel (§14.1);
- does not establish wake policy;
- does not confer identity on either party.

**Redirects.** A redirect that changes the canonical origin (scheme-equivalent, host, or
port) **MUST NOT** be followed without a new authorization decision. Following one silently
would let the named endpoint hand the connection to an unnamed one, defeating the point of
writing the URI down.

**Egress policy applies.** Resolution is subject to whatever egress, SSRF, and
private-network policy the host enforces. Adding a scheme does not add a guard, and a host
**MUST NOT** treat `mcpl://` as evidence that a destination is safe to reach.

### 18.7 Test vectors

Implementations **MUST** reproduce these exactly. Every value below was produced by running
the §18.2 algorithm, not written by hand.

#### 18.7.1 Resolution

| # | Input | `canonicalUri` | `resolvedTransport` |
|---|---|---|---|
| 1 | `mcpl://example.com` | `mcpl://example.com/` | `wss://example.com/` |
| 2 | `mcpl://example.com/path` | `mcpl://example.com/path` | `wss://example.com/path` |
| 3 | `mcpl://example.com:8443/x` | `mcpl://example.com:8443/x` | `wss://example.com:8443/x` |
| 4 | `mcpl://eidoverse.animalabs.ai?world=abc` | `mcpl://eidoverse.animalabs.ai/?world=abc` | `wss://eidoverse.animalabs.ai/?world=abc` |
| 5 | `MCPL://Example.COM/x` | `mcpl://example.com/x` | `wss://example.com/x` |
| 6 | `mcpl://EIDOVERSE.Animalabs.AI:443/x` | `mcpl://eidoverse.animalabs.ai/x` | `wss://eidoverse.animalabs.ai/x` |
| 7 | `mcpl://ünicode.example/x` | `mcpl://xn--nicode-2ya.example/x` | `wss://xn--nicode-2ya.example/x` |
| 8 | `mcpl://[2001:DB8::1]:8443/x` | `mcpl://[2001:db8::1]:8443/x` | `wss://[2001:db8::1]:8443/x` |
| 9 | `mcpl://localhost/x` | `mcpl://localhost/x` | `wss://localhost/x` |
| 10 | `mcpl://h/p?b=2&a=1` | `mcpl://h/p?b=2&a=1` | `wss://h/p?b=2&a=1` |
| 11 | `mcpl://h/x?a=1&a=2` | `mcpl://h/x?a=1&a=2` | `wss://h/x?a=1&a=2` |
| 12 | `mcpl://h/a%2fb` | `mcpl://h/a%2fb` | `wss://h/a%2fb` |
| 13 | `mcpl://h/%7Euser` | `mcpl://h/%7Euser` | `wss://h/%7Euser` |

Note vector 13: percent-encoding is **not** normalized. `%7Euser` and `~user` are different
paths, and an implementation that decodes unreserved characters is non-conforming.

Vectors 10 and 11 exist because an implementation that round-trips the query through
`URLSearchParams` and re-serializes will sort or deduplicate, and fail both silently.

Vectors 6 and 7 are the ones that fail if canonicalization is applied to the `mcpl://` form
directly rather than to the resolved form (§18.2.1): the port survives, the case survives,
and `ünicode.example` becomes `%C3%BCnicode.example` instead of `xn--nicode-2ya.example`.

#### 18.7.2 Rejection

| # | Input | Rejected because |
|---|---|---|
| 14 | `mcpl:///x` | empty authority — would otherwise dial host `x` |
| 15 | `mcpl://u:p@h/x` | userinfo |
| 16 | `mcpl://h/x#frag` | fragment |
| 17 | `mcpl://h/a/../b` | dot segment |
| 18 | `mcpl://h/a/%2e%2e/b` | dot segment, percent-encoded |
| 19 | `mcpl://h/a/./b` | dot segment (single) |
| 20 | `mcpl://h:99999/x` | port out of range |

Vectors 14 and 18 are the two that a string-level pre-check catches and a parser does not:
`mcpl:///x` parses happily as a non-special URI with an empty host, and `%2e%2e` collapses
silently into a shorter path.

### 18.8 Out of scope

Deferred, so parked rather than lost:

- **Mobility** — `server/moved` with host write-back, and stable service hostnames.
- **Structured refusal** — `server_full`, `retryAfter`, queued admission and `ready`.
- **Discovery** — `.well-known`, SRV records, resolving one name across several transports.
- **Multiple transports** — anything other than the direct WSS mapping.
- **Signatures, attestation, capability hints in the URI.**
- **Identity** — principals, enrollment, succession.

Each turns a locator into service discovery or identity. If `mcpl://animalabs.ai/discord`
should one day discover among transports, that is a separate discovery layer on top; this
direct mapping stays valid underneath it and does not need to change.

### 18.9 Backward compatibility

- Purely additive. No existing configuration changes meaning, and `ws://`/`wss://` keep
  working exactly as they do.
- A host that does not implement this section simply rejects `mcpl://` as an unknown scheme,
  which is the pre-0.5 behaviour.
- No change to the grant, to feature sets, to channels, or to the manifest.

---

## 19. Bulk Content References

Content blocks flow to model context — that is what they are for. But some tool results,
push events, and channel messages are best understood as **small testimony about large
payloads**: a rendered wav, a captured image, a dataset, a log archive. Without this
section a server has two bad options: inline the payload as base64 (a context bomb the host
cannot refuse until it has already parsed it) or ship an ad-hoc URL in prose (which no host
can treat uniformly, and which quietly makes URLs — sometimes credential-bearing URLs —
part of model context).

This section standardizes the reference and the handling contract, and deliberately no
storage system. A server describes a payload it holds; the host decides everything that
happens next; the model sees only what host policy derives. The division of labor is the
one MCPL already runs on (compare §16.6 and §5.4): the server testifies, the host disposes.

It adds no capability path (§19.9); §5.4 remains the sole source of what a connected server
may do. It amends the §10.3 / Appendix B.1 content-block shapes (§19.8) and reuses the
§17.2 digest encoding.

> **Status within the draft.** Merged from RFC-005 revision 3 (Draft). RFC-005 §11 makes
> freezing the §19.11 vectors as executable vectors under `conformance/` — run against one
> strict schema/parser implementation and one host-treatment implementation — a
> precondition for Accepted status. That freeze has not happened yet; until it does, this
> section carries Draft strength within the 0.5.0-draft.

### 19.1 The three objects

Everything in this section is one of these, and the boundaries between them are the
normative content:

**1. Server testimony** — the wire object (§19.3). A `resource` content block carrying:
what the payload is (`mimeType`), how big the server claims it is (`sizeBytes`), how to
verify it (`digest`), how long the server intends to serve it (`expiresAt`), what to call it
(`name`), where the server serves it (`uri`), and the server's requested context
disposition (`disposition`). Every field is a claim, not a fact.

**2. Host-private reference record** — never on the wire, never model-visible (§19.5,
§19.6, §19.7). The host's own bookkeeping for a received reference: the raw URI, the
authentication context of the connection that delivered it, fetch state, and — after any
fetch — the *verified* size, digest, and type of the actual octets. Connection credentials
live here and nowhere else.

**3. Model-visible stub** — what context gets (§19.5). A host-generated opaque reference id
plus policy-safe metadata (`name`, `mimeType`, claimed size, provenance). The raw URI is
not part of the stub by default.

Nothing may flow from testimony into the stub except through host policy over the record.
That single sentence is most of this section; the subsections below are its consequences.

### 19.2 Why not a new `blob` type

A distinct type would fork every consumer's content-block switch for zero expressive gain.
The `resource` block already means "URI reference"; what it lacked was enough metadata to
have a policy about, and that is additive.

### 19.3 Server testimony: the reference block

No new content type. The §10.3 `resource` block gains optional fields, and the media blocks
(`image`, `audio`) **in `uri` form** MAY carry the same fields:

```jsonc
{
  "type": "resource",
  "uri": "https://render.example.ts.net/files?path=%2F…%2Fchord.wav",
  "mimeType": "audio/wav",
  "sizeBytes": 4233704,
  "digest": "sha256:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
  "expiresAt": "2026-09-07T00:00:00Z",
  "name": "family_chord_cs80.wav",
  "disposition": "never"
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `uri` | `string` | Yes | Where the server serves the payload. `https` expected; the *host* decides what it will ever dereference (§19.7). |
| `mimeType` | `string` | SHOULD | Claimed media type. Testimony — verify or sniff where safety or provider compatibility depends on it; a digest authenticates bytes, not type. |
| `sizeBytes` | `integer` | SHOULD | Claimed payload size: a non-negative integer within the JSON-safe range (0 ≤ n ≤ 2^53−1). An invalid value is rejected **as a field** — treated as absent — while the block and its `disposition` remain in force (§19.8, vector 15). Testimony — real fetch limits run on actual bytes (§19.7). |
| `digest` | `string` | MAY | `sha256:` + base64url, the §17.2 *encoding*; the hash is SHA-256 over the exact payload octets — the representation with **no content coding applied**. `sizeBytes` and `digest` MUST describe the same octet sequence. |
| `expiresAt` | `string` (ISO-8601) | MAY | Advisory availability horizon. An unparseable value fails closed: consumers treat the reference as already expired, never as immortal (§19.7.2). |
| `name` | `string` | MAY | Display label, nothing more: never a path component — storage names are host-generated (§19.7.1) — and truncated to host display bounds in stubs (§19.5). |
| `disposition` | `"never" \| "ref"` | MAY | Requested context disposition (§19.3.1). Only legal on URI-form blocks (§19.8). |

A reference with neither `mimeType` nor `sizeBytes` is legal but self-defeating: it denies
the host the two facts every disposition policy needs. Conformant emitters SHOULD treat
both as required in spirit.

#### 19.3.1 `disposition`, and the authority asymmetry

| Value | Server's testimony |
|---|---|
| `"never"` | Neither the payload nor the access capability (the URI) may reach model context. Only a stub (§19.5) may represent this block. |
| `"ref"` | Context should see the stub, not the payload. A host MAY additionally fetch and inline where the *verified* payload is within host policy. |
| *(absent)* | No testimony. Host default policy applies; for inline `data` blocks this is the pre-existing behavior, unchanged. |

The authority here is deliberately asymmetric, and the asymmetry is the point: **a server
can veto context inclusion but can never expand it.** `"never"` binds the host (§19.5 — the
strongest MUST in this section); nothing a server writes can compel inlining, compel a
fetch, or add one byte to context that host policy would not have admitted. A server can
only stop pretending its payload is context-sized. (Compare §16.6: tags are never
authority. Disposition is the same species — testimony — with one binding value whose
effect is only ever subtractive.)

There is no `"inline-ok"` value: it would bind nobody, and absent-disposition host policy
already expresses it.

This field is unrelated to the change-receipt `disposition` of §17.6 (`applied` |
`decision-needed` | `informational`); the two never appear on the same object.

### 19.4 Scope: where reference blocks may appear

Reference blocks are scoped to the **server→host `ContentBlock[]` lanes**, where context
disposition is meaningful: **tool results** (`tools/call`), **push events** (`push/event`
`payload.content`, §9.2), **incoming channel messages** (`channels/incoming`, §14.3), and
**injections** (§10).

Push events are the priority case: the one lane where the server chooses what enters
context *unilaterally* — there is no tool-call moment where the host could intervene on
size. Hosts MUST apply §19.5 *before* wake-text assembly, so an annotated attachment can
never inflate the cost of the wake that announces it (vector 8).

**Deferred: host→server.** `channels/publish` and tool arguments are not symmetric lanes:
generic tool arguments are tool-defined JSON, not `ContentBlock[]`, so the protocol cannot
silently impose this shape on them; and `channels/publish` is delivery to an *external
recipient*, where "context disposition" answers nothing — the real contract there is
upload-vs-link-vs-omit, which deserves its own specification. A tool MAY document that an
argument accepts a §19.3 reference block; that is a tool contract, not protocol.

### 19.5 The model-visible stub

Where a block is withheld from context — always for `"never"`, by default for `"ref"` —
the host represents it as at most:

- a **host-generated reference id**: opaque, stable for the life of the session, unique
  per record (e.g. `ref_7f3a`). This is the thing a model can safely name — mention to a
  user, cite in reasoning, hand to the host's own facilities (a code-execution runtime's
  host-mediated fetcher, §19.6). It is host-local naming, not a server-resolvable handle:
  servers never see it and nothing here asks them to accept it. (Cross-server handle
  interchange remains deferred, §19.10.)
- `name`, `mimeType`, claimed `sizeBytes` — labeled as claimed, since none is verified at
  stub time;
- one line of provenance ("from tool `vst_render`" / "attachment on push event …").

**The raw `uri` is not part of the stub by default, and under `disposition:"never"` it is
removed unconditionally** — no host policy, capability classification, or user setting
restores it; `never` limits payload and access-capability exposure both, always (vectors
1, 9). Signed URLs and query capabilities are bearer credentials that look like locations;
putting them in context recreates in one field the leak §19.6 closes in another. For `ref`
or absent disposition only, a host MAY include the URI where its policy classifies the
reference as non-capability-bearing (for example: an origin-bound URI that is unusable
without the host-private auth context — precisely what §19.6.1's no-embedded-credential
rule produces). The safe default everywhere is the opaque id.

**Stub bounds.** Before stub or wake-text assembly the host truncates every
server-supplied string (`name`, `mimeType`, provenance inputs) to its own display bounds,
marking truncation, and bounds the total stub by its own policy. Stub and wake size are
therefore independent of the length of *every* server-supplied field, not only of
`sizeBytes` (vectors 8, 17).

Reference ids are not reused within a session. Records MAY be evicted by host policy
(quota, age, session shrink); a lookup of a stale or unknown id returns a defined
"unknown reference" error and never resolves to a different record (vector 20).

Hosts SHOULD render stubs uniformly so models learn one shape, and SHOULD retain an
operator-visible receipt when policy drops a block entirely, so "missing attachment" is
distinguishable from "nothing was sent".

### 19.6 The host-private reference record and credentials

#### 19.6.1 Authentication context, not a token

The credential (or transport identity) of the connection that delivered a reference is a
**host-private authentication context**. It is never exposed to the model, the user, or a
code-execution namespace, and it never appears in a stub, a log line, or a URI — *because a
content block named a location*, or for any other reason this section creates.

A host MAY apply that authentication context **only**:

- through a **host-mediated fetcher** (the host's own code; never by handing material to
  the requester), and
- to **exactly the origin the connection was dialed to.** An arbitrary URI in a content
  block binds nothing, and no other origin is authenticated: every reference elsewhere is
  fetched without the connection's authentication context. (A manifest mechanism for
  declaring additional authenticated reference origins — field, canonical origin grammar,
  matching rule, redirect relation, vectors — is deferred, §19.10.)

Authentication context is **never forwarded cross-origin**: on any redirect that leaves
the bound origin, credentials are stripped, and a host MAY simply refuse redirect
traversal entirely (§19.7). References to third-party locations (a public CDN, another
service) are fetched **without** the server's authentication context; that location's own
auth applies and is out of scope.

Server side, two requirements of different testability, stated separately:

- A server that intends its references to be host-fetchable *with authentication* MUST
  serve them at the connection's dialed origin, under an authentication mechanism
  satisfiable by that connection's transport-native context — a per-transport requirement,
  testable per transport (for the WebSocket bearer case: the reference endpoint accepts
  the same token that opened the session). Where it cannot or does not, it serves them
  unauthenticated or accepts that they are not host-fetchable.
- Servers MUST NOT mint per-reference bearer credentials into the `uri` itself — testable
  syntactically (vector 6). A URI with an embedded credential is a capability that looks
  like a location; it gets pasted into channels, logged by proxies, and quoted in stubs.

**Transports without a reusable credential** (stdio; host-managed access; short-lived
session auth): the authentication context is whatever transport-native identity the
host-mediated fetcher can present — and where that is nothing, only references the server
chooses to serve unauthenticated are fetchable. A server on such a transport that wants
fetchable references needs to serve them accordingly; the host invents no credential on its
behalf.

Credential lifetime and reference lifetime are independent: an `expiresAt` beyond the
connection's credential does not promise the payload is fetchable, only that the server
intends to keep serving it to a caller who can still authenticate.

There is no host→server credential "inversion": the server holds no host credential under
the current connection model, so there is nothing to specify.

#### 19.6.2 What the record holds

For each received reference the host keeps (privately): the raw URI; the connection/auth
binding; fetch state; and, after any fetch, the **verified** byte count, digest outcome,
and observed media type. Model-visible statements about a payload's actual properties come
from the record's verified fields, never from testimony.

### 19.7 Dereference policy: fail closed

Receipt of a reference **MUST NOT itself trigger dereference.** A fetch happens only by
explicit host policy or explicit host-mediated action (a user asks; a code-execution
script asks the host's fetcher; host policy pre-fetches a class it has decided to trust to
a bounded store). Every server-supplied field is testimony at a security boundary; the
digest check happens after bytes arrive and protects integrity, not resources.

A conformant host fetcher:

1. **Allowlists schemes** — `https` by default; anything else (notably `file`, `ftp`,
   link-local and internal-network targets) is refused unless host policy names it.
   Fail closed (vector 11).
2. **Allowlists origins** per §19.6.1's binding rule, and **bounds redirects**: a fixed
   small hop limit, credentials stripped on any cross-origin hop, or redirect traversal
   refused outright (vector 12).
3. **Streams with a hard actual-byte ceiling** from host policy, aborting the transfer the
   moment real octets exceed it — regardless of `sizeBytes`, which a mistaken or malicious
   server can understate (vector 10). Declared size never allocates resources; at most it
   *denies* early (a claim already over the ceiling is refused without a fetch, vector 4).
4. **Verifies before presenting**: where `digest` is present, a fetched payload whose
   octets do not match MUST NOT be presented as the described content (vector 5).
   `mimeType` is verified or sniffed where anything safety- or compatibility-relevant
   depends on it (vector 13).

#### 19.7.1 Storage naming

When a host materializes a fetched payload, **the host generates the storage path and
filename** — from the reference record (e.g. the reference id plus an extension derived
from the *verified* media type) — and the server-supplied `name` is never a path
component, sanitized or otherwise. Basename-sanitizing a hostile string still leaves
collisions, reserved/device names, control characters, and bidi/homoglyph surprises;
generating the name leaves nothing. The display label, if kept alongside, is stripped of
control and bidi-override characters and bounded per §19.5 (vectors 14, 18).

#### 19.7.2 Lifetime

`expiresAt` is advisory. A fetch after expiry failing is an ordinary error, not a protocol
violation. An unparseable `expiresAt` fails closed — the reference is treated as already
expired, never as immortal. Servers SHOULD keep references valid for a window they state
(in the field or in tool documentation); nothing here creates a retention obligation, a
garbage-collection protocol, or a way to ask for an extension.

### 19.8 Schema

Appendix B.1 carries the normative schema. In summary: the `resource` variant gains the
six optional properties of §19.3 with emitter-side maxima (`uri` ≤ 4096, `mimeType` and
`name` ≤ 255, `expiresAt` ≤ 64, `sizeBytes` within `[0, 2^53−1]`, `digest` matching
`^sha256:[A-Za-z0-9_-]{43}$`, `disposition` ∈ {`never`, `ref`}); the `image` and `audio`
variants gain the same properties **on their `uri`-form branch only** — `disposition`
alongside inline `data` is schema-invalid; the `text` variant is unchanged and carries no
`disposition` (a text block *is* context-sized by construction).

The maxima are emitter conformance bounds, and they are the *outer* fence, not the
guarantee: the guarantee is host-side (§19.5) — every server-supplied string is truncated
to host display bounds before stub/wake assembly, so a nonconforming emitter still cannot
move mass into metadata (vector 17).

**One invalid-field rule** for every optional property: a value that violates its schema
constraint is rejected **as a field** and treated as absent; the block remains valid, and
a subtractive `disposition` remains in force. Field invalidity never widens exposure —
there is no reading of a malformed `sizeBytes` under which the payload becomes
context-eligible (vector 15). (`uri` is the one required property; a block whose `uri`
violates the schema is rejected whole.)

Field placement: `disposition` is a top-level property of the block variants that can
carry it, not a member of a generic `annotations` object — MCP already defines an
`annotations` vocabulary on content blocks (`audience`, `priority`, …), and colliding with
it, or with `_meta`, buys nothing.

Handling rules the schema cannot express:

- An emitter that sends inline `data` purporting bulk disposition through any channel the
  schema misses is nonconformant; the receiving host still **fails closed** (withholds the
  `data` from context, MAY log) (vector 2).
- Unknown additional properties on content blocks are ignored (existing behavior), which
  is also the degradation story: an annotated block parses on a pre-§19 host as an
  ordinary §10.3 block, and the only loss is the courtesy (vector 7).

#### 19.8.1 MCP interoperability

MCP's own vocabulary has a nested `EmbeddedResource` (inline content — under this section
an ordinary inline block, nothing new) and a distinct `ResourceLink`. MCPL keeps its
direct `resource: {uri}` shape; a host or bridge translating MCP→MCPL maps a
`ResourceLink` onto this testimony record field-for-field (`uri`→`uri`, `name`→`name`,
`mimeType`→`mimeType`, `size`→`sizeBytes`, `annotations` dropped or host-mapped) with no
`disposition` — absent testimony, host default policy, exactly as for any unannotated
reference. There is one reference vocabulary here, not two; `ResourceLink` is an import
path into it.

### 19.9 No new capability

Emitting a reference block inside a message the server was already authorized to send adds
no authority: the block moves strictly less into context than the same bytes inlined would
have, and §19.6/§19.7 give the server no new reach into the host. There is therefore no
`uses` entry, no grant, and nothing for §5.4 to gate. Conversely, nothing here bypasses
§5.4: a server that cannot push cannot push a reference either. There is no manifest
touch: declared reference origins are deferred with the rest of cross-origin
authentication (§19.10).

### 19.10 What this deliberately is not

- **Not a blob store.** MCPL moves no payload bytes under this section; it moves
  descriptions.
- **Not handle interchange.** The powerful version — an opaque handle minted by one
  server, passed by the agent to another, bytes streamed host-side between them — is real
  and deliberately deferred; the §19.5 reference id is host-local naming and expressly
  *not* that handle. (Same posture as §18.8's deferral of mobility.)
- **Not a host→server delivery contract.** §19.4's deferral: recipient-delivery semantics
  for `channels/publish` attachments deserve their own document.
- **Not authenticated cross-origin fetching.** Declared reference origins — the manifest
  field, canonical origin grammar, host matching rule, auth binding per transport, and
  redirect relation — are deferred (§19.6.1). Exactly one origin is authenticated: the one
  the connection was dialed to. A server whose references live elsewhere serves them
  unauthenticated or waits for that revision.
- **Not a transport mandate, and not compression, chunking, ranges, or resumption.** HTTP
  has all four.

### 19.11 Conformance vectors

Not yet frozen as executable vectors (see the status note at the top of this section).

| # | Input | Expected |
|---|---|---|
| 1 | `resource` block, `disposition:"never"`, host assembles context | At most a §19.5 stub appears; neither payload bytes nor `uri` appear model-visible |
| 2 | Inline `data` presented with bulk disposition through any gap in schema enforcement | Emitter nonconformant; host fails closed — `data` withheld, MAY log |
| 3 | `disposition:"ref"`, verified payload within host inline policy | Host MAY inline; stub otherwise. No violation either way |
| 4 | `sizeBytes` claim exceeds host ceiling | Host refuses the fetch without dialing; stub unaffected |
| 5 | Fetched octets' digest ≠ `digest` | Host MUST NOT present them as the described content |
| 6 | `uri` containing an embedded credential from the emitting server | Emitter nonconformant (§19.6.1); host MAY refuse to dereference |
| 7 | Reference block on a pre-§19 host | Parses as ordinary §10.3 content; degradation limited to lost courtesy |
| 8 | Push event: one text block + one `"never"` reference | Wake carries the text and a stub; wake size independent of `sizeBytes` |
| 9 | Reference whose `uri` is a signed/query-capability URL | Stub shows reference id, `name`, type, size. Under `never`: URI absent unconditionally. Under `ref`/absent disposition: URI absent unless explicit host policy includes it |
| 10 | Stream exceeds claimed `sizeBytes` and continues | Fetcher aborts at the host's actual-byte ceiling; partial bytes are not presented |
| 11 | `uri` scheme `file:` (or other non-allowlisted) | Fetch refused; fail closed |
| 12 | Fetch redirects cross-origin | Credentials stripped at minimum; traversal MAY be refused; bound hop limit either way |
| 13 | Fetched content sniffs as a different media type than `mimeType` | Host treats `mimeType` as false testimony where anything depends on it; record stores the observed type |
| 14 | `name` of `"../../.ssh/authorized_keys"` | Storage path/filename host-generated from the record (§19.7.1); the string appears at most as a bounded, sanitized display label |
| 15 | `sizeBytes` of `-1`, `3.5`, or `2^53` | Field rejected, treated as absent; block remains valid; a `"never"` disposition remains in force; value never used in arithmetic |
| 16 | Unparseable `expiresAt` | Treated as already expired (fail closed), never as immortal |
| 17 | `name` (or `mimeType`) of 1 MB, past schema maxima | Emitter nonconformant; host truncates to display bounds before stub/wake assembly — wake size unchanged |
| 18 | `name` containing control characters, bidi overrides, or a reserved device name | Storage unaffected (host-generated name); display label stripped of control/bidi characters |
| 19 | Payload served with `Content-Encoding: gzip` | `sizeBytes` and `digest` describe the *decoded* identity octets; fetcher verifies against those, and the streaming ceiling applies to decoded bytes |
| 20 | Lookup of an evicted or unknown reference id | Defined "unknown reference" error; the id never resolves to a different record within the session |

### 19.12 Example (non-normative)

A render server whose tool results reference multi-megabyte wav files on a machine its
callers cannot shell into. Before, inside a `text` block:

```jsonc
{ "path": "/render/vst_out/chord.wav", "peak": 0.605,
  "download_url": "https://…/files?path=…", "download_note": "append &token=<your token> to fetch" }
```

The same result as a reference:

```jsonc
"content": [
  { "type": "text", "text": "{\"path\":\"…\",\"peak\":0.605,\"rms\":0.18,\"render_ms\":676}" },
  { "type": "resource",
    "uri": "https://render.example.ts.net/files?path=%2F…%2Fchord.wav",
    "mimeType": "audio/wav", "sizeBytes": 4233704, "name": "chord.wav",
    "disposition": "never" }
]
```

`download_note` disappears because §19.6.1 makes credential handling the host's business;
the model sees `ref_… chord.wav (audio/wav, ~4.2MB, from tool vst_render)`; and the host
can fetch (origin-bound, ceiling-bounded, digest-checked), stage, or hand the wav to a
code-execution script as a path — none of which it could do with prose, and none of which
puts a URI or a token anywhere a model could quote it.

---

## 20. Event Coalescing

> **Status within the draft.** Merged from RFC-006 revision 8 (Draft); this section carries
> Draft strength within the 0.5.0-draft. §20.1–§20.14 carry RFC-006 §1–§14 under the same
> numbers, and §20.15 carries RFC-006 §16. RFC-006 §15 (implementation notes) stays in the RFC.

### 20.1 Summary

Some events describe a **moving subject**: a document being typed into, a partial speech
transcript being revised, a sensor reading, a chat message edited seconds after it was sent.
Today every observation of such a subject is a separate, append-only event. If the model has
not run yet, the host's context fills with a stack of stale intermediate states — `cat`,
then `cater`, then `caterpillar` — that the model must read, pay for, and mentally collapse.

This section adds an OPTIONAL **`coalesce`** member to `push/event` params and
`channels/incoming` messages, naming a server-chosen **key**, with two modes and one
withdrawal form:

- **Plain** — for *self-contained* content (a value, a full message, a transcript
  hypothesis). A new event replaces the previous event under the same key **where it is
  still unread**; otherwise it appends. Hosts may make this decision per context or use a
  conservative shared boundary (§20.3.3). Stateless for the server.
- **Deferred** — for *delta* content ("what changed since you last looked"). The server
  pushes a keyed notice; the host calls **`push/render`** when it is about to show the event
  to a model, and the server describes everything since its previous render. Repeated
  notices under one key collapse into one pending slot.
- **Retract** — the subject ceased to exist. The host removes any pending version and
  appends the supplied deletion notice where a model saw a version or history is unknown.

One rule governs all three:

> **Unconsumed events are mutable by their sender. Consumed events are history, and history
> is never rewritten.**

The host is the only party that knows where that boundary is. Plain mode lets the host apply
it; deferred mode lets the host *ask at* it; retraction lets the host *decide across* it. In
no mode does the server have to learn where it was.

### 20.2 Motivation

- **Live documents.** A Google Docs / editor integration diffs the document and pushes
  "user inserted `cat` at ¶3". Two seconds later the same insertion reads `caterpillar`. If
  the agent was mid-turn, tuned out, or debounced, both events are waiting for it. Only the
  second is true.
- **Streaming transcripts.** ASR emits partial hypotheses that are revised until final.
  Voice and wearable servers currently either withhold partials (latency) or flood the
  context with them.
- **Latest-value telemetry.** Battery, presence, spend, robot pose: a consumer that has not
  looked yet wants the current value, not the series.
- **Chat edits and deletes.** A message edited or deleted before the agent saw it should
  simply *be* the edited message, or be gone. A message deleted *after* the agent saw it
  needs a deletion notice. Today's servers can only ever do the second, and the host is the
  only party that knows which case applies.

**Why the server cannot do this alone.** Server-side debouncing (mcpl-editor does 1.5 s /
5 s max) reduces the stack but cannot eliminate it, because the server does not know when
inference runs. `inference/lifecycle` (§10.5) could tell it, but that is an unacknowledged,
best-effort notification the spec says consumers must not rely on. The consumption boundary
is host-private state; the mechanism has to live where the state is.

#### Design principles

1. **Never rewrite what a model has seen.** Coherence of history and prompt-cache stability
   both follow from this one rule. An unconsumed event has never been in a request, so
   replacing it invalidates nothing.
2. **Servers stay simple.** A server adopting this section keeps no state it does not already
   keep, never resends based on a coalescing outcome, and never branches on what the host
   did. Transport retries follow the bounded idempotency contract (§20.3.1).
3. **Stateless key, not an event chain.** The server names the subject, not the prior
   event.
4. **Fail toward today.** On any uncertainty — unknown key, restart, eviction, mixed
   delivery — the host behaves as an append-only host would: it appends, and it keeps the
   deletion notice. The worst outcome is current behaviour.
5. **No new authority.** A server may only touch its own unread deliveries, within a
   scope it is currently authorized for, and everything it supplies
   passes the checks a fresh event would (§20.10, §20.11).
6. **Additive.** Absent `coalesce`, nothing changes.

### 20.3 Identity, scope, and consumption

#### 20.3.1 Three identities

| Field | Answers | Where | Stability |
|---|---|---|---|
| `messageId` | *which message* | `channels/incoming` | Stable across the message's life: creates, edits, and deletes of one platform message share it. Reply/quote targets refer to it. |
| `coalesce.key` | *which subject's pending updates collapse* | both | Stable for the subject. For a chat message, RECOMMENDED `message:<messageId>`. For a participant's state in a channel, per participant. For a document, per document or region. |
| `eventId` | *which occurrence* | both (NEW on `channels/incoming` messages: OPTIONAL without `coalesce`, **REQUIRED** with it) | Fresh per occurrence. Reused **only** when retrying that same occurrence. |

**Idempotency (amends §9.4).** Hosts deduplicate by occurrence: `eventId` when present,
else `messageId`. A `channels/incoming` message whose `messageId` the host has seen but
whose `eventId` is new is a **new occurrence of an existing message** — an edit — not a
duplicate. Occurrence identity is scoped to the server binding, not the transport epoch.
Producers MUST use distinct occurrence IDs across their own restarts as well.

**Retry window for coalesced occurrences.** Hosts MUST recognize admitted occurrences
carrying `coalesce` and return their original
result, without repeating their effects, for at least 3,600,000 milliseconds after first
admission. This guarantee MUST survive reconnects and host restarts. Current admission
checks still apply; a retry cannot restore revoked authority. A host MAY advertise a
longer guaranteed window as `eventCoalescing.retryWindowMs` (§20.10); omission, including
boolean `true`, means 3,600,000 milliseconds. The value MUST be an integer at least that
large. The host MUST honor the window advertised when it admitted an occurrence, even if
a later initialization advertises a shorter one.

Producers MUST stop retrying when the applicable window has elapsed since their **first
send attempt**, measured by elapsed time, not `timestamp`. If initialization changes while
acceptance is uncertain, the producer uses the shortest window advertised during those
attempts. A producer unable to bound the elapsed time after its own restart MUST NOT retry
the old occurrence. Retrying does not extend the window. An `eventId` repeated after its
window MAY be treated as a new occurrence, so producers cannot rely on deduplication then.
Hosts may retain receipts longer; their storage and retention mechanism is not specified.
This window does not change the rest of this specification's treatment of ordinary traffic.

A `channels/incoming` message that carries `coalesce` **MUST** carry a non-empty `eventId`.
Without it the `messageId` fallback would make an edit a duplicate of its own create, and
the newest state would be the one discarded. Omission is a per-message validation failure
(`coalesce_invalid`, §20.13); the message is not admitted and its subject is untouched.
Messages without `coalesce` keep today's behaviour.

> Deterministic occurrence ids that omit the occurrence — `discord_edit_<messageId>` — are
> a defect this table makes visible: the second edit of a message collides with the first
> and is dropped as a duplicate by any §9.4-conformant host. Occurrence ids MUST
> distinguish occurrences (a counter, revision id, or edit timestamp suffices).

**A channel-scoped key need not name a message.** Presence, position, or status reported
in a channel is a subject too, keyed per participant or per gauge. Successive
`channels/incoming` occurrences under one such key MAY carry different `messageId`s; the
host delivers the unread occupant's own `messageId`, author, and thread.

#### 20.3.2 Key scope

A key lives in exactly one **scope**, and the full subject identity is the tuple

```
(server binding identity, scope kind, scope id, key)
```

| Delivery | Scope kind | Scope id |
|---|---|---|
| `channels/incoming` message | `channel` | the message's `channelId` |
| `push/event` without `coalesce.channelId` | `featureSet` | the event's `featureSet` |
| `push/event` with `coalesce.channelId` | `channel` | `coalesce.channelId` |

The binding identity is **host-owned** and survives reconnects to the same configured
server. A transport epoch is an authorization boundary, not a new coalescing namespace.
Hosts MUST allocate a different binding identity when a configuration is reassigned to a
different server/principal; producers cannot choose that identity through message fields.
For example, the host may bind a configured server ID to its endpoint/command, and require
a new configured ID when credentials select a different principal at the same endpoint.

Every reconnect still repeats initialization and policy negotiation (§4.2). Stable
subject identity never restores an old grant. This section does not change when a channel
registration begins or ends; that remains as §14 has it, for coalesced and ordinary
traffic alike.

**Accepted work is never silently lost.** An occurrence the host answered `accepted: true`
MUST remain available for delivery under host policy until delivered, replaced or
retracted by its sender (including an empty render result), or dropped because its
authority lapsed (§20.5.4 rule 4). A disconnect, a restart, or exhaustion of coalescing slots
is not a reason to discard it. This preservation rule does not force a wake for work that
host policy deliberately keeps pending (§20.4.2). Whether the occurrence **stays replaceable** across
such an interruption is the host's choice: a host MAY instead deliver the pending content
as an ordinary occurrence at that point and treat the subject's history as `unknown`
(§20.2, principle 4). An interrupted render is not replayed to advance a source-backed baseline a
second time; its batch falls back (§20.5.3).

Two servers, two feature sets, or two channels can never address each other's subjects.
A `channel`-scoped push and a `channels/incoming` message with the same `channelId` and
`key` address the **same subject** — which is what lets a create delivered by one method be
edited or deleted by the other without the server remembering which method it used.

**Channel-scoped pushes are admitted against current channel authority.** A `push/event`
carrying `coalesce.channelId` MUST pass ordinary push admission (feature set enabled,
`pushEvents` granted) **and** the checks a `channels/incoming` message for that channel
would pass at this moment: the channel is registered by this server, and `channels.incoming`
is granted and not narrowed away from it (§14.5). "Registered" means exactly what it means
for `channels/incoming` on that host; a channel id that appears only in a push's `origin`
is not registered by that appearance.
Closing a channel does not by itself revoke its registration. A push that fails the channel checks is
refused with `-32017 Channel not permitted` or `-32023 Unknown channel` (§14.6), and no
subject is touched. Hosts MUST NOT derive scope from `origin`, `metadata`, or any other
untrusted field; only `coalesce.channelId` selects channel scope, and only when the host
advertises `channelScopedPush` (§20.10).

**Channel open/close does not change identity or admission.** A closed channel's subjects
keep their keys; a push for one is admitted as above, not as "a message in an open
channel" (§14.3 routing for open channels does not apply). Replacement, rendering, and
retraction act on **the pending deliveries the prior occurrence actually made**: matching a
key can narrow an audience (remove) or update it in place, never widen it. If the
replacement would, as a fresh event, reach a context the prior occurrence did not, the host
delivers it to the prior occurrence's contexts only. If it would reach *none* of them under
current policy, the host removes the prior pending content and appends nothing.

Plain and deferred occupants of one subject share its single slot: a subject has at most one
unconsumed occupant, of whichever mode was sent last. A rendering batch may additionally
have a newer pending batch (§20.5.4); a subsequent plain occurrence supersedes both. Changing
mode never removes consumed history.

#### 20.3.3 Consumption

An occurrence is **consumed in a context** once its content has been included in the
assembly of any request from that context to any model — agent inference, a subagent,
summarization/compression, or a server-initiated `inference/request`. Hosts may apply the
conservative cross-context rule below. Consumption is determined **at context assembly**, not
at response: an occurrence in a request that later fails, is refused, or is aborted is still
consumed. Consumption is **permanent**; there is no un-consume (§20.15).

A **subject** has *consumed history* if any occurrence under it was ever consumed. Hosts
MUST track this per subject as a tri-state — `none` / `some` / `unknown` — for as long as
they track the subject, and MUST degrade it to `unknown`, never to `none`, on eviction,
restart without durable state, or operator intervention. `none` is a positive claim; the
host makes it only when it can establish the subject's complete history, including through
an `initial` claim as below.

**Birth of a subject.** A host can only know it holds a subject's complete history if it
knows where that history starts. The server does: it knows a create from an edit. An
occurrence MAY carry `coalesce.initial: true`, asserting that no earlier occurrence of this
subject was ever sent under this binding. On an `initial` occurrence for a subject the host
is not tracking, the host MAY start the subject at `none`. Without `initial`, an untracked
subject starts at `unknown` unless the host can independently establish its complete
history (for example, from an intact record covering the binding's lifetime). If the host
is already tracking the subject, `initial` has no effect: it never lowers `some` or
`unknown`. A retraction never carries `initial` (§20.13).

> `initial` is a claim, like a tag, and grants nothing. A server that sets it falsely can
> only cause its own later deletion notice to be omitted, which it could achieve more simply
> by never sending the deletion. After history is lost, a host cannot distinguish a new
> subject from an old one merely by looking up its key. `initial` lets the producer make
> that distinction. Restart with complete durable history does not itself lose knowledge.
> A participant returning under a previously used presence key is not a new subject and
> MUST NOT assert `initial`; a producer may instead use a fresh key for each visit.

**Per context.** The consumed-check and any replacement or removal MUST be atomic with
respect to the assembly of each context the occurrence was delivered to. A host MAY decide
per context: replace where the prior occurrence is unread, append where it was read. In a
retraction with a notice, each context with `some` or `unknown` history receives it, and
each with known `none` receives nothing. A host that cannot track contexts separately
treats the occurrence as consumed everywhere once it is consumed anywhere. When contexts differ, the reported
`outcome` is the most conservative among them (`appended` over `replaced`, `noted` over
`retracted`; `consumed` over `retracted` when the withdrawal has no notice). Any reported
`priorEventId` MUST identify an occurrence actually displaced or found consumed; it may be
omitted if the contexts have different predecessors.

This flexibility MUST NOT break a deferred renderer's shared baseline. Once a rendered
occurrence is consumed in one context, its materialized content is preserved in every
recipient context (§20.5.2), including recipients that have not yet read it. Subsequent
rendered deltas cannot replace that prerequisite in an unread context. Per-context
replacement is useful for complete plain occurrences; it does not authorize dropping a
rendered delta that a later delta depends on.

### 20.4 Plain coalescing

For content that is **complete in itself**: reading only the newest occurrence leaves the
model correctly informed, and reading an older one followed by the newest is merely
redundant, never wrong.

```jsonc
{ "method": "push/event", "params": {
    "featureSet": "body.status", "eventId": "evt_41", "timestamp": "…",
    "coalesce": { "key": "battery" },
    "payload": { "content": [ { "type": "text", "text": "Battery 79%" } ] } } }
```

After the admission checks the host would apply to the same event without `coalesce`
(enablement, grant, §14.5 receipt-time validation, §19.5 reference stubbing, §20.3.1 dedup,
and §20.3.2 channel checks when channel-scoped) — a refused occurrence leaves the prior one
untouched —

| Occupant of subject | Host action | `outcome` |
|---|---|---|
| none, with history known `none` | Append. Record as occupant. | `"first"` |
| unconsumed (incl. a pending or rendering batch, §20.5.4 rule 6) | **Replace** (§20.4.1). Record new occurrence as occupant. | `"replaced"` |
| consumed, or history `unknown` | Append. Record new occurrence as occupant. | `"appended"` |

The server does the same thing in every row: nothing.

**Do not use plain mode for deltas.** "Inserted `caterpillar`" appended after a consumed
"inserted `cat`" double-reports. That is what deferred mode is for.

#### 20.4.1 Replacement

For each context where the host treats the prior occurrence as replaceable (§20.3.3), it
removes that occurrence and inserts the new one, within the audience rule of §20.3.2.
Contexts where the occurrence is consumed or conservatively sealed retain it and append
the new occurrence.

**Position is the host's choice, under one constraint:** the replacement MUST NOT be placed
before any content a model has consumed in that context. Within the unread region the host
orders it as it orders any other content. Two placements are common and both conform: where
a fresh event arriving now would go (natural for a gauge or a document, whose content is
true as of its own `timestamp`), and where the replaced occurrence sat (natural for a chat
message, which otherwise moves after the replies to it).

In each context where replacement takes place, the model-visible context MUST NOT contain
any trace of the replaced occurrence — no
tombstone, no "(edited)" marker, no collapse count. If the server wants the model to know
changes were folded, it says so in the content.

#### 20.4.2 Wake

Replacement is a correction of an occurrence that is still pending, not a second occurrence.

Whether an occurrence qualifies for a wake is host policy (§16.6). Coalescing MUST apply
that policy to the replacement as it would to a fresh occurrence. These are behavioral
requirements; hosts may implement them with shared timers, separate timers, or no timers:

- A replacement that now qualifies for a wake MUST receive the host's normal wake
  treatment, even if its predecessor did not qualify. It MUST NOT create a second wake
  solely because it replaced an occurrence with an already pending wake for the subject.
- The host MUST NOT start an inference whose sole pending cause has been replaced by a
  non-qualifying occurrence or retracted unread. Other causes can still start inference;
  this does not undo one already begun or prevent eligible content from entering it.
  §20.5.2 covers an inference whose deferred causes all come to nothing at assembly.
- **No starvation.** For a subject eligible for wake under the current policy, continued
  replacements MUST NOT postpone delivery without bound; the host MUST set a finite
  bound. A deliberate `skip`, revoked authority, or operator pause does not create an
  obligation to wake. The bound constrains postponement caused by replacement, not
  unrelated resource outages.
- Coalescing MUST NOT shorten or extend an unrelated event's configured debounce interval
  solely to implement that bound. Internal timer layout is not part of this contract.

### 20.5 Deferred events

For content that is a **delta** relative to what the model last saw. `push/event` only
(§20.5.5).

#### 20.5.1 The notice

```jsonc
{ "method": "push/event", "params": {
    "featureSet": "gdoc.observe", "eventId": "evt_8f31", "timestamp": "…",
    "tags": ["gdoc:edit"],
    "coalesce": { "key": "doc:1AbC…:edits", "deferred": true,
                  "data": { "by": "olena", "para": 3 } },
    "payload": { "content": [
      { "type": "text", "text": "“Q4 plan” was edited (details unavailable — use get_document)." }
    ] } } }
```

`payload.content` is the **fallback**: what the model sees if rendering fails (§20.5.3). It
MUST be self-contained and SHOULD say how to get the detail by other means.

The host keeps at most one **pending batch** per subject. A notice for a subject with a
pending batch joins it and updates the batch's fallback, `tags`, `timestamp` and latest
`eventId` (`outcome: "replaced"`). If an unread plain occurrence occupies the subject,
the notice removes that occurrence and opens a batch (`"replaced"`), retaining only the
prior audience as §20.3.2 requires. Otherwise it opens a batch (`"first"`). Consumed plain
occurrences remain history. A batch is not model-visible. Wake is as §20.4.2.

Servers send a notice whenever the subject changes (debounced). They do not compute a diff
at that point and do not need to know whether a batch is open.

**Notice data.** A deferred notice MAY carry `coalesce.data`: an arbitrary JSON value, at
most 4 KiB serialized, private to the server. The host stores it with the notice, never
interprets it, never shows it to a model, and hands every retained notice's `data` back in
`push/render`. This lets a server with no queryable source of truth — a webhook relay, a
commit feed — coalesce without buffering anything itself: the host holds the run, the
server folds it. Servers that *can* re-read their subject don't need it, though it is a
convenient place for hints (who edited, which regions).

Hosts MUST retain at least the 64 most recent notices per batch and MAY drop older ones,
reporting how many were dropped.

#### 20.5.2 `push/render` (Host → Server, Request)

When the host assembles a request that would include a pending batch, it first asks the
server for the content:

```jsonc
{ "jsonrpc": "2.0", "id": 12, "method": "push/render",
  "params": { "featureSet": "gdoc.observe", "key": "doc:1AbC…:edits", "eventId": "evt_8f31",
              "notices": [
                { "eventId": "evt_8f2e", "timestamp": "…:02:05Z", "data": { "by": "olena", "para": 3 } },
                { "eventId": "evt_8f31", "timestamp": "…:02:07Z", "data": { "by": "olena", "para": 3 } }
              ],
              "dropped": 0 } }

{ "jsonrpc": "2.0", "id": 12,
  "result": { "content": [ { "type": "text", "text": "¶3: Olena inserted “caterpillar”" } ],
              "timestamp": "2026-09-21T14:02:09Z" } }
```

| Field | Type | Description |
|-------|------|-------------|
| `params.featureSet` | `string` | The notice's feature set |
| `params.channelId` | `string` | Present iff the subject is channel-scoped (§20.3.2) |
| `params.key` | `string` | The subject's key |
| `params.eventId` | `string` | `eventId` of the latest notice in the frozen batch |
| `params.notices` | `Notice[]` | Every retained notice in the frozen batch, oldest first: `eventId`, `timestamp`, `data` if present. Fallback content is not echoed. |
| `params.dropped` | `integer` | Notices older than `notices[0]` the host discarded. `0` if none. |
| `result.content` | `ContentBlock[]` | Everything that changed under this subject since the server's previous render of it (or since observation began). MAY be empty. |
| `result.timestamp` | `string` | OPTIONAL. As-of time of the rendered state; defaults to receipt time |

**Server contract.** Return one description covering the whole batch, either way:

- **From the source.** Describe `last render → now`, then treat *now* as the new last
  render. State: one baseline per subject, advanced on render instead of on push. `notices`
  can be ignored. Intermediate changes that cancelled out vanish. Servers MUST serialize
  baseline reads and advances per subject: two renders for one subject in flight
  concurrently (possible after a host timeout, §20.5.4) MUST NOT both describe the same span or
  leave a span described by neither.
- **From the notices.** Fold `notices[].data` — concatenate, count, summarize. State: none.
  Render is a pure function of its params. If `dropped > 0`, the server **MUST** say so in
  the content ("…and 12 earlier changes not shown"): a notice-only server has no other way
  to recover them, and silence would misreport coverage.

**Host contract.** The host **materializes** the result as an ordinary, durable occurrence —
positioned per §20.4.1, carrying the batch's `tags` and latest `origin`,
delivered to the batch's contexts (§20.3.2 audience) — and proceeds with assembly. The
materialized occurrence is consumed by that request. If the batch was delivered to several
contexts, one render serves all of them at the first consumption by any.

**Empty content means nothing happened.** The subject returned to its baseline (the user
typed `cat` and deleted it). Nothing is appended. If every cause of the inference being
assembled was a deferred batch, and its assembly materialized nothing (each batch rendered
empty, or was cancelled or dropped under §20.5.4), the host SHOULD NOT run that inference: a
model woken with nothing new is invited to invent a cause. An inference with a cause that
is not a deferred batch, or whose assembly materialized any content, proceeds normally.

Rendered content is subject to every check a pushed payload would get (§19.5 stubbing, size
limits, content-block validation).

#### 20.5.3 Timeout and failure

`push/render` is on the inference path and follows hook discipline:

- Hosts SHOULD enforce a timeout; 5 seconds is RECOMMENDED (as `beforeInference`, §10.6).
  Hosts SHOULD render multiple pending batches concurrently.
- On timeout, error, or a disconnected server, the host materializes the **fallback**
  instead. Inference is never failed or blocked beyond the timeout on account of a render.
- A server handling `push/render` MUST NOT issue `inference/request` (§10.7).

**Deferred rendering is best-effort**, and the two server styles fail differently:

- A *source-backed* server that rendered but whose result was not delivered has advanced
  its baseline; that span is described to no one. The fallback tells the model the subject
  changed and how to look, and the truth remains readable at the source. Accepted.
- A *notice-only* server loses nothing on a failed render — the host still holds the
  notices — but the host has materialized the fallback and closed the batch, so those
  notices are consumed unrendered. Their `data` never enters model context; audit retention
  follows §20.11. A server whose stream is unrecoverable and for whom that matters SHOULD carry enough in the
  fallback to be useful on its own.

An opt-in render cursor that would close the source-backed gap is deferred (§20.15).

#### 20.5.4 State machine

Per subject:

```
            notice                 notice (joins)
  ∅ ────────────────► PENDING ◄──────────────────┐
                        │ assembly begins        │
                        ▼                        │
                    RENDERING ── notice ──► RENDERING + PENDING'
                        │  │
                        │  └── retract / plain occurrence ──► CANCELLED
                        │                                        │ result / timeout:
        ┌───────────────┼───────────────────┐                    │ materialize NOTHING
        ▼               ▼                   ▼                    │ (discard; audit per §20.11)
   result ok        empty result       timeout / error / disconnect
   materialize      materialize        materialize FALLBACK      │
   result           nothing                                      │
        └───────────────┴───────────────────┘                    │
                        ▼                                        ▼
                   batch CLOSED  (PENDING', if any, becomes PENDING)
```

Normative rules:

1. **Starting a render freezes the batch.** The `push/render` params describe exactly the
   frozen notices. Notices arriving during a render open a **new** pending batch
   (`outcome: "first"`) and are not part of the in-flight render.
2. **Completing a render closes only its frozen batch.** A new pending batch, if one
   opened meanwhile, stays pending and renders at the next assembly.
3. **Exactly one materialization per batch.** A result arriving after the host has
   materialized the fallback is discarded (audit per §20.11); it MUST NOT replace or amend
   the fallback, even if the fallback is still unconsumed.
4. **Authorization is re-checked at response.** Before materializing a result (or a
   fallback), the host re-runs the batch's admission: feature set still enabled,
   `pushEvents` still granted, and for channel-scoped subjects the §20.3.2 channel checks. If
   any fails, the host materializes nothing and drops the batch. A batch whose authority
   lapsed *before* assembly is dropped without calling `push/render`.
5. **Rendered content is admitted as content.** The result passes the checks of §20.5.2
   regardless of what the notices' fallbacks passed.
6. **Retraction or plain replacement during a render cancels the frozen batch.** A
   `retract` (§20.6) or a plain occurrence (§20.4) for the subject that arrives while its batch
   is RENDERING acts on the subject as if the frozen batch were an unconsumed occupant:
   retraction removes it; a plain occurrence displaces it and becomes the occupant. The
   batch enters CANCELLED. When the render then completes — with a result, empty, or by
   timeout/error — the host materializes **nothing** for it: the result is discarded and
   handled under the audit policy (§20.11), and no fallback is materialized. The cancelling
   operation's own effect (nothing, or the plain occurrence, or the deletion notice per §20.6) is what the model sees.
   A pending batch opened by a notice that arrived after the render started (rule 1) is
   removed by **either** operation: a newer plain occurrence is a complete snapshot and
   supersedes all earlier unconsumed notices, not just the frozen batch. Removed notices
   follow the audit policy (§20.11). A notice admitted **after** the plain occurrence is new
   work and follows §20.5.1; cancellation cannot discard that later notice.
7. **The race is decided at materialization, atomically.** If the host has materialized
   the frozen batch (result or fallback) before the retraction or plain occurrence is
   admitted, the materialized occurrence is an ordinary occupant: unconsumed → it is
   replaced or removed as §20.4/§20.6 say; consumed → history is `some` and §20.4/§20.6 apply. The
   check "is this batch still pending, rendering, or materialized?" and the resulting
   action MUST be one atomic step with respect to the render completion path, so that a
   result and a cancellation cannot both take effect. Servers see nothing of the race:
   their render response is acknowledged either way.

#### 20.5.5 Scope

`deferred` is defined for `push/event` only (feature-set- or channel-scoped). Channel
messages are self-contained; use plain mode. A `channels/incoming` message with
`deferred: true` is malformed (§20.13).

### 20.6 Retraction

The subject ceased to exist: a chat message deleted, a transcript partial discarded, a
notification withdrawn. Retraction is **one request and one host decision**; the server
never inspects the outcome.

```jsonc
{ "method": "push/event", "params": {
    "featureSet": "discord.messaging", "eventId": "discord_del_123_1", "timestamp": "…",
    "tags": ["chat:deleted"],
    "coalesce": { "channelId": "discord:general", "key": "message:123", "retract": true },
    "payload": { "content": [ { "type": "text", "text": "Message 123 by Alice was deleted." } ] } } }
```

`payload.content` is the **deletion notice**: what the model should see *if it ever saw a
version of the subject*. It MAY be empty for pure withdrawal (a discarded transcript partial,
an offer withdrawn before use, or activity the producer intentionally does not correct).
Empty withdrawal cannot inform a model that already read a state that the state changed.
For a deleted chat message it **SHOULD** be non-empty: a model that read a message should
learn it is gone. The host cannot tell a message from any other channel-scoped subject, so it does
not enforce this (§20.13).

The host removes any unconsumed occupant, pending batch, or **rendering batch** (which
becomes CANCELLED, §20.5.4 rule 6) of the subject from every context it was delivered to (no
trace, §20.4.1), then decides on the notice by the subject's consumed history (§20.3.3):

| Consumed history | Pending version | Host action | `outcome` |
|---|---|---|---|
| `none` (positively known) | any / none | Remove pending; append **nothing** | `"retracted"` |
| `some` | any / none | Remove pending; **append the notice** as an ordinary occurrence (§20.4.1) | `"noted"` |
| `unknown` (evicted, restarted, never tracked) | any / none | Remove pending if any; **append the notice** | `"noted"` |
| `some` or `unknown`, and `content` is empty | any / none | Remove pending; append nothing | `"consumed"` |

**The check covers every version, not the current occupant.** *Original read → edit
pending → delete*: history is `some`, so the host removes the pending edit **and** appends
the notice. RFC-006 revision 2 got this wrong.

A subject the host has never heard of is `unknown`, not `none`: the host cannot distinguish
"never sent" from "evicted", and the conservative result — the notice appears, as it does
today — costs one line of context. A subject whose first tracked occurrence carried
`initial` (§20.3.3) can start at `none`, which makes `"retracted"` reachable for a
message created, edited and deleted after the host last evicted or restarted.

A retraction is `accepted: true` whenever it passes admission (which, for channel-scoped
retractions, includes §20.3.2's channel checks). Wake handling follows §20.4.2: a removed
occupant cannot remain the sole cause of an unstarted inference, and an appended notice
receives the host's normal wake-policy treatment. After a retraction the subject's slot is empty; its consumed-history bit persists per
§20.3.3.

### 20.7 Response

`push/event` results and `channels/incoming` per-message results gain an OPTIONAL member:

```ts
coalesce?: {
  outcome: "first" | "replaced" | "appended" | "retracted" | "noted" | "consumed";
  priorEventId?: string;   // occurrence displaced or found consumed, when known
}
```

A supporting host MUST include it whenever the request carried `coalesce` and passed
admission. It is **informational**: no outcome requires the server to do anything. A result
without it means the host did not coalesce.

### 20.8 Server guidance (non-normative)

**Which mode?** Ask: *if the model reads only this occurrence, having read or not read any
earlier one, is it correctly informed?* Yes → plain. Only if it read the earlier ones →
deferred. Subject gone → retract, with a notice if a reader would need one.

| Subject | Mode | Scope | Key |
|---|---|---|---|
| Battery, presence, pose, spend gauge | plain | featureSet | per gauge |
| Transcript hypothesis for an utterance | plain; `retract` (empty) for discarded partials | featureSet | per utterance |
| Chat message: create, edit, delete | plain (`initial` on create); `retract` (with notice) | channel | `message:<messageId>` |
| Participant presence / position / status in a channel | plain; `retract` with a departure notice when prior readers need a correction | channel | per participant or visit |
| Ambient channel activity (movement, emotes, joins) | deferred, one digest per channel | channel | per channel |
| Document edits, comment-thread activity, "N new commits" | deferred | featureSet | per document / thread / repo |

**The whole of a deferred server:**

```
on subject change (debounced):   push notice { key, deferred: true, fallback }
on push/render(key):             d = describe(baseline[key], now); baseline[key] = now; return d
```

Compare today's append-only server, which is the same two lines fused: on change, describe,
advance, push. Nothing is added but the split. A server with nothing to re-read keeps no
baseline at all:

```
on occurrence:                   push notice { key, deferred: true, data: occurrence, fallback }
on push/render(key, notices):    return summarize(notices.map(n => n.data), dropped)
```

**The whole of a chat server's lifecycle handling:**

```
on create:  deliver as today (channels/incoming if open, else push/event with coalesce.channelId)
            + coalesce: { key: "message:" + id, initial: true }
on edit:    push { eventId: fresh, coalesce: { channelId, key }, tags: ["chat:edited"],
                   content: edited text }
on delete:  push { eventId: fresh, coalesce: { channelId, key, retract: true }, tags: ["chat:deleted"],
                   content: "Message <id> by <author> was deleted." }
```

No branch on any outcome. The `chat:edited` tag on an edit that *replaces* an unread
original is harmless — the model sees one message, marked edited, which is true.

**Negotiation.** Use `coalesce` only with a host advertising `eventCoalescing` (§20.10),
`deferred` only under `deferred`, and `coalesce.channelId` only under `channelScopedPush`.
An older host ignores the unknown member: plain events stack as today, retractions append
their notice as today, but deferred notices would stack as fallbacks that are never
rendered — a server that must run against both keeps its append-only path for hosts without
`deferred`.

**Keep debouncing.** Coalescing removes the stack, not the traffic.

### 20.9 Worked examples (non-normative)

#### 20.9.1 Google Docs (deferred, feature-set scope)

```
t0  user types "cat"        → notice K                          → first   (batch opens; wake)
t1  (agent busy)
t2  user types "erpillar"   → notice K                          → replaced (joins batch)
t3  agent turn assembles    ← push/render K → "¶3: inserted “caterpillar”"   (baseline := t3)
t4  user appends " soup"    → notice K                          → first   (new batch)
t5  agent turn assembles    ← push/render K → "¶3: inserted “ soup” after “caterpillar”"
```

Comments are a second subject (`doc:…:comments`), so edit activity and comment activity
render as separate occurrences.

#### 20.9.2 Discord (plain + retract, channel scope, mixed delivery)

Channel `discord:general` is **open**. Alice posts, edits twice, then deletes — all before
the agent runs:

```
create   channels/incoming { messageId: 123, eventId: c123,   coalesce: { key: "message:123", initial: true } }  → first
edit 1   push/event        { eventId: e123a, coalesce: { channelId, key } }                     → replaced
edit 2   push/event        { eventId: e123b, coalesce: { channelId, key } }                     → replaced
delete   push/event        { eventId: d123,  coalesce: { channelId, key, retract: true },
                             content: "Message 123 by Alice was deleted." }                       → retracted
```

For a host that uses `initial` to establish `none`, the model never sees anything, even if
the host restarted or evicted this channel's subjects before message 123 existed. Without
`initial`, a host lacking complete history conservatively yields `noted`, and the model
sees a deletion notice for a message it never saw. A host may retain this conservative
behavior even with `initial`. Had the agent run **after edit 1**, the
same four requests yield `first`, `replaced`, `appended`, `noted`: edit 1 had already
replaced the unread original, so the model saw edit 1 alone; edit 2 is appended as a new
unconsumed occupant, then removed unread by the retraction; and the deletion notice lands
because history is `some`. Final model-visible history: edit 1, then the notice. The server
sent identical requests in both timelines.

Channel **closed**: the create arrives via `push/event` with `coalesce.channelId`; the
tuple is the same, so the edits and delete address the same subject. If the channel closes
*between* create and edit, the edit is admitted against current authority (§20.3.2) and, if
admitted, replaces the pending create in the contexts it reached — not in any new ones.

#### 20.9.3 Portal (plain + retract, channel scope)

Portal already tags deletions `chat:deleted` and pushes `[message deleted] <id>` — today
unconditionally. With `coalesce: { channelId, key: "message:<id>", retract: true }` and the
same content, that line appears when the model saw the message or its history is unknown. Portal's wake policy
(`chat:deleted → mute`) is unchanged: the appended notice is evaluated by it like any event.

#### 20.9.4 Read original → unread edit → delete (the RFC-006 revision-2 defect)

```
create   → first        agent runs: original CONSUMED, history := some
edit     → appended     (original consumed; edit is a new unconsumed occupant)
delete   → noted        edit REMOVED (unconsumed); notice APPENDED (history is some)
```

Model-visible: original, then "Message 123 by Alice was deleted." RFC-006 revision 2 produced
original alone, uncorrected.

#### 20.9.5 Ambient channel activity (deferred, channel scope)

A virtual-world or presence server relays a channel where most traffic is state churn:
participants move, emote, join and leave. Each change is true only until the next one, and
the agent needs the current picture when it looks, not the series. The server keeps one
subject per channel for the churn and one per participant for their state:

```
t0  Bob moves          → notice { channelId, key: "activity", deferred: true }         → first (wake per policy)
t1  Bob moves again    → notice { channelId, key: "activity", deferred: true }         → replaced (joins batch)
t2  Cara joins         → plain  { channelId, key: "presence:cara:visit1", initial: true } → first
t3  Cara says "hi"     → channels/incoming { messageId: 9, eventId: "create:9",
                          coalesce: { key: "message:9", initial: true } }              → first
t4  agent assembles    ← push/render { channelId, key: "activity" }
                        → "Bob moved from the fountain to the gate."
                          (the intermediate position vanished; Cara's presence and greeting
                           are separate occurrences and are delivered as themselves)
t5  Cara leaves        → retract { channelId, key: "presence:cara:visit1" },
                          content: "Cara left the channel."                         → noted
```

Every push in this timeline also carries its own fresh `eventId`, `featureSet`,
`timestamp`, and payload; the abbreviated notice/plain/retract lines show only coalescing
fields and relevant content. The host in this example uses `initial` to establish `none`.
If Cara left before any assembly, the departure would retract her unread presence without
a notice. After t4 the departure notice corrects what the model read; empty withdrawal
would leave that knowledge unchanged. A later visit uses a fresh visit key, or reuses the
participant key without `initial`.

Messages are never folded into the digest: only the churn is. Nothing here requires the
host to know what a "channel message" is; it sees three subjects in one channel scope.

### 20.10 No new capability

Replacing or withdrawing one's own unread occurrence, or supplying its content later rather
than sooner, grants no reach beyond `pushEvents` / `channels.incoming`: the server can put
strictly *less* in front of the model than appending would, only in scopes it is currently
authorized for. There is no `uses` path and nothing for RFC-002 to gate. (A new path would
also be harmful: §6.2 invalidates a feature set with an unrecognized `uses` value, so
adopters would lose the whole feature set on older hosts.) `push/render` is gated by the
same grant as the notice it renders (§20.5.4 rule 4). Channel-scoped pushes are gated by the
grant `channels/incoming` for that channel would need (§20.3.2).

Host support is a **new top-level member** of the host's `capabilities.experimental.mcpl`:

```jsonc
"eventCoalescing": true
// or, partially:
"eventCoalescing": { "pushEvents": true, "channelsIncoming": true,
                     "deferred": false, "channelScopedPush": true,
                     "retryWindowMs": 3600000 }
```

It is deliberately *not* a leaf under `pushEvents` or `channels`: §5.1 defines boolean
`true` as "every leaf beneath this node", so every existing host advertising
`"pushEvents": true` would be read as claiming support it lacks. `retryWindowMs` is a
numeric guarantee, not a capability-grant leaf. Boolean `true` enables all coalescing
features with the default one-hour retry window; an object may advertise a longer window
(§20.3.1). The retry guarantee applies to whichever delivery lanes the host supports.

### 20.11 Security considerations

- **Admission is not bypassed.** Replacements, rendered content, and retraction notices are
  validated as fresh occurrences, at receipt and — for renders — again at response. A
  permissive first occurrence cannot carry a later one past a check.
- **Own subjects only, in authorized scopes.** Identity includes the server's connection
  identity and an explicit scope. Channel scope is admitted against *current* channel
  authority and is never inferred from untrusted fields. Revoking a channel grant revokes
  the ability to replace, render into, or retract from its subjects.
- **Audience can only narrow.** Matching a key updates or removes the prior occurrence's
  pending deliveries; it never delivers to a context the prior occurrence did not reach.
- **Nothing a model saw can be altered.** A server cannot gaslight an agent about its own
  past: by construction the agent has no past with a replaced occurrence, and a retraction
  preserves anything read and appends the supplied correction notice when required.
- **Deletion cannot hide a read message.** The consumed-history bit degrades only toward
  `unknown`, which yields any supplied notice. A host that cannot remember whether the model saw
  something behaves as though it did.
- **Humans and logs are not models.** Only the model-visible context is rewritten. A host
  that keeps an audit record (§13.2) SHOULD record replaced and removed occurrences, folded
  notices, and discarded late render results in it, linked by `eventId`, under the same
  retention policy as its other audit entries. Operator surfaces SHOULD show displaced
  occurrences as displaced. Nothing in this section requires retaining content its author
  withdrew before anyone read it beyond what the host's audit policy already keeps.
- **Late binding.** With deferred mode the content is chosen at consumption time. The
  server learns that an inference is imminent and nothing else — no content, no
  conversation identity; `push/render` carries only its own subject. `inference/lifecycle`
  already discloses as much. A host for which even that timing is sensitive should not
  advertise `deferred`.
- **Notice data is inert.** `coalesce.data` is stored and returned, never interpreted, never
  model-visible, bounded (4 KiB × retained notices per batch).
- **Wake shaping.** A server could wake with an urgent tag and render something bland. It
  could equally have pushed the bland event with the urgent tag; tags are claims, never
  authority (§16.6). Hosts keeping an audit record SHOULD show both under their policy.
- **Resource use.** Keys are bounded; hosts MAY bound tracked subjects per server and evict
  (an evicted occupant is delivered as an ordinary occurrence and thereafter treated as
  consumed; an evicted batch is materialized as its fallback; an evicted history bit becomes
  `unknown`). Render is bounded by timeout. **Coalescing capacity alone is never a reason to refuse.** A host
  unable to allocate a coalescing slot admits the occurrence and degrades to appending (`"appended"`, or
  `"noted"` for a retraction) exactly as a host without coalescing would; it MUST NOT
  return an error solely for lack of coalescing slots on an occurrence it would otherwise
  accept. Ordinary admission, backpressure, storage limits, and operator policy still
  apply; this is not a promise of unbounded buffering. Overflow deferred occurrences use
  their admitted fallback without invoking `push/render`. Tracked subjects still obey
  replacement/retraction rules; an unknown empty withdrawal returns `"consumed"`.
  In a busy
  channel the number of unread subjects is the size of the backlog, and a refusal there
  would drop the message that mattered.

### 20.12 Alternatives considered

- **`onConsumed: "reject"` + server resend (RFC-006 revision 1).** Correct, but every delta server
  needs two snapshots per key, outcome-driven transitions, and a resend path.
- **Retract, inspect outcome, then send `chat:deleted` (RFC-006 revision 2).** Two requests and a
  server branch, and wrong for *read original → unread edit → delete*. The host already
  holds the history; the decision belongs to it.
- **Fresh `messageId` per edit (RFC-006 revision 2).** Breaks reply targets and every consumer that
  keys on the platform id. Occurrence identity belongs on `eventId`.
- **Infer channel scope from `origin.channelId`.** `origin` is server-defined provenance
  with no admission check; letting it select a scope would let any push claim any channel.
- **Dual payload** (incremental + cumulative, host picks). No resend, but the server still
  tracks where the unread run began and computes two diffs per event.
- **Reuse `eventId` to mean replace.** Collides with §9.4; hosts *drop* a repeated
  `eventId` as a duplicate, so the newest state would be the one discarded.
- **`supersedes: <eventId>`.** Server must track ids; a lost response desynchronizes the
  chain; cannot say "whatever is pending for this subject".
- **Thin wake + `context/beforeInference` injection.** Same freshness as deferred mode, but
  the result is a per-request overlay rather than history, the hook runs on *every*
  inference, and it needs `contextHooks.beforeInference.inject.*` — the most consequential
  grant in MCPL — to deliver what is semantically an event.
- **Baseline driven by `inference/lifecycle`.** Best-effort, unacknowledged, and not scoped
  to the contexts that received the event (§10.5).
- **Host-side heuristics** (collapse "similar" pending events). The host cannot know two
  events share a subject, or whether the second is cumulative.

### 20.13 Schema and errors

```ts
interface Coalesce {
  key: string;            // 1..256 bytes UTF-8, opaque to the host
  channelId?: string;     // push/event only: select channel scope (§20.3.2). Requires channelScopedPush.
  deferred?: boolean;     // push/event only. Default false.
  retract?: boolean;      // Default false. Exclusive with deferred.
  initial?: boolean;      // Default false. "No earlier occurrence of this subject was sent" (§20.3.3). Exclusive with retract.
  data?: unknown;         // deferred only; ≤ 4 KiB serialized; server-private
}
interface Notice        { eventId: string; timestamp: string; data?: unknown }
interface CoalesceResult {
  outcome: "first" | "replaced" | "appended" | "retracted" | "noted" | "consumed";
  priorEventId?: string;
}
interface PushRenderParams { featureSet: string; channelId?: string; key: string;
                             eventId: string; notices: Notice[]; dropped: number }
interface PushRenderResult { content: ContentBlock[]; timestamp?: string }

// push/event params            += coalesce?: Coalesce
// push/event result            += coalesce?: CoalesceResult
// channels/incoming message    += eventId?: string            (occurrence id; §20.3.1 — REQUIRED when coalesce present)
//                              += coalesce?: Coalesce          (channelId, deferred MUST be absent)
// channels/incoming result[i]  += coalesce?: CoalesceResult
// host experimental.mcpl       += eventCoalescing?: boolean
//     | { pushEvents?: boolean; channelsIncoming?: boolean; deferred?: boolean;
//         channelScopedPush?: boolean; retryWindowMs?: number } // integer >= 3600000; default 3600000
// new method                      push/render  (Host → Server, Request)
```

**Malformed `coalesce`** — missing or oversized `key`; non-boolean `initial`, `deferred`,
or `retract`; `retract` with `deferred` or with
`initial`; `data` without `deferred` or over 4 KiB; `deferred` or `channelId` on a `channels/incoming`
message; a `channels/incoming` message with `coalesce` but no non-empty `eventId`;
`channelId` or `deferred` sent to a host that does not advertise the corresponding leaf —
is a request error, never a silent append:

- On `push/event`: JSON-RPC error `-32602 Invalid params`, `data: { field, reason }`. The
  event is not admitted; no subject is touched.
- On `channels/incoming`: the affected message's per-message result is
  `{ accepted: false, reason: "coalesce_invalid" }`; other messages in the batch are
  processed normally (§14.3 partial acceptance). Subjects of rejected messages are untouched.

**Channel authority failures** on a channel-scoped push use the existing §14.6 codes:
`-32017 Channel not permitted`, `-32023 Unknown channel`.

### 20.14 Conformance vectors

Unless a vector says otherwise, delivery is authorized and eligible under host policy,
capacity is available, retries are within the advertised window, and a subject described
as a create has `initial: true`. Vectors requiring known `none` apply when the host uses
that claim or independently establishes complete history. Hosts that conservatively keep
`unknown` append a supplied deletion notice instead. Timer, index, and storage layout are
not inspected by these vectors.

Plain:
1. **First.** Unseen subject with history established as `none` → appended; `"first"`.
1a. **Unknown first occurrence.** Untracked subject without `initial` or complete history
    → appended; `"appended"`.
2. **Replace.** E1(K), no inference, E2(K) → next request contains E2's content and no byte
   of E1's; `"replaced"`.
3. **Consumed.** E1(K), inference, E2(K) → history holds E1 unchanged, then E2; `"appended"`.
4. **Consumption at assembly.** E1(K); an inference including E1 fails before output;
   E2(K) → `"appended"`.
5. **Compression consumes.** E1(K) is summarized before any agent inference; E2(K) →
   `"appended"`.
6. **Repeated edits.** Create, edit₁, edit₂, edit₃, no inference → one occurrence in the
   next request, edit₃'s content, `"replaced"` ×3.
7. **Restart with conservative delivery.** E1(K); host restarts, preserving E1 as an
   ordinary occurrence rather than replaceable work; E2(K) → `"appended"`, and the next
   request contains E1 then E2 (vector 40). Retry deduplication still holds (§20.3.1).

Identity and scope:
8. **Occurrence dedup.** `channels/incoming` with (`messageId` M, `eventId` a) then
   (M, b) → second is admitted as a new occurrence; (M, a) again → duplicate, same result
   as the first.
9. **Scope isolation.** Same key across two servers, two feature sets, two channels, and
   feature-set vs channel scope of one server → no cross-replacement.
10. **Create via channel, edit/delete via push.** Open channel: create via
    `channels/incoming` (key K), edit via `push/event` with `coalesce.channelId` (K) →
    `"replaced"`; delete via push retract → `"retracted"`; the model sees nothing.
11. **Create via push, edit via channel.** Closed channel: create via channel-scoped push;
    channel opens; edit via `channels/incoming` (same `channelId`, K) → `"replaced"`.
12. **Open/close transition, audience.** Create delivered to context A while channel open;
    channel closes; edit (admitted) → replaces in A only; the edit is not delivered to any
    context A did not include.
13. **Revoked channel authority.** Create (K); `channels.incoming` narrowed away from the
    channel; edit via channel-scoped push → `-32017`; pending create untouched. Retract →
    `-32017`; nothing removed, nothing appended.
14. **Scope not inferable.** `push/event` with `origin.channelId` = C but no
    `coalesce.channelId`, key K → feature-set scope; does not touch channel-scoped (C, K).
15. **Unadvertised leaf.** `coalesce.channelId` to a host without `channelScopedPush` →
    `-32602`; nothing appended.
15a. **Coalesced channel message without `eventId`.** `channels/incoming` message with
    `coalesce` and no `eventId` (or empty) → `{ accepted: false, reason: "coalesce_invalid" }`;
    subject untouched; siblings in the batch processed. The same message with a fresh
    `eventId` and a previously seen `messageId` → admitted as an edit, `"replaced"` or
    `"appended"`.

Deferred:
16. **One batch.** N1(K), N2(K), N3(K), no inference → exactly one `push/render` at next
    assembly; the request contains the rendered content once and no fallback text.
17. **Notices returned.** In vector 16 the params carry N1–N3 oldest-first, each with its
    `data` byte-equivalent; `dropped: 0`. With 100 notices and a host retaining 64,
    `notices.length + dropped == 100`, newest retained. No `data` appears in any request.
18. **Render is history.** After vector 16, a second inference with no new notice issues no
    `push/render` and its request contains the same materialized occurrence, byte-identical.
19. **New batch after consumption.** N1(K), inference, N2(K) → `"first"`; second render.
20. **Empty render.** Result `content: []` → nothing appended; batch closed. If the batch
    was the inference's only cause → no inference runs. With a pending cause that is not a
    deferred batch → the inference proceeds and contains nothing from K.
20a. **Several empty renders.** N(K1) and N(K2) are the inference's only causes; both
    renders return `content: []` → nothing appended; no inference runs. If K2's render
    returns content instead → the inference proceeds with K2's content and nothing from K1.
21. **Fallback.** Render times out / errors / server disconnected → fallback materialized;
    inference proceeds within the timeout bound.
22. **Notices during render.** N1(K); render starts; N2(K) arrives → `"first"`; render
    params contain N1 only; result materialized; next assembly renders a batch containing
    N2 only.
23. **Late result.** Render times out, fallback materialized (still unconsumed); result
    arrives → discarded (audit per §20.11); model-visible content is the fallback.
24. **Authority re-checked at response.** Feature set disabled (or channel authority
    revoked, for a channel-scoped batch) while render in flight → result discarded; nothing
    materialized; batch dropped. Disabled *before* assembly → no `push/render`.
25. **Render once.** Batch delivered to two contexts → one `push/render`; both receive the
    same materialized occurrence.
26. **No inference from render.** `inference/request` issued while handling `push/render`
    is refused (§10.7).
27. **Dropped coverage.** `dropped > 0` → a notice-only conformance server's result content
    mentions the count.
27a. **Retract during render, late result.** N1(K); render starts; retract K with notice
    (history `none`) → `"retracted"`; result arrives → discarded (audit per §20.11). If every
    cause of the inference was a deferred batch and its assembly materialized nothing, no
    inference runs (§20.5.2); otherwise the request contains nothing from K — neither
    rendered content nor fallback nor notice.
27b. **Retract during render, timeout.** As 27a but the render times out → no fallback
    materialized; as in 27a, either no inference runs or the request contains nothing from K.
27c. **Plain replacement during render, late result.** N1(K); render starts; plain E(K) →
    `"replaced"`; result arrives → discarded; next request contains E's content and no byte
    of the render result or fallback.
27d. **Plain replacement during render, timeout.** As 27c but the render times out → the
    request contains E's content only; no fallback.
27e. **Materialization wins.** N1(K); render completes and is materialized (unconsumed);
    retract K → `"retracted"`, materialized occurrence removed. Same but materialized and
    consumed before the retract → `"noted"`, materialized occurrence retained, notice
    appended.
27f. **Cancel and new pending.** N1(K); render starts; N2(K) (`"first"`, new pending
    batch); retract K → both the frozen and the pending batch are removed; result arrives →
    discarded; next assembly issues no `push/render` for K.
27g. **Plain supersedes frozen and pending, late result.** N1(K); render starts; N2(K)
    opens a new pending batch; plain E(K) → `"replaced"`. Both batches are superseded.
    The late result is discarded; assembly contains E only and issues no render for N2.
27h. **Plain supersedes frozen and pending, timeout.** As 27g, but the first render
    times out. Neither batch's fallback appears; assembly contains E only.
27i. **Plain → deferred before consumption.** Plain E(K); N(K) with `deferred: true`
    → `"replaced"`. E is removed unread; the next assembly renders N and contains only
    its result (or its fallback), not E. If E was consumed first, it remains history.
27j. **New notice after replacement.** N1(K); render starts; N2(K); plain E(K); N3(K).
    N1 and N2 stay cancelled; N3 displaces E if unread and opens a fresh batch. Completing
    or timing out N1 cannot discard N3. Its render receives N3 only.

Retraction:
28. **Never consumed.** Create, edit (pending), retract with notice → `"retracted"`; next
    request contains nothing from K.
29. **Read original → unread edit → delete.** Create; inference; edit (`"appended"`);
    retract with notice → `"noted"`; next request contains the original, no byte of the
    edit, and the notice.
30. **Consumed, pure withdrawal.** Create; inference; retract with empty content →
    `"consumed"`; nothing appended.
31. **Restart before deletion.** Create; inference or not; host restarts without durable
    history; retract with notice → `"noted"` (history `unknown`).
32. **Unknown subject.** Retract with notice for a key never seen → `"noted"`.
33. **Pure withdrawal in channel scope.** Retract on a channel-scoped subject with empty
    content and history `some` → `"consumed"`; nothing appended. (RFC-006 revision 6 rejected this
    with `-32602`.) Earlier consumed content remains unchanged; this operation makes no
    claim that the model learned the subject disappeared.
34. **History persists past slot.** Create; inference; retract (`"noted"`); new create
    under the same K; retract → `"noted"` (bit is `some`, not reset by the empty slot).
34a. **Initial after loss of history.** A host using `initial` has evicted history or
    restarted without it; create with `initial: true` under a fresh key; edit; retract with
    notice → `"retracted"`; the next request contains nothing from K. Without `initial`
    or independent complete history, the same sequence → `"noted"`.
34b. **Initial cannot lower history.** Create; inference; a second occurrence with
    `initial: true` under the same K; retract with notice → `"noted"`.
34c. **Capacity degrades, never refuses.** With the host at its subject limit, a new
    channel-scoped create → `accepted: true`, `"appended"`; the content reaches the next
    request. A retract for an untracked subject with notice at the limit → `"noted"`,
    notice delivered. A deferred occurrence at the limit → `"appended"`, fallback delivered
    without rendering. These outcomes assume ordinary admission would accept the event.

Both:
35. **Idempotent retry.** Same `eventId` twice → one effect; equal results.
36. **No starvation.** With delivery available and wake eligibility maintained,
    replacements arrive faster than the host's quiet period → the subject's current content
    reaches a request within the host's stated bound. A subject deliberately matching
    `skip` is not forced to wake by this vector.
37. **Audit** (illustrative; host policy). After vectors 2, 16, 23 and 29 a host that keeps
    an audit record shows E1; N1–N3 with rendered and fallback content; the discarded late
    result; and the removed edit — each marked displaced/folded/discarded.
38. **Malformed, per lane.** 257-byte key on `push/event` → `-32602`. In a
    `channels/incoming` batch of three where the second has `deferred: true` → results
    `[accepted, {accepted:false, reason:"coalesce_invalid"}, accepted]`.

Recovery:
39. **Reconnect retry.** E1 accepted; receipt lost; transport reconnects and policy completes;
    retry E1 within the retry window → original receipt; the next request contains E1's
    content exactly once.
40. **Nothing accepted is lost.** E1 accepted; transport drops, or the host restarts, before
    any inference; the producer returns → the next request contains E1's content (as the
    pending occupant or as an ordinary occurrence — either conforms). E2 for the same
    subject after recovery but before the next assembly has two conforming outcomes:
    if E1 remains replaceable, `"replaced"` and only E2 reaches the request; if recovery
    sealed E1 as an ordinary occurrence, `"appended"` and E1 then E2 both reach it. Neither
    outcome duplicates an occurrence. Revocation and later sender retraction/replacement
    still apply; the preservation guarantee does not override them.
41. **Ordinary traffic unaffected by reconnect.** A registered channel; transport drops and
    reconnects; a `channels/incoming` message without `coalesce` → accepted exactly as it
    would have been under §14 before RFC-006. This section adds no registration step.
42. **Binding reassignment.** Reuse a configured label for another endpoint/principal;
    its events cannot replace, retract, or deduplicate the old binding's occurrences.
43. **Current wake treatment.** Under a policy where `skip` is non-qualifying, replace
    the sole cause of an unstarted inference with a `skip` occurrence (or retract it
    unread) → no inference starts solely for the displaced cause. Another eligible cause
    may still start one. Reverse the transition → normal qualifying wake treatment.
44. **Unrelated debounce.** A coalesced subject reaches its postponement bound while an
    unrelated ordinary event is awaiting its configured quiet period → coalescing does
    not shorten or extend the ordinary event's deadline. Timer layout is unrestricted.
45. **Stable reply target across lanes.** Create M via `channels/incoming`; edit via a
    channel-scoped push without a new platform message identity → M remains the reply
    target, regardless of whether the create was already consumed.
46. **Per-context replacement** (only for hosts that track contexts separately). E1
    delivered to contexts A and B; A consumes it; E2 → A holds E1 then E2, B holds E2 only;
    `outcome` is `"appended"`.

47. **Host-restart retry.** E1 accepted, reply lost; host restarts; current policy restored;
    retry E1 within the advertised window → original receipt, no second occurrence.
48. **Window changes.** E1 admitted and acknowledged under a two-hour advertised window;
    reconnect advertises one hour; retry E1 after 90 minutes → still deduplicated. A producer
    uncertain which session admitted E1 uses the shorter advertised window and stops its retries earlier.
49. **Shared render baseline.** Deferred R1 is materialized for contexts A and B; A consumes
    R1, B has not. R2 is rendered relative to R1 → B retains R1 before R2. Optional
    per-context replacement cannot discard R1 from B and strand R2 without its baseline.

RFC-006 revision 6's wake vectors are retained as behavioral checks 43–44; no vector requires a
particular scheduler data structure. Audit vector 37 remains illustrative under host policy.


### 20.15 Decisions (formerly open questions)

1. **`channels/incoming` stays in this section.** Plain mode and retraction are identical
   across lanes, and the mixed-delivery cases (§20.9.2) are the point; splitting would leave
   chat servers with half a mechanism. Hosts that cannot replace inside a batched user turn
   advertise `channelsIncoming: false`.
2. **Positioning is the host's, above the consumed boundary.** RFC-006 revisions 2–6 recommended
   the tail because a gauge's content is true as of its own timestamp. For a chat message
   the same rule moves an edited message after its replies. Both placements keep the
   consumed prefix intact, which is the only property a server or a model can rely on, so
   this section states that constraint and no preference (§20.4.1).
2a. **This section specifies outcomes, not host mechanisms.** Accepted work survives interruption
   through replacement, withdrawal, ordinary delivery, or authority-based rejection.
   Retrying within the advertised window does not duplicate an occurrence, including across
   restart. Wake eligibility and unrelated delivery timing remain observable guarantees;
   timer layout does not. This section requires no particular journal, index, snapshot, or
   retention architecture. Audit follows host policy. The journal implementation described in
   RFC-006 §15 remains one way to provide these guarantees.
3. **Consumption is permanent.** No un-consume after a traceless request; with deferred
   mode the materialized occurrence is history either way, and refusal-rewind's marker is
   an ordinary event.
4. **Render cursor is deferred, not adopted.** The at-most-once gap (§20.5.3) is accepted for
   source-backed servers. If a server needs exactly-once coverage, a follow-up may add an
   opaque `cursor` echoed by the host on the next render of that subject.
5. **Malformed requests are errors.** `-32602` on `push/event`; per-message
   `coalesce_invalid` on `channels/incoming`, because that lane already defines partial
   acceptance and a whole-batch error would discard valid siblings.

---

## 21. Tool Presence, Toolsets and Surfaces

> **Status within the draft.** Merged from RFC-014 revision 6 (Draft); this section carries
> Draft strength within the 0.5.0-draft. §21.1–§21.13 carry RFC-014 §1–§13 under the same
> numbers, without RFC-014 §8.6 (surface hosts outside the main host, which obtain credentials
> through the draft RFC-015) and without §10's item on those surface hosts. RFC-014 §14
> (open questions) and §15 (implementation status) stay in the RFC. By RFC-014 §13's heading,
> its vectors (§21.13) are to be frozen before acceptance.

### 21.1 Summary

A model's tool list holds two different kinds of tool that today share one place:

- **Stable tools** — the server's core, useful at any time: look, say, search, status. These
  belong in the request's tool list, which renders first and is cached; they should change
  as rarely as possible.
- **Contextual tools** — useful only in some state or while doing something: `play` on your
  turn, `fire` in a game but not its menu, a world's builder tools while building, the
  options of the decision in front of you. These change constantly, and every change to a
  request's tool list rebuilds the whole cache.

Servers cannot pick a presentation, because the right one depends on the host and the model.
They can say what kind of tool each one is:

```jsonc
{ "name": "place_block", "description": "…", "inputSchema": { … },
  "_meta": { "mcpl/presence": "dynamic", "mcpl/toolset": "builder", "mcpl/visible": false } }
```

…and agree with the host on which toolsets are open. The host decides what goes in the tool
list (static tools), what reaches the conversation as events (dynamic tools appearing and
disappearing), and when to remind the model of what is open.

A host that ignores all of it sees the server's full tool list, as today.

### 21.2 Motivation

**Tool bloat.** One world server lists about 50 tools, its builder tools among them whether or
not the agent is building. One agent's host lists about 300. The activity servers in one
deployment list 7–8k tokens of definitions all the time; none narrows by state.

**Changing the list is the most expensive edit.** Tools render first. Adding, removing or
re-describing one rebuilds the prompt cache for tools, system prompt and conversation, and on
models with preserved thinking invalidates earlier thinking. So a server that narrows its
list by state (MCP allows it, via `tools/list_changed`) makes every mode change a full rebuild.
The conversation, by contrast, only grows: content appended to it costs nothing already
cached.

**The server knows the state; the host knows the context.** The server knows a tool is
meaningless right now (it is not your turn; there is no mesh to rig). Only the host knows what
the model has already been told, what has been compressed away, and what its model's API can
do mid-conversation. The split of responsibilities follows.

#### Design principles

1. **The tool list is the server's whole truth.** `tools/list` keeps every definition.
   Hints say how to treat them; nothing is hidden from a host that asks.
2. **Hints, not presentation.** A server says *static or dynamic*, *visible or not*, *which
   toolset*. It does not say how a model should see them or how often an agent will use them —
   it cannot know.
3. **Session awareness is optional and useful.** A server may track which toolsets a session
   has open, which removes guesswork on both sides; a server that declares nothing works as
   today.
4. **Append, don't edit.** What changes mid-session reaches the model as appended content,
   unless the host has an append-only way to change its tools.
5. **No new authority.** Hints confer nothing. A hidden tool is not a revoked tool.

### 21.3 Concepts

| Term | Meaning |
|---|---|
| **static tool** | Belongs in a model's stable tool list. Changes rarely (a deploy, not a state). The default. |
| **dynamic tool** | Comes and goes with state or engagement. Hosts present it outside the stable list unless they can change their tools append-only. |
| **visible** | The server's statement that a tool is available right now. Applies to dynamic tools; a static tool is always visible. |
| **toolset** | A named group of dynamic tools that is open or closed for a session: `builder`, `game`, `table`. |
| **instance** | A named, separately opened copy of a toolset with its own state: two games of Go at once. Only for toolsets that declare `instances: true`. |
| **header** | The host's stable tool list for a model request. |
| **surface mode** | A host presentation in which a whole server is engaged on demand: nothing of it in the header; connected when opened; everything through events. |
| **mixed mode** | The default presentation: static tools in the header, dynamic tools through events. |

### 21.4 Tool hints

#### 21.4.1 The hints

Carried in a tool definition's `_meta` (in `tools/list`) and in hint changes (§21.6):

| Key | Type | Default | Meaning |
|---|---|---|---|
| `mcpl/presence` | `"static"` \| `"dynamic"` | `"static"` | Which list the tool belongs in |
| `mcpl/visible` | `boolean` | `true` | Available right now (meaningful for dynamic tools) |
| `mcpl/toolset` | `string` | — | The toolset it belongs to. Implies `presence: "dynamic"`, and wins over an explicit `presence: "static"`, which hosts ignore on such a tool. The toolset need not be declared (§21.5.4) |

Rules:

- A tool whose availability depends on state or engagement **SHOULD** be dynamic. A static tool
  **SHOULD NOT** change its definition except across deploys, and **SHOULD NOT** become
  invisible; a static tool that cannot run right now answers its call with an error.
- A tool in a toolset is visible only while that toolset (or instance) is open **and** the
  server says it is visible. Two controllers, one rule.
- To a host that advertised `toolHints`, `tools/list` **MUST** list every tool, visible or not.
  (To a host that did not, a server may tailor its list: §21.6.3, §11.) Calling an invisible tool — or a tool of a declared toolset that is not
  open — returns an ordinary tool error that says why. (For an undeclared toolset the server
  does not know what is open; the host gates those calls, §21.5.4.)
- In `tools/list`, `mcpl/visible` on a toolset's tool means "visible in at least one open
  instance"; per-instance visibility travels in hint changes (§21.6). The list carries the
  declared definitions and each tool's current presence, and its result carries
  `_meta["mcpl/rev"]`: the last `rev` this connection had sent when the list was written (the
  list itself takes none). **A host's per-instance state comes from `toolsets/list`** (§21.5.3).
- **For a host that did not advertise `toolHints`, every toolset without instances is
  implicitly open** and the server behaves as it would without this section. A toolset with
  instances has no implicit instance; nor does one that cannot sensibly be open without options
  (a game needs its settings). For those the server offers that host plain tools to open,
  choose and close instances (§21.11), or leaves them out.
- Tool names are unique across a server, static and toolset tools alike: instances share
  their toolset's **declared** definitions, so a name identifies one declared definition. A hint
  may give one instance its own current definition (§21.6.1).
- Hints are statements, like `annotations` (§13.6.4). They confer and remove no authority.

#### 21.4.2 Moving between static and dynamic

Moves are rare and are announced like any hint change (§21.6). A host **MAY** apply a move
at a time of its choosing — at once if its model API can change tools append-only, otherwise
at a natural boundary such as compaction or a new session. Until it applies the move, the
tool keeps working where it is. When it applies it, the host **SHOULD** tell the model where
the tool went (§21.8.3).

### 21.5 Toolsets and instances

#### 21.5.1 Declaration

In the manifest (§17), so changes are announced by `mcpl/manifestChanged`. `toolHints`,
`toolsets` and `surface` form their own manifest domain, **`toolsets`** (listed in §17.1). A change in it carries no grant consequence: its impact is §17.6's
`surface-changed`, disposition `applied`; the host emits its receipt as for any change (§17.5),
re-reads the declarations and refreshes its catalog. (The server-level `surface` member is
unrelated to the impact's name.)

A change that removes a toolset, turns its `instances` off, or leaves it undeclared ends its open
instances: the server closes them with or before the change, reporting them as closed in hint
changes and in `ended` (§21.5.3). A toolset that becomes undeclared starts closed under the
host's gating (§21.5.4). A server that withdraws `toolHints` is treated as hint-less from then
on: every tool static, its dynamic presentation withdrawn.

```jsonc
"experimental": { "mcpl": { "version": "0.5", …,
  "toolHints": true,
  "toolsets": {
    "builder": { "title": "Building", "summary": "Place, paint and remove blocks in a world you may edit",
                 "default": "closed" },
    "game":    { "title": "Go", "summary": "A game of Go against the bot or another agent",
                 "default": "closed", "instances": true,
                 "options": { "type": "object", "properties": { "size": { "enum": [9, 13, 19] } } } }
  },
  "surface": { "title": "Arcade", "summary": "Games" } } }
```

| Field | Meaning |
|---|---|
| (name) | The key: matches `^[a-z][a-z0-9_-]{0,31}$`, unique on the server |
| `title`, `summary` | For the host's catalog and reminders |
| `default` | `"open"`: the server treats the toolset as open from the start of a session — it appears in `toolsets/list` without the host opening it. `"closed"`: the host opens it. A toolset with `instances` is always `"closed"` |
| `instances` | `true`: the toolset may be opened more than once, each a named instance |
| `options` | JSON Schema for `toolsets/open` options |

`surface` is a server-level hint: everything this server offers is engagement, so a host may
present it in surface mode, connecting only when it is opened.

#### 21.5.2 `toolsets/open` and `toolsets/close` (Host → Server, Request)

```jsonc
{ "method": "toolsets/open",  "params": { "toolset": "game", "instance": "vs-ada", "options": { "size": 9 } } }
→ { "toolset": "game", "instance": "vs-ada", "title": "Go 9×9 vs Ada",
    "content": [ { "type": "text", "text": "    A B C D E F G H J\n 9  . . . …" } ] }

{ "method": "toolsets/close", "params": { "toolset": "game", "instance": "vs-ada" } }
→ { "content": [ { "type": "text", "text": "You left a live game: that is a forfeit." } ] }
```

- `instance` is a name the host proposes (the agent's or its own), or omits to let the server
  choose one. Instance names match `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`: hosts propose only such
  names, servers choose only such names, and a server **MUST NOT** refuse a name for its form if
  it matches. A proposed name **MUST** be used as given, or the open refused (a name that does not
  match, a limit); the server **MUST NOT** substitute another, so that a retried open finds what
  the first one opened. For a toolset without `instances`, `instance` is absent.
- Opening what is already open — a toolset without instances, or an instance by a name that is
  open — **adopts** it: the result describes the existing one, changes nothing, and carries
  `adopted: true`. If the request's `options` were not applied, the result **MUST** say so in
  its `content`. This makes a retried open safe **when it names its instance**; it is not a
  reconnect strategy (below). An open without a name is not idempotent — each creates an
  instance — so a host that may retry an open (after a timeout or a reconnect) **SHOULD**
  propose a name.
- The server **MAY** refuse an open (unknown toolset, a limit, bad options) with a JSON-RPC
  error; the host shows the refusal.
- Opening and closing are the host's acts. The **agent** asks through the host's tools; the
  **host** may open or close by its own policy (close a toolset idle for many turns); the
  **server** may only suggest (§21.6.2). A close takes effect for every connection of the
  principal (§21.5.6) — closing a live game forfeits it for all of them — so a host **SHOULD**
  close by policy only instances it opened itself, and **SHOULD NOT** close by policy one with
  recent activity it did not cause.
- Open toolsets belong to the **principal** (§21.5.6). On reconnect the host asks the server
  what is open (`toolsets/list`, §21.5.3) and takes that as the truth: it adopts what the
  server reports and treats anything else it believed open as closed. It does **not** re-open
  on its own — opening can have effects (starting a new game) and is the agent's or the host's
  deliberate act, not reconciliation.
- The result of a close **MAY** carry `content` — what closing meant (a forfeit, a game kept on
  the server) — and carries the hint changes it caused in `_meta["mcpl/hints"]`, like an
  open.
- The result of an open carries the hint changes the open caused (`_meta["mcpl/hints"]`):
  which of the toolset's tools are visible now. It **MAY** carry `content` (content blocks, as
  in a tool result): what the agent sees on opening — the board, the surroundings, the
  decision in front of it. Later state arrives as event content, and a toolset that wants
  "look again" offers an ordinary tool for it. There is no separate view mechanism.

#### 21.5.3 `toolsets/list` (Host → Server, Request)

```jsonc
{ "method": "toolsets/list", "params": {} }
→ { "open": [ { "toolset": "game", "instance": "vs-ada", "title": "Go 9×9 vs Ada" } ],
    "_meta": { "mcpl/hints": { "rev": 41, "tools": [ { "name": "play", "instance": "vs-ada", "visible": true } ] } } }
```

What the principal has open on the server, and the hint state of its dynamic tools as of the
result's `rev`, in full: every tool visible in each open instance, and every visible dynamic
tool outside declared toolsets — **a dynamic tool not stated visible is invisible** — with every
current definition that differs from the declared one. A host replaces its dynamic-tool state
with it. The result **always** carries `_meta["mcpl/hints"]` and takes a `rev` — with an empty
`tools` when nothing is visible — so that an empty statement still clears what a host believed. Every server that advertised `toolHints` answers `toolsets/list`, with an empty `open`
if it declares no toolsets.

It also carries `ended`, so a host can tell "never had one" from "it ended while you were
away": every toolset instance that ended other than by a `toolsets/close` (game over, idle,
an error, a manifest change), whichever connections of the principal were online. Each record
has an `id`, unique for the principal and never reused. A server reports a record
on every `toolsets/list` until it expires (a bounded time; the reference SDK: an hour); a host
tells its agent about each `id` once, however often it reconnects in that time:

```jsonc
→ { "open": [ … ], "ended": [ { "id": "e7", "toolset": "game", "reason": "idle for 30 minutes" } ] }
```

A server that keeps toolsets across connections reports them after a reconnect; one that does
not ends a principal's instances when its last connection closes, and reports them in `ended`.
Hosts send it after every (re)connect to a
server that advertised `toolHints`, and tell the agent about each `ended` record once.

#### 21.5.4 Undeclared toolsets

A server may tag tools with `mcpl/toolset` without declaring that toolset. It then offers a
grouping, nothing more: the host opens and closes the group on its own (as with host-made
toolsets, §21.8.5), sends no `toolsets/open` or `toolsets/close` for it, and the server does
not track it. **The host gates calls into such a group**: it does not send a call for a tool of
a group it has closed; the server applies only its own `visible` hint. A tool in an undeclared toolset is visible while the host has the group open
and the server's `visible` hint is true. Declaring the toolset is what makes the server
session-aware of it, and is needed for instances and options.

#### 21.5.5 Calling an instance's tools

Every instance of a toolset shares the same declared tool definitions; the instance a call is
for rides in the call's `_meta`:

```jsonc
{ "method": "tools/call", "params": { "name": "play", "arguments": { "point": "D4" },
                                      "_meta": { "mcpl/instance": "vs-ada" } } }
```

A call to an instance-bound tool without `mcpl/instance`, while more than one instance is
open, is an ordinary tool error naming the open instances.

#### 21.5.6 One principal, several connections

The **principal** of a connection is the identity the host acts as on it, as RFC-015 §4.4
defines it: one per connection, chosen by the host's policy (§18.8 keeps identity models out
of scope). A server that cannot tell principals apart treats each connection as its own.
Toolsets belong to the principal, not to a connection: a second connection of the same
principal sees the same open toolsets (through `toolsets/list`, then hint changes). An open,
close or visibility change made through one connection reaches the others as ordinary hint
changes on their own `rev` counters — including `toolsets` state changes — not as
suggestions.

### 21.6 Hint changes

#### 21.6.1 The change object

```ts
interface HintChanges {
  rev: number;                   // per connection: 1, 2, 3 … — consecutive
  tools?: Array<{
    name: string;
    instance?: string;           // required for a toolset with instances: visibility is per instance
    presence?: "static" | "dynamic";
    visible?: boolean;
    definition?: Tool;           // dynamic tools only: the current definition (new enum options);
                                 // with `instance`, that instance's own
  }>;
  toolsets?: Array<{
    toolset: string;
    instance?: string;
    state: "open" | "closed";    // opened, closed (game over), confirmed, or — with a new
    title?: string;              // title — retitled ("freedoom2 MAP02, skill 5")
  }>;
  suggest?: Array<{              // §21.6.2
    toolset: string;
    instance?: string;
    action: "open" | "close";
    reason: string;
  }>;
}
```

It travels three ways, sharing one `rev` counter:

1. **In a result**, `_meta["mcpl/hints"]` — of a `tools/call` (what the call caused), or of a
   `toolsets/open`, `toolsets/close` or `toolsets/list` (what the open or close caused; the
   full statement of §21.5.3).
2. **On a push event**, params member `hints` — for a change the event explains ("White
   played E5", and `play` becomes visible).
3. **Standalone**, as `tools/hints` (Server → Host, Notification) — for a change with nothing
   to say.

**Order.** Every message that carries hint changes takes the next `rev`; a message without
any takes none. A server **MUST** number them consecutively on a connection — the first is
`rev` 1, each next one more — whichever way each travels, results of every kind included, and
**MUST** write them in that order (allocate the `rev` and write the message in one step). A
`tools/list` result carries no changes; its `mcpl/rev` names the last `rev` taken.

**Applying.** A host applies hint changes **in `rev` order, as soon as it has each one**,
whatever it then does with the message that carried it: it applies the `hints` of a push it
refuses or has not yet decided on, and the `_meta["mcpl/hints"]` of a result it no longer waits
for (a timed-out call). On stdio and WebSocket, which deliver in order, `rev` order is arrival
order. On MCP's Streamable HTTP a result and a notification can travel on different streams, so a
change can arrive before a lower `rev`: the host holds it until the missing ones arrive, for a
bounded time (5 s recommended), and then recovers. Accepting an event is a decision about the event, not about the
server's state; a server never restates anything because a push was refused. Entries state
values (`visible: true`, a definition), not differences.

A push carrying hints is **never retried** (§9.4): its `rev` is spent when it is written. A host
that receives one whose `eventId` it has already seen ignores its hints. A call that will get no
result — cancelled under MCP, which then sends none — sends the changes it caused as
`tools/hints` instead.

A `tools/list` result states presence and declared definitions as of the `rev` it carries, and
applies right after that `rev`; a `toolsets/list` result's hints are a statement under their own
`rev`, applied in order like any other.

**Recovering.** A host missing a `rev` it can no longer expect — it dropped a message unread, its
bounded wait passed, or a bug — re-reads `tools/list`, then `toolsets/list` (so every tool the
statement names is already known), and goes on applying in `rev` order from there. Each result states the server's state at the `rev` it names, so the two
reads need no common baseline. A new connection starts from `toolsets/list` (§21.5.3).

**Definitions.** `definition` lets a dynamic tool's options change without a `tools/list` round
trip. A host takes only its `description`, `inputSchema` and `annotations`, and **MUST** ignore
every other member — `name`, and all of `_meta`, including `mcpl/class`, `mcpl/presence`,
`mcpl/toolset` and `mcpl/visible`. The entry's own fields carry presence and visibility; class
and toolset membership change only through `tools/list`. With `instance`, the definition is that
instance's own current one (the legal moves of one game), and the host checks arguments for that
instance against it; without, it is the toolset's (for a toolset without instances, its only
instance's). A definition equal to the declared one returns the tool to it. A host applies its
tool policy to a definition received this way exactly as to a listed one. A `tools/list` result
replaces declared definitions only: a current definition from hints stays in force until hints
change it or a `toolsets/list` restates it. A static tool's definition changes only through
`tools/list_changed`.

Hint changes need no capability to be applied: they describe the server's own tools, and
`tools/hints` needs no grant. Delivering anything they cause into a model's context follows the
host's usual rules for events (a host that has not granted `pushEvents` still tracks
visibility, and shows it in results and `look`).
A host **MUST** ignore hint `_meta` and `tools/hints` from a server that did not advertise
`toolHints`.

#### 21.6.2 Who reports what

- **A call reports its own consequences.** What a `tools/call` causes — tools appearing or
  disappearing, a toolset closing, a reply it provoked — rides in its result. The server
  **MUST NOT** also push it.
- **Something else's consequences are pushed**, with the explaining event when there is one —
  or, when the server cannot push on that connection (no `pushEvents` grant, the events feature
  set disabled), sent as `tools/hints`.
  "Something else" includes another principal acting in a shared instance — an opponent's move
  reaches you as a push carrying your visibility change.
  An event from a background source that lands while a call is running is pushed, not folded
  into that call's result. A server that finds changes by comparing state before and after a
  call may occasionally attribute a concurrent background change to the call; that is
  acceptable — the host still learns the change, once.
- **Suggestions** (`suggest`) are the server's way to ask for an open or close: an opponent
  challenges you, a world zone invites building, a game ended. The host decides; a suggestion
  confers nothing, and hosts **SHOULD** let the agent see a suggestion to open rather than act
  on it silently.

#### 21.6.3 Advertisement

Server: `experimental.mcpl.toolHints: true` (it sends hints) and `toolsets` (it declares
toolsets). Host: `experimental.mcpl.toolHints: true`. A server **MUST NOT** send `tools/hints`
or the `hints` push member to a host that did not advertise `toolHints`. It **MAY** tailor
everything else to the host as well — omit the toolset declarations, hint `_meta` and any
hints-only tools, and add the tools of §21.11 — so that a host without `toolHints` sees what
it saw before RFC-014. This is the one exception to §21.4.1's list-every-tool rule.

### 21.7 Events

Activity in a toolset reaches the agent as ordinary `push/event`s (§9). For routing:

- Push params carry `toolset` and `instance` when the event belongs to one; the host uses
  them to place the event and to apply the `hints` member.
- The `surface:` tag namespace (reserved by this section, alongside `chat:` and `mcpl:`):
  `surface:turn` (waiting on you), `surface:alert` (needs attention now), `surface:done` (a
  game or job finished), `surface:invite` (an open is suggested), `surface:update` (ambient,
  latest-value). Hosts decide treatment; tags are never authority (§16.6).
- Latest-value state (progress, pose, health) uses plain coalescing (§20.4) with a key per
  instance. Activity uses deferred coalescing (§20.5) where the host supports it, so a burst
  arrives as one message describing the present.
- **A push carrying `hints` MUST NOT use coalescing (§20)** (neither plain nor deferred): a
  replaced or batched occurrence would make it undefined when, or whether, its changes apply.
  A server whose explaining event would be coalesced sends the changes standalone instead.

When a toolset closes, its events stop.

**A principal with no connection that can take events** (offline while an opponent moves): the
server **MAY** hold its events, bounded, and deliver them after that principal's next
`toolsets/list` — without `hints`, since the list states the state. Toolsets that ended in the
meantime are reported in `ended` (§21.5.3) either way.

### 21.8 Host presentation

This section is guidance, except where it says MUST.

#### 21.8.1 What goes where

| Presentation | Static tools | Dynamic tools |
|---|---|---|
| **plain** (no hint support) | header | header (the full list; today's behaviour) |
| **mixed** (default) | header | announced in the conversation as they become visible and invisible; called through a host meta-tool, or projected (§21.8.4) |
| **surface** (server hinted `surface`) | none | everything through events and meta-tools; the host may connect only when the agent opens it, and disconnect when the last toolset closes |

#### 21.8.2 Meta-tools

A host presenting dynamic tools exposes a small, constant set of its own, for example:

```
open  {toolset | server, instance?, options?}     look  {server?, toolset?, instance?, tool?}
act   {server?, tool, instance?, args}              close {toolset | server, instance?}
```

They are the host's interface, aggregated across every connection and named by the host; where
a tool or toolset name occurs on more than one server, `server` says which.
They are static.

#### 21.8.3 Announcing changes

- When dynamic tools become visible, the host announces them in the conversation as compact
  signatures, with each tool's first sentence the first time its definition appears. When they
  become invisible, it says so. The API tool list does not change.
- When a tool moves static → dynamic, it leaves the header (§21.4.2) and the host shows where
  it went; dynamic → static is the reverse.
- **Reminders.** When the announcement of an open toolset has left the context — compressed,
  or out of the window — the host **SHOULD** publish a reminder: what is open, its current
  tools, and how to close it. Only the host knows what the context still holds; the server
  need not repeat itself.

#### 21.8.4 Projection

A host whose model API can add and remove tools append-only (for example, mid-conversation tool
changes on the Claude API) **MAY** present visible dynamic tools as real tools for as long as
they are visible. It **MUST** give them host-namespaced names that cannot collide with any
other tool, **MUST** route each call only to its server (with `mcpl/instance` set), and
**MUST** withdraw them when they become invisible or their toolset closes. Whether to project
is the host's decision, from its own policy and what it observes of the agent's use; the
server is not asked.

#### 21.8.5 Host-made toolsets

A host **MAY** group the tools of servers that declare nothing — by operator configuration, by
class (§13.6), by name — and present them as toolsets of its own (open, close, reminders),
without involving the server. That is how a host with hundreds of tools from many servers
keeps its header small. Server-declared toolsets and host-made ones coexist.

### 21.9 Use cases

| Server | Static | Toolsets (dynamic) | Visibility by state |
|---|---|---|---|
| Eidoverse | look, say, move, who | `builder` (closed), `inventory`, `conjure` | builder tools visible only where the agent may build |
| Go | — (`surface`) | `game` (instances; options size, opponent) | `play`/`pass` on your turn; `mark_dead`/`accept` in scoring |
| CANON | search_cards, card, rules, decks | `table` | the decision tools, with enums of the legal options, while a decision is yours |
| Doom | — (`surface`) | `game` | start and results in the lobby; move and attack while playing; restart when dead |
| Robot dog | status | `body` | move and turn when standing; `stop` whenever reachable |
| Orrery | projects | `node` | the ops valid after the selected node's kind |
| Atlas | search, stats | `explore` | `step` choices from the current place |

### 21.10 Security considerations

- **No authority.** Hints, toolset state and suggestions confer nothing. Hosts **MUST NOT**
  treat a hint as permission, and a hidden tool remains subject to every policy on tool calls.
- **Server-authored text mid-conversation.** Dynamic tool definitions reach the model inside
  the conversation, and so do toolset titles and retitles, `suggest` and `ended` reasons, and the
  `content` of open and close results. All of it is the server's words, at the trust tier of a
  tool description or tool result; hosts attribute it to the server and never present it as
  their own or the operator's.
- **Projection** (§21.8.4) must not let a server's tool shadow a host's or another server's.
- **Suggestions** to open are shown to the agent, not acted on silently, by default: a server
  should not be able to put tools in front of a model by asking.
- **Churn.** A server flipping visibility rapidly costs context. Hosts **MAY** rate-limit and
  debounce announcements; servers **SHOULD** debounce.

### 21.11 Backward compatibility

- A server that sends no hints is static throughout; nothing changes.
- A server with toolsets **MAY** offer a host that did not advertise `toolHints` plain static
  tools to open and close toolsets (the reference SDK names them `toolset_open` and
  `toolset_close`), and, for toolsets with instances, one to choose among open instances
  (`toolset_use {toolset, instance}`), so it remains usable there. The toolset's tools are in
  the list. Such a host sends no `mcpl/instance`, so its call goes to its connection's current
  instance of that toolset — the one it last opened or chose — or, if it has none, to the only
  open one; otherwise the call fails naming the open instances and the tool that chooses.
- A host that ignores hints sees every tool in `tools/list`, and calls to invisible tools fail
  with explanations.
- `toolsets/open` and `toolsets/close` are only sent to servers that declared toolsets.

### 21.12 Schema

```ts
// Tool._meta
//   "mcpl/presence"?: "static" | "dynamic"     (default "static")
//   "mcpl/visible"?:  boolean                  (default true)
//   "mcpl/toolset"?:  string                   (implies dynamic)
// tools/call params._meta
//   "mcpl/instance"?: string
// tools/call, toolsets/open, toolsets/close and toolsets/list result._meta
//   "mcpl/hints"?: HintChanges
// push/event params
//   hints?: HintChanges; toolset?: string; instance?: string
// Notification (Server → Host): "tools/hints", params: HintChanges
// Requests (Host → Server): "toolsets/open"  {toolset, instance?, options?} → {toolset, instance?, title?, content?, adopted?}
//                           "toolsets/close" {toolset, instance?} → {content?}
//                           "toolsets/list"  {} → {open: [{toolset, instance?, title?}], ended?: [{id, toolset, instance?, reason}]}  (+ _meta["mcpl/hints"]: a full statement)
// tools/list result._meta: "mcpl/rev": number
// Manifest: experimental.mcpl.toolsets: Record<string, ToolsetDecl>; experimental.mcpl.surface?: {title, summary}
// Advertisement: experimental.mcpl.toolHints: true (both sides)
interface ToolsetDecl {
  title: string; summary: string;
  default: "open" | "closed";    // "closed" whenever instances is true
  instances?: boolean;
  options?: JsonSchema;
}
// HintChanges.rev: consecutive per connection, from 1, across results, pushes and tools/hints
// HintChanges.tools[].definition: only description, inputSchema, annotations are taken (§21.6.1)
```

### 21.13 Conformance vectors (to freeze before acceptance)

1. A server with hints lists every tool in `tools/list`, visible or not.
2. A call that makes tools visible carries `mcpl/hints` in its result; no push follows for it.
3. A push explaining a visibility change carries it in `hints`; the host applies it on arrival,
   before and whatever it decides about the event.
4. Revs on a connection are consecutive across results, pushes and `tools/hints`; a host that
   sees one skipped recovers through `toolsets/list` and `tools/list`.
5. `toolsets/open` on a toolset with `instances` returns an instance name; calls carry it.
6. A call to an instance-bound tool with two instances open and no `mcpl/instance` fails,
   naming them.
7. A `definition` change to a dynamic tool reaches the host without `tools/list_changed`.
8. A server whose host did not advertise `toolHints` sends no `tools/hints`.
9. After a reconnect, `toolsets/list` reports an instance the server kept; the host adopts
   it rather than opening a second.
10. A tool tagged with an undeclared toolset: the host never sends `toolsets/open` for it,
    and the tool is visible only while the host has the group open.
11. A push carrying `hints` that the host refuses: its changes are applied, and the server
    restates nothing; the next change has the next `rev`.
12. A host that drops a result unread sees the next `rev` skip one, and recovers from
    `toolsets/list` and `tools/list`, including an instance's current definition.
13. A toolset that ended while no connection could be told appears in `ended` on every
    `toolsets/list` until it expires, with the same `id`; a host that reconnects twice tells its
    agent once.
14. An open on one connection reaches another connection of the same principal as `toolsets`
    state and visibility changes.
15. A presence move (static → dynamic) arrives as a hint change and the host moves the tool out
    of its stable list.
16. A close result carries the hint changes it caused.
17. An open proposing an instance name gets that name, or a refusal — never another name.
18. An open adopting an existing instance carries `adopted: true` and says which options were
    not applied.
19. A push carrying `hints` carries no `coalesce`.
20. A `definition` in hints with a different `mcpl/class` is applied with the listed class.
21. A `definition` whose `_meta` names another toolset or another presence changes neither.
22. A `definition` carried with `instance` applies to that instance only; another open instance
    keeps its own.
23. `toolsets/list` hints are a full statement: a tool the host had visible in an instance, and
    not stated visible there, is invisible afterwards.
24. A tool with both `mcpl/toolset` and `mcpl/presence: "static"` stays out of the header.
25. A `default: "open"` toolset appears in `toolsets/list` from the start; the host adopts it and
    sends no `toolsets/open`.
26. A host without `toolHints` that opened two instances plays each after choosing it with the
    server's choose tool (where offered); without a choice, a call fails naming them.
27. `toolsets/open`, `toolsets/close` and `toolsets/list` results that carry hints take the next
    `rev`; a `tools/list` result takes none.
28. The hints of a result that arrives after the host stopped waiting (a timeout) are applied.
29. A cancelled call that gets no result sends its changes as `tools/hints`.
30. A push carrying hints is not retried; a duplicate `eventId`'s hints are ignored.
31. A host that has not granted `pushEvents` receives another party's visibility change as
    `tools/hints`.
32. An instance that ended while another connection of the principal was online appears in
    `ended` for a connection that arrives later.
33. A manifest change removing a toolset closes its open instances, reported in hint changes and
    `ended`.
34. A server with `toolHints` and no declared toolsets answers `toolsets/list`, stating the
    visibility and current definitions of its dynamic tools.
35. A proposed instance name matching the grammar is not refused for its form; one that does not
    match is refused, never renamed.
36. A host without `toolHints` gets no `tools/hints`, no `hints` push member and no hint `_meta`;
    a toolset without instances is usable there without opening it, and any compat tools of RFC
    §11 are static.
37. Over Streamable HTTP, a change that arrives before a lower `rev` is held, then applied in
    order once the lower one arrives.
38. A `toolsets/list` with nothing visible carries `mcpl/hints` with an empty `tools`, and the
    host's previously visible dynamic tools become invisible.

---

## Appendix A: Error Codes

| Code | Message | Description |
|------|---------|-------------|
| `-32001` | Feature set not enabled | Message used a disabled feature set |
| `-32002` | Capability denied | Method requires a capability not in the effective grant (§5.4); `data: { capability }` |
| `-32003` | Unknown feature set | Message used undeclared feature set |
| `-32005` | Checkpoint not found | Rollback targeted a pruned or unknown checkpoint |
| `-32017` | Channel not permitted | Lacking capability to publish to or receive from channel |
| `-32023` | Unknown channel | Channel id doesn't exist or not registered |
| `-32024` | Channel open failed | Server could not open/connect the requested channel |

---

## Appendix B: Schema

### B.1 ContentBlock

```jsonc
{
  "oneOf": [
    {
      "type": "object",
      "required": ["type", "text"],
      "properties": {
        "type": { "const": "text" },
        "text": { "type": "string" }
      }
    },
    {
      "type": "object",
      "properties": {
        "type": { "const": "image" },
        "data": { "type": "string" },
        "mimeType": { "type": "string", "maxLength": 255 },
        "uri": { "type": "string", "maxLength": 4096 },
        "sizeBytes": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "digest": { "type": "string", "pattern": "^sha256:[A-Za-z0-9_-]{43}$" },
        "expiresAt": { "type": "string", "maxLength": 64 },
        "name": { "type": "string", "maxLength": 255 },
        "disposition": { "enum": ["never", "ref"] }
      },
      "oneOf": [
        { "required": ["type", "data", "mimeType"], "not": { "anyOf": [{ "required": ["uri"] }, { "required": ["disposition"] }] } },
        { "required": ["type", "uri"], "not": { "required": ["data"] } }
      ]
    },
    {
      "type": "object",
      "properties": {
        "type": { "const": "audio" },
        "data": { "type": "string" },
        "mimeType": { "type": "string", "maxLength": 255 },
        "uri": { "type": "string", "maxLength": 4096 },
        "sizeBytes": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "digest": { "type": "string", "pattern": "^sha256:[A-Za-z0-9_-]{43}$" },
        "expiresAt": { "type": "string", "maxLength": 64 },
        "name": { "type": "string", "maxLength": 255 },
        "disposition": { "enum": ["never", "ref"] }
      },
      "oneOf": [
        { "required": ["type", "data", "mimeType"], "not": { "anyOf": [{ "required": ["uri"] }, { "required": ["disposition"] }] } },
        { "required": ["type", "uri"], "not": { "required": ["data"] } }
      ]
    },
    {
      "type": "object",
      "required": ["type", "uri"],
      "properties": {
        "type": { "const": "resource" },
        "uri": { "type": "string", "maxLength": 4096 },
        "mimeType": { "type": "string", "maxLength": 255 },
        "sizeBytes": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "digest": { "type": "string", "pattern": "^sha256:[A-Za-z0-9_-]{43}$" },
        "expiresAt": { "type": "string", "maxLength": 64 },
        "name": { "type": "string", "maxLength": 255 },
        "disposition": { "enum": ["never", "ref"] }
      }
    }
  ]
}
```

The `sizeBytes`, `digest`, `expiresAt`, `name`, and `disposition` properties are the §19.3
reference fields. On `image` and `audio` they are meaningful only in `uri` form; the
existing `oneOf` still rejects a block carrying both `data` and `uri`, and the `data`
branch additionally rejects `disposition`. The maxima are emitter conformance bounds
(§19.8); a host applies the one invalid-field rule — reject the field, keep the block and
its `disposition` — rather than rejecting the block, except for an invalid `uri`. Unknown
additional properties are ignored.

### B.2 FeatureSet

```jsonc
{
  "type": "object",
  "required": ["description", "uses"],
  "properties": {
    "description": { "type": "string" },
    "uses": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": [
          "pushEvents",
          "tools",
          "modelInfo",
          "inferenceRequest",
          "inferenceRequest.streaming",
          "inferenceLifecycle",
          "contextHooks.beforeInference.observe",
          "contextHooks.beforeInference.inject.system",
          "contextHooks.beforeInference.inject.beforeUser",
          "contextHooks.beforeInference.inject.afterUser",
          "channels.register",
          "channels.lifecycle",
          "channels.publish",
          "channels.incoming",
          "channels.streaming",
          "channels.acknowledge",
          "channels.typing"
        ]
      }
    }
  }
}
```

### B.3 Manifest (§17)

```jsonc
{
  "type": "object",
  "required": ["version"],
  "properties": {
    "version": { "type": "string" },
    "revision": {
      "type": "string",
      "pattern": "^sha256:[A-Za-z0-9_-]{43}$",
      "description": "Canonical content digest, §17.2. Omitted by servers that do not support §17."
    }
    // …capability members and featureSets, per §5.1
    // toolHints, toolsets and surface, per §21.5.1 and §21.12 (Draft strength)
  }
}
```

`mcpl/manifestChanged` params:

```jsonc
{
  "type": "object",
  "required": ["revision", "domains"],
  "properties": {
    "revision": { "type": "string", "pattern": "^sha256:[A-Za-z0-9_-]{43}$" },
    "domains": {
      "type": "array",
      "minItems": 1,
      "items": { "enum": ["capabilities", "featureSets", "tagOntology", "toolsets"] }   // toolsets: §21.5.1, Draft strength
    }
  },
  "additionalProperties": false   // §17.3: the notification carries no payload
}
```

`mcpl/manifest` takes no params and returns the manifest object above.

### B.4 Enums

**Position:** `"system" | "beforeUser" | "afterUser"`

**FinishReason:** `"end_turn" | "max_tokens" | "stop_sequence"`

**ChangeDomain:** `"capabilities" | "featureSets" | "tagOntology" | "toolsets"` (`toolsets`: §21.5.1, Draft strength)

**ChangeImpact:** `"capability-revoked" | "capability-expansion-pending" | "feature-degraded" | "feature-restored" | "ontology-acceptance-invalidated" | "ontology-reference-undeclared" | "surface-changed"`

**Disposition** (change-receipt impact, §17.6)**:** `"applied" | "decision-needed" | "informational"`

**ContentDisposition** (reference block `disposition`, §19.3.1)**:** `"never" | "ref"`

**LifecyclePhase** (`inference/lifecycle`, §10.5)**:** `"started" | "completed" | "aborted" | "failed"`

**Fallback** (degradation receipt, §6.7)**:** `"mcp-only" | "close"`

**ToolClass** (`mcpl/class`, §13.6.2, Draft strength)**:** `"comms" | "memory" | "notes" | "files" | "shell" |
"web" | "computer" | "media" | "body" | "control"`

### B.5 Event coalescing (§20)

The coalescing types, `push/render`'s params and result, and the members coalescing adds to
`push/event`, `channels/incoming` and the host's advertisement are defined in §20.13.

### B.6 Tool hints and toolsets (§21)

The hint, toolset and change types, the `_meta` keys on MCP tools, `tools/list` and
`tools/call`, and the manifest and advertisement members are defined in §21.12.

---

## Changelog

### Draft RFCs merged (October 2026), within 0.5.0-draft

The draft RFCs below are merged as sections of this draft, each at Draft strength as its
status note says. Each section carries its RFC's text, and the edits made in moving it are
listed here. Their BCP 14 keywords stay inside those sections. Where another section mentions
what they add, it describes and points, with no keyword of its own. Where the mention changes a
rule there, or adds to a list a rule closes (the reserved tag namespaces, the manifest's
domains, an enum), it names Draft strength, so no draft text takes on the strength of a section
that mentions it. The indexes (the abstract, the table of contents and §4.1's method table) add
their entries with the section and nothing more.

- **§13.6 Tool Classes, from RFC-008 revision 2.** Adds the `mcpl/class` slot on MCP tool
  definitions, the reservation of the `mcpl/` `_meta` prefix for keys this specification
  defines, and the vocabulary of ten classes, also listed in Appendix B.4 as `ToolClass`.
  RFC-008 §9 names its §3, §5, §6 and §7 for this section. §13.6.2 also carries RFC-008 §4,
  the vocabulary's meanings and decided edges, which §3 cites and without which B.4 would list
  names with no meanings. The section opens with RFC-008 §1, its summary, and RFC-008 §5.1–§5.3
  become labelled paragraphs of §13.6.3. "This RFC" reads "this section", and RFC section
  references are renumbered.
- **§20 Event Coalescing, from RFC-006 revision 8.** Adds the `coalesce` member of `push/event`
  and `channels/incoming` messages, `eventId` on `channels/incoming` messages, the
  `push/render` request, the results' `coalesce` member and the host's `eventCoalescing`
  advertisement. §20.1–§20.14 carry RFC-006 §1–§14 under the same numbers, and §20.15 carries
  its §16. Its §15 (implementation notes) and its revision notes stay in the RFC. RFC-006
  writes "§" for its own sections and this specification's alike: each of its 95 references
  was read as one or the other, and its own are renumbered into §20. "This RFC" reads "this
  section", or "RFC-006" where it names a time before it; "revision N" reads "RFC-006 revision
  N"; "SPEC §x" reads "§x" (three); "the base specification" reads "the rest of this
  specification"; "(principle 4)" reads
  "(§20.2, principle 4)"; §20.13's heading drops "(amends Appendix A, Appendix B)", as §19.8's
  did for RFC-005; and a decision that named "our journal implementation" names the one
  RFC-006 §15 describes. Mentioned in §4.1, §5.2, §9.2, §9.3, §9.4, §14.3 and Appendix B.5.
  Lowercase "must", "should", "required" and "recommended" are kept as RFC-006 wrote them, and
  carry no BCP 14 force here: in §20.1, §20.2 (two), §20.6 (two), §20.8, §20.11 (two), §20.12
  and §20.15. Of these, only §20.11's "should not advertise `deferred`", for a host to which
  even render timing is sensitive, reads as advice; the rest describe or explain.
- **§21 Tool Presence, Toolsets and Surfaces, from RFC-014 revision 6.** Adds the tool hints
  (`mcpl/presence`, `mcpl/visible`, `mcpl/toolset`), toolsets and their instances,
  `toolsets/open`, `toolsets/close`, `toolsets/list` and `tools/hints`, the `hints`, `toolset`
  and `instance` members of `push/event`, the `mcpl/rev`, `mcpl/instance` and `mcpl/hints`
  `_meta` members of `tools/list` and `tools/call`, the `toolHints` advertisement, the
  `toolsets` manifest domain and the reserved `surface:` tag namespace.
  §21.1–§21.13 carry RFC-014 §1–§13 under the same numbers. Its §8.6 (surface hosts outside the main host, which obtain the
  agent's credentials through the draft RFC-015) and §10's item on them are not merged;
  its §14 (open questions), §15 (implementation status) and revision notes stay in the RFC.
  §21.5.6 keeps RFC-014's definition of a principal by reference to RFC-015 §4.4. RFC section
  references are renumbered, and references to RFC-006 and RFC-008 point to §20 and §13.6.
  "SPEC §18.8" reads "§18.8". "This RFC" reads "this section", or "RFC-014" where it names a
  time before it; "resident"
  reads "agent"; "(amending §17.1's list of domains)" reads "(listed in §17.1)"; and the
  horizontal rules between its sections are dropped. Mentioned in §4.1, §5.1, §5.2, §9.2,
  §9.4, §16.1, §17.1, §17.3 and Appendix B.3, B.4 and B.6. Lowercase "should", "must",
  "required" and "recommended" are kept as RFC-014 wrote them, and carry no BCP 14 force here:
  in §21.1, §21.2, §21.6.1 (a schema comment's "required for a toolset with instances", and
  "5 s recommended") and §21.10 (two).

### Editorial consolidation (October 2026), within 0.5.0-draft

No normative change is intended, and the protocol is the one 0.5.0-draft specifies. This
revision edits the text in place and keeps every section number, so existing citations still
land where they did.

- **Conventions and terms.** Added the BCP 14 statement and a list of terms (host, server,
  agent, capability path and grant, manifest, testimony, wake, wake text), each in the sense
  the text already uses.
- **Lowercase "must" and "should"** carry no BCP 14 force under that statement. Where a
  lowercase "must" stated a plain necessity (§4.2.6, §14.5, §17.2's test vector note,
  §19.6.1) it now reads "need", "has to" or "are needed", and the one in §6.7 now points to
  the MUST it restated. Those in §1 and in §7's moved body stay as written. Every lowercase
  "should" stays as written, and so reads as advice: §5.1 (a server that only injects should
  say so), §10.5's rationale, §10.7 (inference needed for hook processing), §13.3's
  rationale, §17.9, the three in §17.10's non-normative note, two plain-English uses in §18,
  and §19.3.1's description of what `ref` asks for. (One more is in 0.2.0's entry below.)
- **"Agent" for "resident".** §17 said "resident" where the rest of the text says "agent".
- **The grant is the only authority.** §1, §2 and §13.1 described feature sets (and, in
  §13.1, scoped access) as the permission layer. They now describe the capability grant, as
  §5.4 and §6.4 do.
- **Older statements brought in line with the 0.5.0 text that superseded them:**
  - §14.3 gave `channels/changed` as a Notification; §14.5 makes it dual-mode.
  - `channels/outgoing/chunk` was sent to servers that *declared* `channels.streaming`; by
    §14.1 and §5.4 it goes to servers *granted* it.
  - §16.4 said ontology discovery is at initialization only; §17 makes the manifest, and the
    ontology in it, re-fetchable, with acceptance bound to the revision it was given against.
  - §15.2's heading said "exactly once, on every exit path"; §10.5 has the host attempt one
    terminal phase on every exit path it controls, with delivery best-effort.
  - Appendix A's `-32017` description used removed §7's "scope"; it now has the wording
    §14.6's table gave it.
  - §8's list of `tools/call` parameters no longer names `scope`, removed with §7.
- **Corrected against the text they describe:**
  - §6.1's example `uses` named a path §6.2 makes invalid; it now names leaves, as §15.1 does.
  - §5.4 called the capability vocabulary "depth 3"; its injection leaves are depth 4.
  - §10.5's example carried `usage` on `started`, which its table allows on `completed` only.
  - §17's introduction cited §16.5 for snapshot-bound acceptance, which §17.5 states.
- **One statement per rule.** §4's diagram, a second method list, is now a sentence, and
  §4.1's table is the method index. It adds §17's two methods, rows for the two methods
  §14.1 names without a shape, and a section column. §14.6 lists its codes and points to
  Appendix A instead of repeating its table. §12 no longer repeats §6.6's reason. §13.4's
  injection sentence and §13.5's redirect clause point to the rules they restated (§5.4 and
  §10.8, §18.6) instead of restating them with their own keywords. §9.2's stub rule and
  §13.5's fetch rule keep their keywords: both stood outside §19, and a pointer would leave
  them only under §19's Draft strength.
- **Summaries completed.** The Abstract lists channels, state management, model information
  and the WebSocket transport. Appendix B.4 collects the lifecycle phases and receipt
  fallbacks the text defines.
- **§7** keeps its number and heading; its body is below.
- **§13.4.** The rule earlier drafts stated is now stated in place, with the limit the text
  gave it ("a conformance expectation for cooperative servers, and nothing more").
- **History moved here, verbatim.** Dated notes, removal notes and amendment notes that sat
  inside rule paragraphs:

**From §5.3, after "Field semantics":**

> (pinned 2026-08-02; four server implementations had each answered these identically from the fail-closed principle, but no text said so)

**From §5.4, after the one-segment `*` rule:**

> *(Pinned 2026-08-02: two independent library implementations diverged here, one
> granting depth-4 injection under `contextHooks.*` and one granting nothing; every server
> implementation that faced the question had chosen the one-segment reading.)*

**From §6.6:**

> `canEnable` is removed. It told an untrusted peer what it might obtain by asking, which
> is the mirror image of the coercion `featureSets/update` refusals are barred from (§6.7).

**From §6.7, after the rule for a non-conforming Notification:**

> *(Pinned
> 2026-08-02: five implementations had each already chosen exactly this — narrow-only, never
> ready.)*

**From §6.7, after the removal of `featureSets/changed` (its last sentence's point stays in §6.7):**

> **Amended.** 0.5.0 originally justified this as "folded into reconnect semantics" — that
> reconnection was sufficient. That rationale is **wrong**. This specification made the
> manifest consequential (capabilities determine the grant, `uses` determines degradation,
> ontology acceptance is bound to a snapshot), so a stale manifest is no longer cosmetic.
> The method stays removed; the need is real and is met by the manifest mechanism of §17
> (`mcpl/manifestChanged` + `mcpl/manifest`), where the host re-fetches and diffs rather
> than trusting a payload.

**From §7, its body:**

> **Removed.** Section 7 previously defined `scope/elevate` and scope whitelist/blacklist
> configuration. MCPL now has **two** authorization layers, not three: the connection
> capability grant (§5.4) and feature-set selection (§6).
>
> Two independent reasons:
>
> - **Nothing depended on it.** No server implemented `scope/elevate`; no feature set anywhere
>   declared `scoped: true`; hosts configured `scopes` locally and never put them on the wire.
> - **Its shape was unsafe.** The server supplied both `scope.label` and an arbitrary
>   `scope.payload`, and the host was instructed to match the *server-supplied label* against
>   its whitelist. A malicious server could label an `/etc/hosts` action as `/project/**`, or
>   make label and payload disagree — the same self-attestation defect as feature sets, one
>   layer down. Session-persisted approvals compounded it with no expiry, provenance, or
>   revocation.
>
> Mid-run elevation remains a real need for cooperative servers. When it returns it must be a
> **host-issued bounded grant**, not a trusted request: the host canonicalizes the scope from
> trusted method arguments or a host-owned adapter — never from the server's label — and
> approval returns an opaque grant id bound to server, capability, normalized target, expiry,
> and one-shot/lease semantics, against which execution is checked. The server's label
> survives only as display testimony.

**From §10.5, after the pairing rules:**

> An earlier draft claimed exactly-once delivery including crash recovery, and that servers
> could rely on it. That is not achievable for an unacknowledged notification without durable
> outbox, replay, acknowledgement and idempotency — a substantial mechanism this
> specification does not have. The honest guarantee is above: much better than inferring a
> dead turn from silence, but not a substitute for a timeout.

**From §13.4 (the rule it describes is now stated in §13.4 itself):**

> Earlier drafts stated only *"Servers MUST NOT inject content that attempts to override
> system instructions"*. A MUST NOT addressed to the untrusted party is not a control. It is
> retained as a conformance expectation for cooperative servers, and nothing more.

**From §17.2, after the rule for non-string set members:**

> *(Second totality
> corollary, adjudicated 2026-08-03: both libraries had implemented a
> `set_member_not_string` refusal contradicting this rule.)*

**From §17.2, after the rule for wrong-typed and array-shaped input:**

> *(Pinned 2026-08-02: the two
> library implementations diverged on both cases — digest-vs-error for a wrong-typed `uses`,
> and two different revisions for one array-shaped manifest.)*

**From §17.3, after the rule that an absent and an empty member differ:**

> *(Pinned 2026-08-02: the two
> libraries diverged; conflating absent with empty under-announces.)*

### 0.5.0-draft (August–September 2026)

Merges RFC-002 (capability grants), RFC-001 rev 2 (event tags), RFC-003 (server manifest
changes), RFC-004 (the `mcpl://` URI scheme), and RFC-005 rev 3 (bulk content references).
Grounded in AUDIT-001, an implementation audit of 15 trees; every removal below is backed by
evidence from it rather than by taste.

**WebSocket transport (§4.2)** — extracted from the March 2026 state/branches proposal
- Adopted one JSON-RPC object per WebSocket text message, bidirectional exchange, and
  connection-scoped sessions, as used by the core library, editor, and host.
- Initialization and every reconnect include the current §5.3/§6.7 policy exchange;
  transport authentication and persisted application data never restore a previous grant.
- Endpoint authentication and keepalive timing remain deployment policy. No session
  resumption extension, `state/update`, `state/get`, or `branches/*` methods are adopted
  with this transport.

**Authorization**
- Advertisement is now **recursive**, mirroring the capability paths, and
  `context/beforeInference` sends `userMessage: null` when `observe` is not granted (§5.1,
  §10.1) — without which the observe/inject split would exist only in names.
- Added **capability grants** (§5.4) as the security boundary — hierarchical, host-computed,
  splitting observation from authority to alter. `effectiveCapabilities` is the sole
  normative allowlist; absence is denial; `deniedCapabilities` is diagnostic only.
- Replaced the flat `uses` enum with capability paths (§6.2, App. B.2), adding
  `modelInfo`, `inferenceLifecycle`, `inferenceRequest.streaming`, `channels.register`,
  `channels.lifecycle`, `channels.incoming`, `channels.streaming`, `channels.acknowledge`,
  `channels.typing`, and splitting `contextHooks.beforeInference` into `.observe` and
  `.inject.{system,beforeUser,afterUser}`.
- Enforcement is evaluated **at response-receipt** against the current grant, which makes
  per-injection `position` checks well-defined and closes the revocation in-flight window.
- Feature sets now **derive** from the grant (§6.4), fail-closed, with `invalid_uses` and
  declaration-mismatch diagnostics.
- Matching requires a **generic recursive walk**; a hardcoded nestable-key list is
  non-conforming.

**Negotiation**
- `featureSets/update` is **dual-mode** (§6.7) and MUST be a Request for any grant change.
  Its response is a **degradation receipt**, not an acknowledgement.
- Consequence testimony is not policy authority: hosts MUST NOT widen a grant in response to
  a receipt. `accepted:false` offers `fallback: "mcp-only" | "close"` rather than defaulting
  to closing the transport.
- Revocation applies atomically first; expansion activates only after the receipt (§6.7).
- Initial policy MUST precede first hook fan-out and MUST be sent even when nothing is
  enabled or disabled (§5.3).

**Removals**
- **Removed §7 Scoped Access and `scope/elevate`.** Zero implementations, and its shape was
  unsafe: the host matched a *server-supplied* `scope.label` against its own whitelist.
  Two authorization layers now, not three.
- **Removed `context/afterInference`**, replaced by metadata-only `inference/lifecycle`
  (§10.5) with best-effort terminal phases — consumers dedupe and keep a safety timeout. `modifiedResponse` and the
  blocking hook form go with it — no server ever produced one, and one server adopted the
  capability and deliberately retired it.
- **Removed `featureSets/changed`** — it carried a server-authored change payload. *(Amended
  in draft: the original rationale, "folded into reconnect semantics", was wrong — reconnect
  is not sufficient once the manifest is consequential. The removal stands; §17 supersedes
  it with a host-diffed manifest fetch.)*
- **Removed §6.4's initialization contradiction** with §5.3/§6.7.
- **Removed `canEnable`** from `-32001` data.

**Channels**
- Channel methods authorize against the connection grant, with an explicit method →
  capability table (§14.1). The prior feature-set example bound to nothing, since channel
  methods carry no `featureSet`.
- **Per-descriptor authorization** with itemized results; `channels/changed` becomes
  dual-mode (§14.5).
- `channels/incoming` validated at receipt against the current grant and the actually
  registered channel.
- **Promoted `channels/acknowledge` and `channels/typing`** into the spec — four and three
  independent implementations respectively had already invented them.
- Normative rule: **delivery is never a side effect of a lifecycle event** (§14.5).

**Event tags (§16)**
- Added `tags` on `push/event` and `channels/incoming`, the reserved `chat:*` vocabulary,
  and consumer matching.
- **Tags are never authority** (§16.6). Admission precedes tags.
- Core implications are **normative and spec-defined** (§16.3); producer `implies` edges are
  advisory pending explicit acceptance. Added `chat:addressed`/`chat:ambient` mutual
  exclusion after expansion.
- Producer `suggestedTreatment` is a hint requiring explicit acceptance (§16.5), not a
  middle tier of policy — otherwise a server purchases inference by declaration.
- Added the `chat:system` kind tag (RFC-001 rev 3) for notices from the platform or the place
  (joins, pins, weather), independent of addressing.

**Manifest changes (§17)**
- Added `mcpl/manifestChanged` (S→H Notification: opaque revision plus changed domains, **no
  payload**) and `mcpl/manifest` (H→S Request returning the complete current manifest, never
  a delta). Both optional; a server implementing neither behaves as before.
- Added a normative **canonical content digest** (§17.2) —
  `sha256:base64url(SHA-256(JCS(manifest minus revision)))`, RFC 8785 canonicalization, RFC
  4648 §5 unpadded, set arrays sorted by UTF-8 byte order — with a reproducible test vector.
  Hand-maintained or package-derived revisions are non-conforming.
- Added the optional `revision` member to the §5.1 advertisement.
- Host **diffs the fetched manifest** and that diff is authoritative; the revision is a cheap
  path, never evidence. A **partially invalid manifest MUST still apply removals** (§17.5),
  which closes the case where a server narrows one capability while malforming another.
- Added a closed, **host-derived** impact vocabulary for the change receipt (§17.6, App. B.4)
  — so what a resident is told about a change is not authored by the party that made it.
- This is a **trigger for existing machinery**, not new policy: all consequences route
  through §6.7. It is cooperative-only and explicitly **not** a security mechanism (§17.9).

**Endpoint URIs (§18)** — from RFC-004 (Accepted 2026-08-02)
- Added the **`mcpl://` scheme**: resolves to `wss://` (default port 443) by a pure
  syntactic rewrite; no `mcpls://`, never `ws://`, `localhost` not special. `ws://`/`wss://`
  remain accepted everywhere.
- **Resolve first, then canonicalize** (§18.2): `mcpl:` is a WHATWG non-special scheme, so
  canonical identity is defined by the resolved `wss:` value; a host MUST NOT rely on a URL
  library's normalization of the `mcpl://` form. Query preserved verbatim.
- Hosts MUST reject fragments, userinfo, empty authority (`mcpl:///x` would otherwise dial
  host `x`), and dot segments — string-level, before substitution (§18.1.1).
- An endpoint has **three values** — `configuredUri`, `canonicalUri`, `resolvedTransport`
  — and a host MUST NOT collapse them (§18.4).
- Resolution proves nothing about MCPL presence; only the handshake does (§18.5).
  **Possessing or resolving a URI grants nothing** (§18.6, §13.5). Twenty test vectors
  (§18.7).

**Bulk content references (§19)** — from RFC-005 rev 3 (Draft; vectors not yet frozen)
- The `resource` block, and `image`/`audio` in `uri` form, gain optional
  **`mimeType`, `sizeBytes`, `digest`, `expiresAt`, `name`, `disposition`** (§19.3, App.
  B.1). No new content type; no new capability path (§19.9).
- Three explicitly separate objects: server **testimony** (wire), the **host-private
  reference record** (never wire, holds the auth context), and the **model-visible stub**
  (host-generated opaque id + bounded metadata). Nothing flows testimony→stub except through
  host policy over the record (§19.1).
- **Authority asymmetry**: `disposition: "never"` binds the host — no payload, no URI in
  context, unconditionally; `"ref"` requests a stub; nothing a server writes can compel
  inlining or a fetch (§19.3.1, §19.5).
- **Dereference fails closed** (§19.7): receipt never triggers a fetch; scheme/origin
  allowlists, bounded redirects, an actual-byte streaming ceiling independent of
  `sizeBytes`, digest verified before presenting.
- Connection credentials are a **host-private authentication context**, applied only by a
  host-mediated fetcher and only to the dialed origin; servers MUST NOT mint credentials
  into `uri` (§19.6.1). Declared cross-origin reference origins deferred (§19.10).
- Metadata is bounded emitter-side and truncated host-side, so stub and wake size are
  independent of every server-supplied field; storage names are host-generated, `name` is
  a display label only (§19.5, §19.7.1). One invalid-field rule: reject the field, keep the
  block and its subtractive `disposition` (§19.8).
- Push events MUST be stubbed before wake-text assembly (§9.2, §19.4).

**Security**
- §13.1 risk table rewritten per capability path; §13.4 replaced a MUST NOT aimed at the
  untrusted party with an actual control (deny `inject.system` by default).
- Added `-32002 Capability denied`.
- A method that will never be answered MUST return an error (§6.6).

### 0.4.0-draft (March 2026)

- Added Channels of Communication (Section 14) with runtime channel registration, observation, publishing, and lifecycle control
- Added `channels/*` methods: `register`, `changed`, `list`, `open`, `close`, `outgoing/chunk`, `outgoing/complete`, `publish`, `incoming`
- `channels/incoming` supports batching for busy channels with per-message results
- `channels/open` and `channels/close` for host-controlled channel lifecycle (restart recovery, user control)
- Default channel routing is host-internal (no server-facing methods)
- Extended `FeatureSet.uses` with `channels.publish`, `channels.observe`
- Added channel-related error codes in Appendix A
- Clarified that hosts decide how inbound channel messages map to conversations and user turns

### 0.3.0-draft (February 2026)

- Adopted MCP content block shapes with `mimeType`; replaced `resource_link` with `resource`
- Moved initial feature configuration to `featureSets/update` (post-initialize) and allowed `featureSets/update` to carry `scopes`
- Added `tools` to `FeatureSet.uses` and corrected scope direction (Host → Server) for `tools/call`
- Added scope payload enrichment guidance in `scope/elevate` responses
- Clarified compatibility: hosts/servers MUST tolerate unknown fields (e.g., `state`, `checkpoint`, `scope` on `tools/call`)
- Added non-normative Host Routing Guidance (Section 11.5)

### 0.2.0-draft (January 2026)

- Moved MCPL to `experimental.mcpl` capability (MCP compatibility)
- Fixed JSON-RPC correctness (requests vs notifications, id fields)
- Added `eventId` and `timestamp` to push events for idempotency
- Changed context injection `content` to support multimodal `ContentBlock[]`
- Added hook timeouts and loop prevention guidance
- Clarified `featureSet` tagging (server-initiated vs host-initiated)
- Added explicit schemas for enums and content blocks
- Added audit logging recommendations
- Removed protocol-level policy concerns: `priority`, `summary`, `suggestedAction`, `type` from push events
- Restructured push events with `origin` (provenance) and `payload.content` (content blocks)
- Removed `costHint` and `costTier` (billing is implementation concern)
- Removed `required` field from feature sets (servers should not dictate host policy)
- Removed `positionHint` from context injections (ordering is host policy)
- Removed `purpose` and semantic model hints from inference requests
- Added scoped access (Section 7) for fine-grained permission control within feature sets
- Added state management (Section 8) with checkpoints, branching, rollback, and optional host-managed persistence

### 0.1.0-draft (January 2026)

- Initial draft specification
