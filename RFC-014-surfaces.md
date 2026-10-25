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
| `mcpl/toolset` | `string` | — | The toolset it belongs to. Implies `presence: "dynamic"`. The toolset need not be declared (RFC §5.4) |

Rules:

- A tool whose availability depends on state or engagement **SHOULD** be dynamic. A static tool
  **SHOULD NOT** change its definition except across deploys, and **SHOULD NOT** become
  invisible; a static tool that cannot run right now answers its call with an error.
- A tool in a toolset is visible only while that toolset (or instance) is open **and** the
  server says it is visible. Two controllers, one rule.
- `tools/list` **MUST** list every tool, visible or not, so that a host that ignores hints sees
  today's behaviour. Calling an invisible tool — or a tool of a toolset that is not open —
  returns an ordinary tool error that says why.
- In `tools/list`, `mcpl/visible` on a toolset's tool means "visible in at least one open
  instance"; per-instance visibility travels in hint changes (RFC §6). The list carries the
  declared definitions, and its result carries `_meta["mcpl/rev"]`: the hint revision it
  reflects, so a host applies only later changes on top of it.
- **For a host that did not advertise `toolHints`, every toolset is implicitly open** and
  the server behaves as it would without this RFC; where a toolset cannot sensibly be open
  without options (a game needs its settings), the server may instead offer that host plain
  tools to open and close it (RFC §11).
- Tool names are unique across a server, static and toolset tools alike: instances share
  their toolset's definitions, so a name identifies one definition.
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
| `default` | `"open"`: the server treats the toolset as open from the start of a session — it appears in `toolsets/list` without the host opening it. `"closed"`: the host opens it. Not allowed with `instances` |
| `instances` | `true`: the toolset may be opened more than once, each a named instance |
| `options` | JSON Schema for `toolsets/open` options |

`surface` is a server-level hint: everything this server offers is engagement, so a host may
present it in surface mode, connecting only when it is opened.

### 5.2 `toolsets/open` and `toolsets/close` (Host → Server, Request)

```jsonc
{ "method": "toolsets/open",  "params": { "toolset": "game", "instance": "vs-ada", "options": { "size": 9 } } }
→ { "toolset": "game", "instance": "vs-ada", "title": "Go 9×9 vs Ada",
    "content": [ { "type": "text", "text": "    A B C D E F G H J\n 9  . . . …" } ] }

{ "method": "toolsets/close", "params": { "toolset": "game", "instance": "vs-ada" } }
→ { "content": [ { "type": "text", "text": "You left a live game: that is a forfeit." } ] }
```

- `instance` is a name the host proposes (the agent's or its own). The server MAY return a
  different one if it must; the returned name is the instance's id for the session. For a
  toolset without `instances`, `instance` is absent.
- Opening what is already open — a toolset without instances, or an instance by a name that is
  open — **adopts** it: the result describes the existing one and changes nothing. This makes a
  host's re-open after a reconnect safe.
- The server **MAY** refuse an open (unknown toolset, a limit, bad options) with a JSON-RPC
  error; the host shows the refusal.
- Opening and closing are the host's acts. The **agent** asks through the host's tools; the
  **host** may open or close by its own policy (close a toolset idle for many turns); the
  **server** may only suggest (RFC §6.2).
- Open toolsets belong to the **principal** (RFC §5.6). On reconnect the host asks the server
  what is open (`toolsets/list`, RFC §5.3) and takes that as the truth: it adopts what the
  server reports and treats anything else it believed open as closed. It does **not** re-open
  on its own — opening can have effects (starting a new game) and is the agent's or the host's
  deliberate act, not reconciliation.
- The result of a close **MAY** carry `content` — what closing meant (a forfeit, a game kept on
  the server) — and carries the hint changes it caused, like an open.
- The result of an open carries the hint changes the open caused (`_meta["mcpl/hints"]`):
  which of the toolset's tools are visible now. It **MAY** carry `content` (content blocks, as
  in a tool result): what the agent sees on opening — the board, the surroundings, the
  decision in front of it. Later state arrives as event content, and a toolset that wants
  "look again" offers an ordinary tool for it. There is no separate view mechanism.

### 5.3 `toolsets/list` (Host → Server, Request)

```jsonc
{ "method": "toolsets/list", "params": {} }
→ { "open": [ { "toolset": "game", "instance": "vs-ada", "title": "Go 9×9 vs Ada" } ],
    "_meta": { "mcpl/hints": { "rev": 41, "tools": [ { "name": "play", "instance": "vs-ada", "visible": true } ] } } }
```

What the principal has open on the server, with the hint state of their tools, and — so a
host can tell "never had one" from "it ended while you were away" — toolsets that closed
recently without this connection being told:

```jsonc
→ { "open": [ … ], "ended": [ { "toolset": "game", "reason": "idle for 30 minutes" } ] }
```

A server that keeps toolsets across connections reports them after a reconnect; one that does
not reports what was opened on this connection. Hosts send it after every (re)connect to a
server that declared toolsets, and tell the agent about anything `ended`.

### 5.4 Undeclared toolsets

A server may tag tools with `mcpl/toolset` without declaring that toolset. It then offers a
grouping, nothing more: the host opens and closes the group on its own (as with host-made
toolsets, RFC §8.5), sends no `toolsets/open` or `toolsets/close` for it, and the server does
not track it. A tool in an undeclared toolset is visible while the host has the group open
and the server's `visible` hint is true. Declaring the toolset is what makes the server
session-aware of it, and is needed for instances and options.

### 5.5 Calling an instance's tools

Every instance of a toolset shares the same tool definitions; the instance a call is for rides
in the call's `_meta`:

```jsonc
{ "method": "tools/call", "params": { "name": "play", "arguments": { "point": "D4" },
                                      "_meta": { "mcpl/instance": "vs-ada" } } }
```

