# MCP Live (MCPL) Protocol Specification

**Version:** 0.2.0-draft  
**Status:** Draft  
**Authors:** Antra  
**Date:** January 2026

---

## Abstract

MCP Live (MCPL) is a backward-compatible extension to the Model Context Protocol (MCP) that adds:

1. **Push Events** — Servers can push events to hosts that may trigger model inference
2. **Context Hooks** — Servers can inject or modify context before and after inference (multimodal)
3. **Server-Initiated Inference** — Servers can request autonomous inference from the host
4. **Feature Sets** — Fine-grained access control allowing hosts to enable/disable specific server behaviors

MCPL enables servers to be active participants in the inference lifecycle rather than passive tool providers.

---

## Table of Contents

1. [Motivation](#1-motivation)
2. [Design Goals](#2-design-goals)
3. [Compatibility](#3-compatibility)
4. [Protocol Overview](#4-protocol-overview)
5. [Capability Negotiation](#5-capability-negotiation)
6. [Feature Sets](#6-feature-sets)
7. [Scoped Access](#7-scoped-access)
8. [State Management](#8-state-management)
9. [Push Events](#9-push-events)
10. [Context Hooks](#10-context-hooks)
11. [Server-Initiated Inference](#11-server-initiated-inference)
12. [Model Information](#12-model-information)
13. [Security Considerations](#13-security-considerations)
14. [Examples](#14-examples)

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
        "version": "0.2",
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
│                                   context/afterInference            │
│                                   inference/request                 │
│                                   inference/chunk                   │
│                                   model/info                        │
│                                   featureSets/update                │
│                                   featureSets/changed               │
│                                   scope/elevate                     │
│                                   state/rollback                    │
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
| `context/afterInference` | Request or Notification | Host → Server |
| `inference/request` | Request | Server → Host |
| `inference/chunk` | Notification | Host → Server |
| `model/info` | Request | Server → Host |
| `featureSets/update` | Notification | Host → Server |
| `featureSets/changed` | Notification | Server → Host |
| `scope/elevate` | Request | Server → Host |
| `state/rollback` | Request | Host → Server |

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
        "version": "0.2",
        "pushEvents": true,
        "contextHooks": {
          "beforeInference": true,
          "afterInference": { "blocking": false }
        },
        "inferenceRequest": { "streaming": true },
        "modelInfo": true,
        "featureSets": { ... }  // See Section 6
      }
    }
  }
}
```

### 5.2 Host Response

The host responds with its MCPL support and enabled feature sets:

```jsonc
{
  "protocolVersion": "2024-11-05",  // MCP version unchanged
  "capabilities": { ... },
  "experimental": {
    "mcpl": {
      "version": "0.2",
      "featureSets": {
        "enabled": ["memory.retrieval", "memory.extraction"],
        "disabled": ["memory.consolidation"]
      }
    }
  }
}
```

---

## 6. Feature Sets

Feature sets provide fine-grained access control over server behaviors.

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
          "uses": ["contextHooks.afterInference"]
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

**Valid `uses` values:**
- `"pushEvents"`
- `"contextHooks.beforeInference"`
- `"contextHooks.afterInference"`
- `"inferenceRequest"`

### 6.3 Hierarchical Naming

Feature sets use dot-separated names enabling bulk operations:

```
memory.retrieval
memory.extraction  
memory.consolidation
```

Hosts MAY support wildcards: `memory.*` enables/disables all `memory.` features.

### 6.4 Initialization

Feature set selection happens during initialization. The host includes enabled/disabled sets in its response.

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

### 6.6 Enforcement

When a host receives a message tagged with a disabled feature set:

```jsonc
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32001,
    "message": "Feature set not enabled",
    "data": { 
      "featureSet": "memory.consolidation",
      "canEnable": true
    }
  }
}
```

For unknown feature sets, hosts SHOULD reject with `-32003`.

### 6.7 Dynamic Updates

**featureSets/update (Host → Server, Notification):**

```jsonc
{
  "jsonrpc": "2.0",
  "method": "featureSets/update",
  "params": {
    "enabled": ["memory.proactive"],
    "disabled": ["memory.consolidation"]
  }
}
```

Servers MUST immediately respect the new configuration.

**featureSets/changed (Server → Host, Notification):**

```jsonc
{
  "jsonrpc": "2.0",
  "method": "featureSets/changed",
  "params": {
    "added": {
      "memory.semantic": {
        "description": "Semantic search (index now ready)",
        "uses": ["contextHooks.beforeInference"]
      }
    },
    "removed": ["memory.legacy"]
  }
}
```

---

## 7. Scoped Access

Scoped access provides fine-grained permission control within feature sets. Servers can declare that actions require scope approval, and hosts can whitelist or blacklist scopes.

### 7.1 Declaration

Servers declare that a feature set uses scopes:

```jsonc
{
  "featureSets": {
    "files.edit": {
      "description": "Edit files on the filesystem",
      "uses": ["tools"],
      "scoped": true
    },
    "discord.post": {
      "description": "Post messages to Discord channels",
      "uses": ["tools"],
      "scoped": true
    }
  }
}
```

### 7.2 Host Configuration

Hosts configure whitelist and blacklist patterns for scoped feature sets:

```jsonc
{
  "experimental": {
    "mcpl": {
      "featureSets": {
        "enabled": ["files.edit", "discord.post"]
      },
      "scopes": {
        "files.edit": {
          "whitelist": ["/project/**", "/tmp/**"],
          "blacklist": ["**/.env", "**/secrets/**"]
        },
        "discord.post": {
          "whitelist": ["#general", "#dev-*"],
          "blacklist": ["#admin-*"]
        }
      }
    }
  }
}
```

Pattern matching semantics (glob, regex, exact) are host-defined.

### 7.3 Scope Structure

A scope consists of a label and an optional payload:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `label` | `string` | Yes | Human-readable identifier for whitelist/blacklist matching |
| `payload` | `object` | No | Arbitrary data passed back to server when approved |

The label is used for display and pattern matching. The payload carries structured data the server needs when the scope is approved.

### 7.4 scope/elevate (Server → Host, Request)

When a server needs to act in a scope that isn't whitelisted (or is blacklisted), it requests elevation:

```jsonc
{
  "jsonrpc": "2.0",
  "method": "scope/elevate",
  "id": 1,
  "params": {
    "featureSet": "files.edit",
    "scope": {
      "label": "/etc/hosts",
      "payload": { "path": "/etc/hosts", "mode": "append" }
    }
  }
}
```

### 7.5 Response

```jsonc
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "approved": true,
    "payload": { "path": "/etc/hosts", "mode": "append" }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `approved` | `boolean` | Whether the scope was approved |
| `payload` | `object` | The payload from the request, returned on approval |
| `reason` | `string` | Present if `approved: false` |

### 7.6 Host Evaluation

When a server requests elevation:

1. If label matches blacklist → deny
2. If label matches whitelist → approve, return payload
3. Otherwise → host decides (may prompt user for approval)

Hosts MAY cache approvals for the session or persist them.

### 7.7 Tagging Actions with Scope

When performing scoped actions, servers SHOULD include the scope:

```jsonc
{
  "method": "tools/call",
  "params": {
    "name": "edit_file",
    "scope": {
      "label": "/project/src/main.ts",
      "payload": { "path": "/project/src/main.ts" }
    },
    "arguments": { ... }
  }
}
```

Hosts validate the scope against whitelist/blacklist before executing.

---

## 8. State Management

MCPL supports stateful tools with branching state and optional host-managed persistence.

### 8.1 Capability Declaration

Feature sets declare state management capabilities:

```jsonc
{
  "featureSets": {
    "notes.edit": {
      "description": "Manage notes",
      "uses": ["tools"],
      "rollback": true,
      "hostState": true
    },
    "git.commit": {
      "description": "Git operations",
      "uses": ["tools"],
      "rollback": true,
      "hostState": false
    }
  }
}
```

| Property | Type | Description |
|----------|------|-------------|
| `rollback` | `boolean` | Server supports rollback to previous checkpoints |
| `hostState` | `boolean` | Host manages state persistence for this feature set |

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

### 8.3 Host-Managed State

When `hostState: true`, the host manages state persistence. Server sends state data or patches, host stores and provides state with requests.

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

### 8.4 State in Requests

For `hostState: true` feature sets, host includes current state with requests:

```jsonc
{
  "method": "tools/call",
  "params": {
    "name": "add_note",
    "state": { "notes": [{ "id": 1, "text": "Remember to..." }] },
    "arguments": { "text": "Buy groceries" }
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

### 8.7 Server-Managed State

When `hostState: false`, server manages its own state persistence. Checkpoints are opaque references. Host tracks lineage but doesn't store state data.

```jsonc
{
  "state": {
    "checkpoint": "chk_def",
    "parent": "chk_abc"
  }
}
```

Host sends only the checkpoint reference, not state data:

```jsonc
{
  "method": "tools/call",
  "params": {
    "name": "git_commit",
    "checkpoint": "chk_def",
    "arguments": { "message": "Fix bug" }
  }
}
```

### 8.8 Checkpoint Retention

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
| `userMessage` | `string \| null` | User input (null for continued generation) |
| `model` | `ModelInfo` | Current model metadata |

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

Injections use MCP-style content blocks for multimodal support:

```jsonc
"content": [
  { "type": "text", "text": "Relevant context..." },
  { 
    "type": "image", 
    "source": { 
      "type": "base64", 
      "media_type": "image/png", 
      "data": "iVBORw0KGgo..." 
    }
  },
  {
    "type": "resource_link",
    "uri": "memory://facts/12345"
  }
]
```

**Supported content types:**

| Type | Description |
|------|-------------|
| `text` | Plain text content |
| `image` | Base64-encoded image with `media_type` |
| `audio` | Base64-encoded audio with `media_type` |
| `resource_link` | URI reference to a resource |

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

### 10.5 context/afterInference

Sent after inference completes.

**As Notification** (default, `afterInference.blocking: false`):

```jsonc
{
  "jsonrpc": "2.0",
  "method": "context/afterInference",
  "params": {
    "inferenceId": "inf_xyz",
    "conversationId": "conv_123",
    "turnIndex": 7,
    "userMessage": "How's the project?",
    "assistantMessage": "Based on your recent work...",
    "model": { ... },
    "usage": {
      "inputTokens": 1250,
      "outputTokens": 340
    }
  }
}
```

**As Request** (`afterInference.blocking: true`):

Same structure but includes `id`. Host waits for response.

```jsonc
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "featureSet": "compliance.redaction",
    "modifiedResponse": "The API key is [REDACTED]...",
    "metadata": {
      "redactions": [{ "type": "api_key", "position": [16, 38] }]
    }
  }
}
```

### 10.6 Hook Timeouts

Hosts SHOULD enforce timeouts on context hooks:

- `beforeInference`: Recommended 5 seconds
- `afterInference` (blocking): Recommended 10 seconds

On timeout, hosts SHOULD proceed without the hook's contribution and MAY log the timeout.

### 10.7 Loop Prevention

Context hooks MUST NOT trigger `inference/request` calls. Servers needing inference for hook processing should do so asynchronously outside the hook response path.

Hosts MAY track hook depth and reject nested hook invocations.

### 10.8 Ordering

When multiple servers provide injections, hosts group by `position` and determine order within each position.

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

---

## 12. Model Information

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
| `pushEvents` | Cost, attention | Disable proactive features |
| `contextHooks.beforeInference` | Read context, inject content | Review descriptions |
| `contextHooks.afterInference` | Read/modify responses | Disable blocking hooks |
| `inferenceRequest` | Consume inference budget | Disable high-cost features |
| Scoped actions | Access beyond intended scope | Whitelist/blacklist patterns |

### 13.2 Audit Logging

Hosts SHOULD log MCPL operations with:

- `serverId`
- `featureSet`
- `inferenceId` (when applicable)
- Timestamp
- Outcome (success/failure/timeout)

This enables debugging, cost attribution, and security review.

### 13.3 Blocking Hook Policy

For blocking `afterInference` hooks, hosts should decide:

- **Fail-open**: On timeout/error, show unmodified response
- **Fail-closed**: On timeout/error, show error to user

Fail-open is recommended for most use cases.

### 13.4 Context Injection Safety

Hosts MAY validate injected content. Servers MUST NOT inject content that attempts to override system instructions or impersonate other entities.

---

## 14. Examples

### 14.1 Memory Server

**Capabilities:**

```jsonc
{
  "capabilities": {
    "experimental": {
      "mcpl": {
        "version": "0.2",
        "contextHooks": {
          "beforeInference": true,
          "afterInference": { "blocking": false }
        },
        "inferenceRequest": { "streaming": true },
        "pushEvents": true,
        "featureSets": {
          "memory.retrieval": {
            "description": "Retrieve relevant memories",
            "uses": ["contextHooks.beforeInference"]
          },
          "memory.extraction": {
            "description": "Learn from conversations",
            "uses": ["contextHooks.afterInference"]
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

### 14.2 Compliance Server (Blocking Hook)

**Capabilities:**

```jsonc
{
  "capabilities": {
    "experimental": {
      "mcpl": {
        "version": "0.2",
        "contextHooks": {
          "afterInference": { "blocking": true }
        },
        "featureSets": {
          "compliance.redaction": {
            "description": "Redact secrets and PII from responses",
            "uses": ["contextHooks.afterInference"]
          }
        }
      }
    }
  }
}
```

**Redaction flow:**

```jsonc
// Host → Server
{
  "jsonrpc": "2.0",
  "method": "context/afterInference",
  "id": 15,
  "params": {
    "inferenceId": "inf_abc",
    "conversationId": "conv_456",
    "turnIndex": 3,
    "userMessage": "What's the API key?",
    "assistantMessage": "The API key is sk-1234567890abcdef...",
    "model": { ... },
    "usage": { "inputTokens": 50, "outputTokens": 20 }
  }
}

// Server → Host
{
  "jsonrpc": "2.0",
  "id": 15,
  "result": {
    "featureSet": "compliance.redaction",
    "modifiedResponse": "The API key is [REDACTED]...",
    "metadata": { "redactions": [{ "type": "api_key" }] }
  }
}
```

---

## Appendix A: Error Codes

| Code | Message | Description |
|------|---------|-------------|
| `-32001` | Feature set not enabled | Message used a disabled feature set |
| `-32003` | Unknown feature set | Message used undeclared feature set |
| `-32005` | Checkpoint not found | Rollback targeted a pruned or unknown checkpoint |

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
      "required": ["type", "source"],
      "properties": {
        "type": { "const": "image" },
        "source": {
          "type": "object",
          "required": ["type", "media_type", "data"],
          "properties": {
            "type": { "const": "base64" },
            "media_type": { "type": "string" },
            "data": { "type": "string" }
          }
        }
      }
    },
    {
      "type": "object",
      "required": ["type", "source"],
      "properties": {
        "type": { "const": "audio" },
        "source": {
          "type": "object",
          "required": ["type", "media_type", "data"],
          "properties": {
            "type": { "const": "base64" },
            "media_type": { "type": "string" },
            "data": { "type": "string" }
          }
        }
      }
    },
    {
      "type": "object",
      "required": ["type", "uri"],
      "properties": {
        "type": { "const": "resource_link" },
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
          "contextHooks.beforeInference",
          "contextHooks.afterInference",
          "inferenceRequest"
        ]
      }
    }
  }
}
```

### B.3 Enums

**Position:** `"system" | "beforeUser" | "afterUser"`

**FinishReason:** `"end_turn" | "max_tokens" | "stop_sequence"`

---

## Changelog

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
