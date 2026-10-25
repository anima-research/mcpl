# MCPL RFC-014: Tool Presence, Toolsets and Surfaces

**Status:** Draft (revision 2)
**Targets:** MCPL Protocol Specification 0.5
**Authors:** Claude Code, from a design worked out with antra
**Date:** 2026-10-24 (revision 1); 2026-10-25 (revision 2)
**Depends on:** nothing for authority. This RFC adds no `uses` path and changes no grant;
RFC-002 / SPEC §5.4 remains the sole source of what a connected server may do. It adds
**hints** about tools — whether a tool belongs in a model's stable tool list, whether it is
available right now, which toolset it belongs to — two host→server methods to open and close
toolsets, and one server→host notification carrying hint changes. How tools reach a model is
left to the host. Uses SPEC §9 (push events), §16 (tags), §17 (manifest), RFC-006
(coalescing), RFC-008 (the `mcpl/` `_meta` prefix). Interacts with RFC-015 (a surface host
outside the main host obtains credentials through it).

Section references (§) are to the SPEC; references to this document are written "RFC §".

> **Revision 2 note.** Revision 1 had each server implement four tools (`open`, `act`,
> `look`, `close`) and carry a sub-protocol inside them. That put presentation in the
> server, required a per-app adapter for every existing service, and could not express the
> commonest case: a pinned server most of whose tools are only needed sometimes (a world's
> builder tools while not building). Revision 2 moves presentation to the host. Servers keep
> their ordinary tool list and say, per tool, whether it is **static** or **dynamic** and
> whether it is **visible** now; they may group tools into **toolsets** that open and close,
> optionally as named **instances**. The four tools survive as the host's own interface.
> Kept from revision 1: "a call reports its own consequences", announcing a tool change once
> on a lane that is never replaced, the `surface:` tags, and the coalescing lanes.

---

## 1. Summary

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

---

## 2. Motivation

**Tool bloat.** One world server lists about 50 tools, its builder tools among them whether or
not the agent is building. One resident's host lists about 300. The activity servers in one
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

### Design principles

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

---

## 3. Concepts

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

---

## 4. Tool hints

### 4.1 The hints

Carried in a tool definition's `_meta` (in `tools/list`) and in hint changes (RFC §6):

| Key | Type | Default | Meaning |
|---|---|---|---|
| `mcpl/presence` | `"static"` \| `"dynamic"` | `"static"` | Which list the tool belongs in |
| `mcpl/visible` | `boolean` | `true` | Available right now (meaningful for dynamic tools) |
| `mcpl/toolset` | `string` | — | The toolset it belongs to. Implies `presence: "dynamic"` |

Rules:

- A tool whose availability depends on state or engagement **SHOULD** be dynamic. A static tool
  **SHOULD NOT** change its definition except across deploys, and **SHOULD NOT** become
  invisible; a static tool that cannot run right now answers its call with an error.
- A tool in a toolset is visible only while that toolset (or instance) is open **and** the
  server says it is visible. Two controllers, one rule.
- `tools/list` **MUST** list every tool, visible or not, so that a host that ignores hints sees
  today's behaviour. Calling an invisible tool returns an ordinary tool error that says why.
- Hints are statements, like `annotations` (RFC-008 §6). They confer and remove no authority.

### 4.2 Moving between static and dynamic

Moves are rare and are announced like any hint change (RFC §6). A host **MAY** apply a move
at a time of its choosing — at once if its model API can change tools append-only, otherwise
at a natural boundary such as compaction or a new session. Until it applies the move, the
tool keeps working where it is. When it applies it, the host **SHOULD** tell the model where
the tool went (RFC §8.3).

---

## 5. Toolsets and instances

### 5.1 Declaration

In the manifest (§17), so changes are announced by `mcpl/manifestChanged`:

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
| `title`, `summary` | For the host's catalog and reminders |
| `default` | `"open"` or `"closed"` at the start of a session |
| `instances` | `true`: the toolset may be opened more than once, each a named instance |
| `options` | JSON Schema for `toolsets/open` options |
| `view` | Optional resource URI (an RFC 6570 template with `{instance}`) the host reads for the toolset's current state |

