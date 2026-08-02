# MCP Live (MCPL) Protocol Specification

**Version:** 0.5.0-draft  
**Status:** Draft  
**Authors:** Antra  
**Date:** August 2026

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

MCPL enables servers to be active participants in the inference lifecycle rather than passive tool providers.

---

## Table of Contents

1. [Motivation](#1-motivation)
2. [Design Goals](#2-design-goals)
3. [Compatibility](#3-compatibility)
4. [Protocol Overview](#4-protocol-overview)
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
- Feature sets provide granular permissions

---

## 2. Design Goals

| Goal | Rationale |
|------|-----------|
| **Backward compatible** | MCPL servers degrade gracefully in MCP hosts; MCP servers work unchanged in MCPL hosts |
| **Orthogonal extension** | Doesn't modify MCP semantics; adds new capabilities alongside existing ones |
| **Host-controlled** | Hosts decide ordering, cost limits, and trust levels; protocol expresses server preferences |
| **Granular permissions** | Feature sets allow users to enable specific behaviors without all-or-nothing trust |
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

MCPL extends the MCP message flow:

```
┌─────────────────────────────────────────────────────────────────────┐
│                        MCPL MESSAGE FLOW                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   MCP (unchanged)                 MCPL Extensions                   │
│   ───────────────                 ───────────────                   │
│                                                                     │
│   tools/call, resources/read,    push/event (server → host)        │
│   sampling/createMessage, etc.   context/beforeInference           │
│                                   inference/lifecycle               │
│                                   inference/request                 │
│                                   inference/chunk                   │
│                                   model/info                        │
│                                   featureSets/update                │
│                                   state/rollback                    │
│                                   channels/register                 │
│                                   channels/changed                  │
│                                   channels/list                     │
│                                   channels/open                     │
│                                   channels/close                    │
│                                   channels/outgoing/chunk           │
│                                   channels/outgoing/complete        │
│                                   channels/publish                  │
│                                   channels/incoming                 │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

All messages use JSON-RPC 2.0, consistent with MCP.

### 4.1 Request vs Notification

Per JSON-RPC 2.0:

- **Requests** include an `id` field and expect a response with the same `id`
- **Notifications** omit `id` and expect no response

| Method | Type | Direction |
|--------|------|-----------|
| `push/event` | Request | Server → Host |
| `context/beforeInference` | Request | Host → Server |
| `inference/lifecycle` | Notification | Host → Server |
| `inference/request` | Request | Server → Host |
| `inference/chunk` | Notification | Host → Server |
| `model/info` | Request | Server → Host |
| `featureSets/update` | Notification **or Request** | Host → Server |
| `state/rollback` | Request | Host → Server |
| `channels/register` | Request | Server → Host |
| `channels/changed` | Notification **or Request** | Server → Host |
| `channels/list` | Request | Either |
| `channels/open` | Request | Host → Server |
| `channels/close` | Request | Host → Server |
| `channels/outgoing/chunk` | Notification | Host → Server |
| `channels/outgoing/complete` | Notification | Host → Server |
| `channels/publish` | Notification or Request | Host → Server |
| `channels/incoming` | Request | Server → Host |

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

**Field semantics** (pinned 2026-08-02; four server implementations had each answered these
identically from the fail-closed principle, but no text said so):

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
  nestable keys is non-conforming, since the vocabulary is depth 3 and will grow.

**`*` matches exactly one path segment, and segment counts MUST be equal.** `channels.*`
grants `channels.publish` but not `channels.publish.anything`; `contextHooks.*` grants
**none** of the depth-4 injection leaves; a bare `*` matches only depth-1 paths. A trailing
`*` is NOT a subtree match. There is no multi-segment wildcard. This is the deny-safe
reading — a mistaken narrow pattern can only under-grant, which the host observes and
corrects, while a suffix wildcard silently widens the grant class this section exists to
narrow. *(Pinned 2026-08-02: two independent library implementations diverged here, one
granting depth-4 injection under `contextHooks.*` and one granting nothing; every server
implementation that faced the question had chosen the one-segment reading.)*

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
          "uses": ["contextHooks.beforeInference"]
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

> `canEnable` is removed. It told an untrusted peer what it might obtain by asking, which
> is the mirror image of the coercion `featureSets/update` refusals are barred from (§6.7).

### 6.7 Negotiated policy

`featureSets/update` (Host → Server) MAY be sent as a Notification or as a Request — the
same optional-ACK idiom §14.3 uses for `channels/publish`.

Hosts **MUST** send it as a Request for **any change to the effective grant**: initial
policy (§5.3), reductions, and expansions. Notifications remain valid only for purely
descriptive feature metadata that does not alter the grant, and a Notification **cannot
establish a ready state**.

**Server handling of a non-conforming Notification** (one that nevertheless carries grant
fields): apply a narrowing `disabled` list — reductions must be respected regardless of
carrier — and **ignore everything else** with a diagnostic. `effectiveCapabilities`,
`enabled`, and any widening are discarded: honouring a widening from an unacknowledgeable
message would have the server acting on a path the host cannot know it accepted. *(Pinned
2026-08-02: five implementations had each already chosen exactly this — narrow-only, never
ready.)*

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

> **Amended.** 0.5.0 originally justified this as "folded into reconnect semantics" — that
> reconnection was sufficient. That rationale is **wrong**. This specification made the
> manifest consequential (capabilities determine the grant, `uses` determines degradation,
> ontology acceptance is bound to a snapshot), so a stale manifest is no longer cosmetic.
> The method stays removed; the need is real and is met by the manifest mechanism of §17
> (`mcpl/manifestChanged` + `mcpl/manifest`), where the host re-fetches and diffs rather
> than trusting a payload.

---

## 7. Scoped Access — removed in 0.5.0

**Removed.** Section 7 previously defined `scope/elevate` and scope whitelist/blacklist
configuration. MCPL now has **two** authorization layers, not three: the connection
capability grant (§5.4) and feature-set selection (§6).

Two independent reasons:

- **Nothing depended on it.** No server implemented `scope/elevate`; no feature set anywhere
  declared `scoped: true`; hosts configured `scopes` locally and never put them on the wire.
- **Its shape was unsafe.** The server supplied both `scope.label` and an arbitrary
  `scope.payload`, and the host was instructed to match the *server-supplied label* against
  its whitelist. A malicious server could label an `/etc/hosts` action as `/project/**`, or
  make label and payload disagree — the same self-attestation defect as feature sets, one
  layer down. Session-persisted approvals compounded it with no expiry, provenance, or
  revocation.

Mid-run elevation remains a real need for cooperative servers. When it returns it must be a
**host-issued bounded grant**, not a trusted request: the host canonicalizes the scope from
trusted method arguments or a host-owned adapter — never from the server's label — and
approval returns an opaque grant id bound to server, capability, normalized target, expiry,
and one-shot/lease semantics, against which execution is checked. The server's label
survives only as display testimony.

Per-channel narrowing (patterns like `discord:acme/*`) now attaches to the grant entry
(§14.5), not to a separate layer.

---

## 8. State Management

MCPL supports stateful tools with branching state. Servers choose per-response whether to include state data for host persistence or manage state internally.

Hosts are not required to implement the full checkpoint tree or branching. A minimal host may track only the latest checkpoint, or ignore state entirely. Branching and rollback are opt-in capabilities that hosts advertise and implement to the extent they choose.

Compatibility note: MCPL extends MCP `tools/call` with optional parameters such as `state`, `checkpoint`, and `scope`. Servers MUST tolerate and ignore unknown request fields, and hosts MUST tolerate unknown response fields, to preserve backward compatibility.

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

### 9.4 Idempotency

Hosts SHOULD deduplicate events by `eventId`. Servers SHOULD use stable `eventId` values for retries.

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
| `image` | Image via `{ data, mimeType }` or `{ uri }` |
| `audio` | Audio via `{ data, mimeType }` or `{ uri }` |
| `resource` | URI reference to a resource |

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
    "phase": "started",
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

> An earlier draft claimed exactly-once delivery including crash recovery, and that servers
> could rely on it. That is not achievable for an unacknowledged notification without durable
> outbox, replay, acknowledgement and idempotency — a substantial mechanism this
> specification does not have. The honest guarantee is above: much better than inferring a
> dead turn from silence, but not a substitute for a timeout.

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
with an error (§6.6) — silently sending no response leaves the caller hanging and makes the
surface impossible to evaluate.

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

MCPL expands server capabilities significantly. Feature sets and scoped access provide granular control:

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

Hosts MUST authorize each returned injection by its typed `position` at response-receipt
(§5.4, §10.8), and MAY additionally validate injected content.

> Earlier drafts stated only *"Servers MUST NOT inject content that attempts to override
> system instructions"*. A MUST NOT addressed to the untrusted party is not a control. It is
> retained as a conformance expectation for cooperative servers, and nothing more.

---

## 14. Channels of Communication

Channels represent named destinations for messages (e.g., `ui`, `discord:#general`, `telegram:123456`, `signal:+15551234`). Channels are runtime‑extensible and host‑controlled. Channels are independent of moderation; hosts may run moderation on content before routing/publishing.

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

- `channels/changed` (Server → Host, Notification): Notify added/removed/updated channels.

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

  - **Opt-in**: sent only to servers that declared `channels.streaming: true`
    in their initialize capabilities. Servers that did not declare it MUST NOT
    receive these notifications.
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

- `channels/publish` (Host → Server, Notification or Request): Ask connector to deliver content to a channel.

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

The same shape applies to `channels/register`. A host receiving a Notification it must
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

Add to Appendix A:

| Code | Message | Description |
|------|---------|-------------|
| `-32002` | Capability denied | Method requires a capability not in the effective grant; `data: { capability }` |
| `-32017` | Channel not permitted | Lacking capability to publish to or receive from channel |
| `-32023` | Unknown channel | Channel id doesn’t exist or not registered |
| `-32024` | Channel open failed | Server could not open/connect the requested channel |

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

**Turn end — exactly once, on every exit path:**

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
  and SHOULD match the producer's declared name.
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
| Content | `chat:has-image` / `chat:has-audio` / `chat:has-file` / `chat:has-link` / `chat:command` | Modality |
| Locus | `chat:private` / `chat:group` / `chat:thread` | Conversation shape |

`chat:reaction-remove` is distinct from `chat:reaction`: emitting the latter for a removal
makes "wake on reactions to my messages" fire on un-reactions.

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

Discovery is at init only. There is no runtime ontology-query method: a mutable ontology
cannot be meaningfully "accepted" per §16.5.

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
(§16.5). A stale manifest is therefore no longer cosmetic, and discovery at `initialize`
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

Three change **domains** partition it:

| Domain | Members |
|---|---|
| `capabilities` | every member other than `version`, `revision`, and `featureSets` |
| `featureSets` | the `featureSets` member, excluding any `tagOntology` within it |
| `tagOntology` | the `tagOntology` of any feature set |

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

**The digest is total.** Set semantics apply **only when the value actually is an array**
at one of the three named locations, in the object-keyed `featureSets` shape those paths
are written against. A wrong-typed value in a set position (`"uses": "tools"`), an
array-shaped `featureSets`, or any other non-conforming structure is **hashed verbatim** —
canonicalized by JCS, never set-normalized, never refused. Validation (§6.4) is where a
wrong type fails; the digest's job is to give any two libraries the same answer for the
same bytes, including bytes that will then fail validation. *(Pinned 2026-08-02: the two
library implementations diverged on both cases — digest-vs-error for a wrong-typed `uses`,
and two different revisions for one array-shaped manifest.)*

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
must happen, and neither alone yields this value.

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

`domains` is a subset of `capabilities | featureSets | tagOntology`. It carries **no
payload** — no diff, no list of what was added or removed, no policy conclusion. Everything
a server might assert about the change is something the host would have to re-derive anyway,
and asserting it invites the self-attestation defect this specification removes in §5.4 and
§7.

A host **MAY** ignore the notification entirely. A host that acts on it **MUST** fetch
(§17.4) before changing anything.

**Deriving `domains`:** an **absent** member and an **empty** one are different manifests —
they canonicalize differently — so a member appearing or disappearing IS a change to its
domain. Going from `{"version":"0.5"}` to `{"version":"0.5","featureSets":{}}` announces
`featureSets` (and `tagOntology`, whose carrier appeared). *(Pinned 2026-08-02: the two
libraries diverged; conflating absent with empty under-announces.)*

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

The host emits a single normalized, privacy-minimal receipt to the resident or operator.
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

Whether a receipt **wakes** the resident is ordinary §16 policy evaluated against tags the
host attaches — not a property of the change and not the server's to decide.

`ontology-reference-undeclared` is **informational by default**, and the name is deliberate.
Tag ontologies are open-world, so a tag absent from the new declaration may still be emitted
when `open: true`, and a consumer rule matches raw event tags regardless of what is declared.
The certain fact is narrower — the accepted *description* disappeared, not that the rule
stopped matching. A resident may well want to know, because it often *precedes* a rule going
dead, but the host cannot assert that it has.

### 17.7 Relationship to existing change notifications

MCP's `notifications/tools/list_changed` (and the resources/prompts equivalents) and MCPL's
`channels/changed` (§14.5) **remain unchanged**. They are specialized, they carry no manifest
authority, and they already work.

The host **SHOULD** coalesce them into the same resident-facing changelog surface, so a
resident sees one account of "what changed about this server" rather than four unrelated
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
library **MUST NOT** generate resident-facing prose or policy conclusions — the impact
vocabulary of §17.6 is host-derived precisely so that what a resident is told about a change
is not authored by the party that made it.

---

## Appendix A: Error Codes

| Code | Message | Description |
|------|---------|-------------|
| `-32001` | Feature set not enabled | Message used a disabled feature set |
| `-32002` | Capability denied | Method requires a capability not in the effective grant (§5.4); `data: { capability }` |
| `-32003` | Unknown feature set | Message used undeclared feature set |
| `-32005` | Checkpoint not found | Rollback targeted a pruned or unknown checkpoint |
| `-32017` | Channel not permitted | Lacking scope to publish or observe channel |
| `-32023` | Unknown channel | Channel id doesn’t exist or not registered |
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
        "mimeType": { "type": "string" },
        "uri": { "type": "string" }
      },
      "oneOf": [
        { "required": ["type", "data", "mimeType"] },
        { "required": ["type", "uri"] }
      ]
    },
    {
      "type": "object",
      "properties": {
        "type": { "const": "audio" },
        "data": { "type": "string" },
        "mimeType": { "type": "string" },
        "uri": { "type": "string" }
      },
      "oneOf": [
        { "required": ["type", "data", "mimeType"] },
        { "required": ["type", "uri"] }
      ]
    },
    {
      "type": "object",
      "required": ["type", "uri"],
      "properties": {
        "type": { "const": "resource" },
        "uri": { "type": "string" }
      }
    }
  ]
}
```

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
      "items": { "enum": ["capabilities", "featureSets", "tagOntology"] }
    }
  },
  "additionalProperties": false   // §17.3: the notification carries no payload
}
```

`mcpl/manifest` takes no params and returns the manifest object above.

### B.4 Enums

**Position:** `"system" | "beforeUser" | "afterUser"`

**FinishReason:** `"end_turn" | "max_tokens" | "stop_sequence"`

**ChangeDomain:** `"capabilities" | "featureSets" | "tagOntology"`

**ChangeImpact:** `"capability-revoked" | "capability-expansion-pending" | "feature-degraded" | "feature-restored" | "ontology-acceptance-invalidated" | "ontology-reference-undeclared" | "surface-changed"`

**Disposition:** `"applied" | "decision-needed" | "informational"`

---

## Changelog

### 0.5.0-draft (August 2026)

Merges RFC-002 (capability grants), RFC-001 rev 2 (event tags), and RFC-003 (server manifest
changes). Grounded in AUDIT-001, an implementation audit of 15 trees; every removal below is
backed by evidence from it rather than by taste.

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