A call to an instance-bound tool without `mcpl/instance`, while more than one instance is
open, is an ordinary tool error naming the open instances.


### 5.6 One principal, several connections

Toolsets belong to the principal, not to a connection: a second connection of the same
principal sees the same open toolsets (through `toolsets/list`, then hint changes). An open,
close or visibility change made through one connection reaches the others as ordinary hint
changes on their own `rev` counters — including `toolsets` state changes — not as
suggestions.

---

## 6. Hint changes

### 6.1 The change object

```ts
interface HintChanges {
  rev: number;                   // per connection, strictly increasing
  tools?: Array<{
    name: string;
    instance?: string;           // required for a toolset with instances: visibility is per instance
    presence?: "static" | "dynamic";
    visible?: boolean;
    definition?: Tool;           // dynamic tools only: a new definition (new enum options)
  }>;
  toolsets?: Array<{
    toolset: string;
    instance?: string;
    state: "open" | "closed";    // opened, closed (game over), confirmed, or — with a new
    title?: string;              // title — retitled ("freedoom2 MAP02, skill 5")
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

A server **MUST** send hint changes on a connection in `rev` order — whichever of the three
ways each travels — so that a lower `rev` never arrives after a higher one (allocate the `rev`
and write the message in one step). The host applies changes in `rev` order and ignores any
with a `rev` it has already passed; a host that sees a gap or a reversal anyway re-reads the
state with `toolsets/list`.
A host applies the `hints` of a push only if it accepts the push; if it refuses one (or the
server gets no answer), the server re-sends the same changes as `tools/hints` with the same
`rev`. A host applies each `rev` at most once.

`definition` lets a dynamic tool's options change without a `tools/list` round trip. A static
tool's definition changes only through `tools/list_changed`.

Hint changes need no capability to be applied: they describe the server's own tools. Delivering
anything they cause into a model's context follows the host's usual rules for events (a host
that has not granted `pushEvents` still tracks visibility, and shows it in results and `look`).
A host **MUST** ignore hint `_meta` and `tools/hints` from a server that did not advertise
`toolHints`.

### 6.2 Who reports what

- **A call reports its own consequences.** What a `tools/call` causes — tools appearing or
  disappearing, a toolset closing, a reply it provoked — rides in its result. The server
  **MUST NOT** also push it.
- **Something else's consequences are pushed**, with the explaining event when there is one.
  An event from a background source that lands while a call is running is pushed, not folded
  into that call's result. A server that finds changes by comparing state before and after a
  call may occasionally attribute a concurrent background change to the call; that is
  acceptable — the host still learns the change, once.
- **Suggestions** (`suggest`) are the server's way to ask for an open or close: an opponent
  challenges you, a world zone invites building, a game ended. The host decides; a suggestion
  confers nothing, and hosts **SHOULD** let the agent see a suggestion to open rather than act
  on it silently.

### 6.3 Advertisement

Server: `experimental.mcpl.toolHints: true` (it sends hints) and `toolsets` (it declares
toolsets). Host: `experimental.mcpl.toolHints: true`. A server **MUST NOT** send `tools/hints`
or the `hints` push member to a host that did not advertise `toolHints`. It **MAY** tailor
everything else to the host as well — omit the toolset declarations, hint `_meta` and any
hints-only tools — so that a host without `toolHints` sees exactly what it saw before this
RFC.

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
- A server with toolsets **MAY** offer a host that did not advertise `toolHints` two plain
  static tools that open and close toolsets (the reference SDK names them `toolset_open` and
  `toolset_close`), so it remains usable there: the toolset's tools are in the list, and a
  call without `mcpl/instance` goes to the only open instance.
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
// Requests (Host → Server): "toolsets/open"  {toolset, instance?, options?} → {toolset, instance?, title?, content?}
//                           "toolsets/close" {toolset, instance?} → {content?}
//                           "toolsets/list"  {} → {open: [{toolset, instance?, title?}], ended?: [{toolset, instance?, reason}]}  (+ _meta["mcpl/hints"])
// tools/list result._meta: "mcpl/rev": number
// Manifest: experimental.mcpl.toolsets: Record<string, ToolsetDecl>; experimental.mcpl.surface?: {title, summary}
// Advertisement: experimental.mcpl.toolHints: true (both sides)
interface ToolsetDecl {
  title: string; summary: string;
  default: "open" | "closed";
  instances?: boolean;
  options?: JsonSchema;
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
9. After a reconnect, `toolsets/list` reports an instance the server kept; the host adopts
   it rather than opening a second.
10. A tool tagged with an undeclared toolset: the host never sends `toolsets/open` for it,
    and the tool is visible only while the host has the group open.

---

## 14. Open questions

1. **State on open.** Revision 2 carries it as `content` in the open result, with later
   state as event content and no view mechanism (RFC §5.2). Confirm, or name a case that
   needs more.

---

## 15. Implementation status

- **Server SDK and go-mcpl** (surfaces-mcpl, `src/sdk`, `src/servers/go`): revision 2's server
  side, with tests for vectors 1–9 that apply to a server.
- **Host** (mcpl-cc-bridge, branch `tool-hints`): in progress.
- **games-mcpl** (branch `tool-hints`): native; one toolset `game`, static catalogue and
  results; conformance tests against the real engine.

Earlier:

`surfaces-mcpl` implements revision 1 (server-side four tools, Go, a generic mount, and
per-service adapters later found unnecessary). The plan for revision 2:

- a host-side presentation layer (meta-tools, announcements, reminders, projection), usable
  in-process by a host or as a surface host (RFC §8.6);
- an SDK for servers declaring toolsets and hints;
- games-mcpl as the first server to adopt the hints natively.