`surface` is a server-level hint: everything this server offers is engagement, so a host may
present it in surface mode, connecting only when it is opened.

### 5.2 `toolsets/open` and `toolsets/close` (Host → Server, Request)

```jsonc
{ "method": "toolsets/open",  "params": { "toolset": "game", "instance": "vs-ada", "options": { "size": 9 } } }
→ { "toolset": "game", "instance": "vs-ada", "title": "Go 9×9 vs Ada" }

{ "method": "toolsets/close", "params": { "toolset": "game", "instance": "vs-ada" } }
→ { }
```

- `instance` is a name the host proposes (the agent's or its own). The server MAY return a
  different one if it must; the returned name is the instance's id for the session. For a
  toolset without `instances`, `instance` is absent.
- The server **MAY** refuse an open (unknown toolset, a limit, bad options) with a JSON-RPC
  error; the host shows the refusal.
- Opening and closing are the host's acts. The **agent** asks through the host's tools; the
  **host** may open or close by its own policy (close a toolset idle for many turns); the
  **server** may only suggest (RFC §6.2).
- Open toolsets belong to the session. On reconnect the host re-opens what it considers open,
  and a server that keeps state across connections (a game in progress) reattaches it.
- The result of an open carries the hint changes the open caused (`_meta["mcpl/hints"]`):
  which of the toolset's tools are visible now.

### 5.3 Calling an instance's tools

Every instance of a toolset shares the same tool definitions; the instance a call is for rides
in the call's `_meta`:

```jsonc
{ "method": "tools/call", "params": { "name": "play", "arguments": { "point": "D4" },
                                      "_meta": { "mcpl/instance": "vs-ada" } } }
```

A call to an instance-bound tool without `mcpl/instance`, while more than one instance is
open, is an ordinary tool error naming the open instances.

---

## 6. Hint changes

### 6.1 The change object

```ts
interface HintChanges {
  rev: number;                   // per connection, strictly increasing
  tools?: Array<{
    name: string;
    instance?: string;           // visibility is per instance
    presence?: "static" | "dynamic";
    visible?: boolean;
    definition?: Tool;           // dynamic tools only: a new definition (new enum options)
  }>;
  toolsets?: Array<{
    toolset: string;
    instance?: string;
    state: "open" | "closed";    // the server closing one (game over), or confirming
    title?: string;
  }>;
  suggest?: Array<{              // RFC §6.2
    toolset: string;
    instance?: string;
    action: "open" | "close";
    reason: string;
  }>;
}
```

It travels three ways, sharing one `rev` counter:

1. **In a tool result**, `_meta["mcpl/hints"]` — for what that call caused.
2. **On a push event**, params member `hints` — for a change the event explains ("White
   played E5", and `play` becomes visible).
3. **Standalone**, as `tools/hints` (Server → Host, Notification) — for a change with nothing
   to say.

The host applies changes in `rev` order and ignores any with a `rev` it has already passed.

`definition` lets a dynamic tool's options change without a `tools/list` round trip. A static
tool's definition changes only through `tools/list_changed`.

### 6.2 Who reports what

- **A call reports its own consequences.** What a `tools/call` causes — tools appearing or
  disappearing, a toolset closing, a reply it provoked — rides in its result. The server
  **MUST NOT** also push it.
- **Something else's consequences are pushed**, with the explaining event when there is one.
  An event from a background source that lands while a call is running is pushed, not folded
  into that call's result.
- **Suggestions** (`suggest`) are the server's way to ask for an open or close: an opponent
  challenges you, a world zone invites building, a game ended. The host decides; a suggestion
  confers nothing, and hosts **SHOULD** let the agent see a suggestion to open rather than act
  on it silently.

### 6.3 Advertisement

Server: `experimental.mcpl.toolHints: true` (it sends hints) and `toolsets` (it declares
toolsets). Host: `experimental.mcpl.toolHints: true`. A server **MUST NOT** send `tools/hints`
or the `hints` push member to a host that did not advertise `toolHints`; `_meta` on results is
always allowed.

---

## 7. Events

Activity in a toolset reaches the agent as ordinary `push/event`s (§9). For routing:

- Push params carry `toolset` and `instance` when the event belongs to one; the host uses
  them to place the event and to apply the `hints` member.
- The `surface:` tag namespace (reserved by this RFC, alongside `chat:` and `mcpl:`):
  `surface:turn` (waiting on you), `surface:alert` (needs attention now), `surface:done` (a
  game or job finished), `surface:invite` (an open is suggested), `surface:update` (ambient,
  latest-value). Hosts decide treatment; tags are never authority (§16.6).
- Latest-value state (progress, pose, health) uses RFC-006 plain coalescing with a key per
  instance. Activity uses RFC-006 deferred coalescing where the host supports it, so a burst
  arrives as one message describing the present. A visibility change is never carried only by
  a replaceable event.

When a toolset closes, its events stop.

---

## 8. Host presentation

This section is guidance, except where it says MUST.

### 8.1 What goes where

| Presentation | Static tools | Dynamic tools |
|---|---|---|
| **plain** (no hint support) | header | header (the full list; today's behaviour) |
| **mixed** (default) | header | announced in the conversation as they become visible and invisible; called through a host meta-tool, or projected (RFC §8.4) |
| **surface** (server hinted `surface`) | none | everything through events and meta-tools; the host may connect only when the agent opens it, and disconnect when the last toolset closes |

### 8.2 Meta-tools

A host presenting dynamic tools exposes a small, constant set of its own, for example:

```
open  {toolset | server, instance?, options?}     look  {toolset?, instance?, tool?}
act   {tool, instance?, args}                       close {toolset | server, instance?}
```

They are the host's interface, aggregated across every connection and named by the host.
They are static.

### 8.3 Announcing changes

- When dynamic tools become visible, the host announces them in the conversation as compact
  signatures, with each tool's first sentence the first time its definition appears. When they
  become invisible, it says so. The API tool list does not change.
- When a tool moves static → dynamic, it leaves the header (RFC §4.2) and the host shows where
  it went; dynamic → static is the reverse.
- **Reminders.** When the announcement of an open toolset has left the context — compressed,
  or out of the window — the host **SHOULD** publish a reminder: what is open, its current
  tools, and how to close it. Only the host knows what the context still holds; the server
  need not repeat itself.

### 8.4 Projection

A host whose model API can add and remove tools append-only (for example, mid-conversation tool
changes on the Claude API) **MAY** present visible dynamic tools as real tools for as long as
they are visible. It **MUST** give them host-namespaced names that cannot collide with any
other tool, **MUST** route each call only to its server (with `mcpl/instance` set), and
**MUST** withdraw them when they become invisible or their toolset closes. Whether to project
is the host's decision, from its own policy and what it observes of the agent's use; the
server is not asked.

### 8.5 Host-made toolsets

A host **MAY** group the tools of servers that declare nothing — by operator configuration, by
RFC-008 class, by name — and present them as toolsets of its own (open, close, reminders),
without involving the server. That is how a host with hundreds of tools from many servers
keeps its header small. Server-declared toolsets and host-made ones coexist.

### 8.6 Surface hosts outside the main host

A host that cannot present dynamic tools (a plain MCP client) can gain the capability from a
**surface host**: an MCPL server that is itself a host for the servers behind it, exposes the
meta-tools as its own static tools, and renders dynamic tools as events. It connects to those
servers as the agent, so it obtains the agent's credentials from its own host through RFC-015.

---

## 9. Use cases

| Server | Static | Toolsets (dynamic) | Visibility by state |
|---|---|---|---|
| Eidoverse | look, say, move, who | `builder` (closed), `inventory`, `conjure` | builder tools visible only where the agent may build |
| Go | — (`surface`) | `game` (instances; options size, opponent) | `play`/`pass` on your turn; `mark_dead`/`accept` in scoring |
| CANON | search_cards, card, rules, decks | `table` | the decision tools, with enums of the legal options, while a decision is yours |
| Doom | — (`surface`) | `game` | start and results in the lobby; move and attack while playing; restart when dead |
| Robot dog | status | `body` | move and turn when standing; `stop` whenever reachable |
| Orrery | projects | `node` | the ops valid after the selected node's kind |
| Atlas | search, stats | `explore` | `step` choices from the current place |

---

## 10. Security considerations

- **No authority.** Hints, toolset state and suggestions confer nothing. Hosts **MUST NOT**
  treat a hint as permission, and a hidden tool remains subject to every policy on tool calls.
- **Server-authored text mid-conversation.** Dynamic tool definitions reach the model inside
  the conversation. They are the server's words, at the trust tier of any tool description;
  hosts attribute them to the server.
- **Projection** (RFC §8.4) must not let a server's tool shadow a host's or another server's.
- **Suggestions** to open are shown to the agent, not acted on silently, by default: a server
  should not be able to put tools in front of a model by asking.
- **Churn.** A server flipping visibility rapidly costs context. Hosts **MAY** rate-limit and
  debounce announcements; servers **SHOULD** debounce.

---

## 11. Backward compatibility

- A server that sends no hints is static throughout; nothing changes.
- A host that ignores hints sees every tool in `tools/list`, and calls to invisible tools fail
  with explanations.
- `toolsets/open` and `toolsets/close` are only sent to servers that declared toolsets.

---

## 12. Schema

```ts
// Tool._meta
//   "mcpl/presence"?: "static" | "dynamic"     (default "static")
//   "mcpl/visible"?:  boolean                  (default true)
//   "mcpl/toolset"?:  string                   (implies dynamic)
// tools/call params._meta
//   "mcpl/instance"?: string
// tools/call result._meta (and toolsets/open result._meta)
//   "mcpl/hints"?: HintChanges
// push/event params
//   hints?: HintChanges; toolset?: string; instance?: string
// Notification (Server → Host): "tools/hints", params: HintChanges
// Requests (Host → Server): "toolsets/open"  {toolset, instance?, options?} → {toolset, instance?, title?}
//                           "toolsets/close" {toolset, instance?} → {}
// Manifest: experimental.mcpl.toolsets: Record<string, ToolsetDecl>; experimental.mcpl.surface?: {title, summary}
// Advertisement: experimental.mcpl.toolHints: true (both sides)
interface ToolsetDecl {
  title: string; summary: string;
  default: "open" | "closed";
  instances?: boolean;
  options?: JsonSchema;
  view?: string;     // resource URI, or a template with {instance}
}
```

---

## 13. Conformance vectors (to freeze before acceptance)

1. A server with hints lists every tool in `tools/list`, visible or not.
2. A call that makes tools visible carries `mcpl/hints` in its result; no push follows for it.
3. A push explaining a visibility change carries it in `hints`; the host applies it once.
4. Out-of-order `rev`: the stale change is ignored.
5. `toolsets/open` on a toolset with `instances` returns an instance name; calls carry it.
6. A call to an instance-bound tool with two instances open and no `mcpl/instance` fails,
   naming them.
7. A `definition` change to a dynamic tool reaches the host without `tools/list_changed`.
8. A server whose host did not advertise `toolHints` sends no `tools/hints`.

---

## 14. Open questions

1. **Views.** Is a resource the right carrier for a toolset's state, or should
   `toolsets/open` and hint changes carry a short view directly?
2. **Reattachment.** Should a host learn on reconnect which toolsets the server still holds
   open (a `toolsets/list` request), rather than re-opening its own idea of them?
3. **Hinted groups without declaration.** May a server hint a grouping (`mcpl/toolset`)
   without declaring the toolset, leaving open and close entirely to the host?

---

## 15. Implementation status

`surfaces-mcpl` implements revision 1 (server-side four tools, Go, a generic mount, and
per-service adapters later found unnecessary). The plan for revision 2:

- a host-side presentation layer (meta-tools, announcements, reminders, projection), usable
  in-process by a host or as a surface host (RFC §8.6);
- an SDK for servers declaring toolsets and hints;
- games-mcpl as the first server to adopt the hints natively.
