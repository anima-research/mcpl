# MCPL RFC-014: Tool Presence, Toolsets and Surfaces

**Status:** Draft (revision 6)
**Targets:** MCPL Protocol Specification 0.5
**Authors:** Claude Code, from a design worked out with antra
**Date:** 2026-10-24 (revision 1); 2026-10-25 (revisions 2–6)
**Depends on:** nothing for authority — except that RFC §8.6's surface hosts obtain
credentials through the draft RFC-015 (delegated access, proposed in a companion PR), whose own
grant governs that. This RFC adds no `uses` path and changes no grant;
RFC-002 / SPEC §5.4 remains the sole source of what a connected server may do. It adds
**hints** about tools — whether a tool belongs in a model's stable tool list, whether it is
available right now, which toolset it belongs to — two host→server methods to open and close
toolsets, and one server→host notification carrying hint changes. How tools reach a model is
left to the host. Amends SPEC §4 (message flow: `toolsets/open|close|list`, `tools/hints`),
§5.1 and §5.2 (the `toolHints` advertisement, server and host), §9.2 (`push/event` params gain
`hints`, `toolset`, `instance`), §9.4 (a push carrying `hints` is not retried), §16.1 (reserves
the `surface:` tag namespace), §17.1 and §17.3 (a `toolsets` manifest domain, its derivation
from the members `toolHints`, `toolsets` and `surface`), Appendix B, Changelog; and adds `_meta` members to MCP's
`tools/list` result (`mcpl/rev`) and `tools/call` params (`mcpl/instance`) and result
(`mcpl/hints`). Uses
RFC-006 (coalescing) and RFC-008 (the `mcpl/` `_meta` prefix). Interacts with the draft
RFC-015 (delegated access, proposed alongside this one), through which a surface host outside
the main host obtains credentials.

Section references (§) are to the SPEC; references to this document are written "RFC §".

> **Revision 6 note.** From review of revision 5. Hosts apply hint changes in **`rev` order**,
> which is arrival order on stdio and WebSocket; on Streamable HTTP, where streams interleave, a
> host holds an early change briefly for the missing ones (RFC §6.1). A `toolsets/list` result
> always carries its hints, empty or not, so an empty statement clears stale state (RFC §5.3).
> "Principal" takes RFC-015 §4.4's definition (RFC §5.6); a server that does not keep toolsets
> across connections ends them (RFC §5.3). Toolset names have a grammar (RFC §5.1). `act` and
> `look` can name the server (RFC §8.2). The amendment list names §9.4 and §17.3.

> **Revision 5 note.** From review of revision 4. Every message that carries hint changes takes
> the next `rev` — the `toolsets/*` results included (RFC §6.1). A call that will get no result
> (cancelled) sends its changes as `tools/hints`, and so does a server that cannot push; a push
> carrying hints is never retried (RFC §6.1, §6.2). `toolsets/list` is answered by every server
> with `toolHints` and states dynamic tools outside declared toolsets too (RFC §5.3). `ended`
> records every end the host did not ask for, whoever was connected (RFC §5.3). A manifest
> change that removes a toolset closes its instances (RFC §5.1); the `toolsets` domain's changes
> map to `surface-changed` (§17.6). Instance names have a grammar (RFC §5.2). Security covers all
> server-authored text and surface hosts (RFC §10). More vectors.

> **Revision 4 note.** From review of revision 3, the rev rules are rebuilt. Revs on a
> connection are **consecutive**, so a host can tell a lost message from a skipped number; a
> host applies hint changes **on arrival, in arrival order**, whatever it does with the message
> that carries them — so a refused push no longer needs restating and leaves no hole, and the
> asynchronous accept decision can no longer reorder anything (RFC §6.1). `tools/list` and
> `toolsets/list` are each statements as of their own place in that order, so recovery needs no
> common baseline; `toolsets/list` states per-instance visibility in full (RFC §5.3). `ended`
> records carry an `id` and are reported until they expire; hosts tell their agent once per id,
> across reconnects (RFC §5.3). A hint `definition` with an `instance` is that instance's own, and
> hosts ignore everything in it but description, schema and annotations (RFC §6.1). An open
> without an instance name is not idempotent (RFC §5.2); policy closes are limited (RFC §5.2);
> the list-every-tool rule is scoped to hosts with `toolHints` (RFC §4.1); hosts without
> `toolHints` can choose among instances (RFC §11). More vectors.

> **Revision 3 note.** From review. A refused push's changes are restated under a **new** rev,
> never re-sent under the old one (RFC §6.1); pushes carrying hints are never coalesced (RFC §7);
> a definition sent in hints changes only description, schema and annotations, and hosts apply
> their tool policy to it (RFC §6.1); recovery after a gap re-reads `tools/list` and
> `toolsets/list`, which restates current definitions (RFC §5.3); servers do not rename proposed
> instances, and an adopting open says so, with any options not applied (RFC §5.2); calls into
> undeclared toolsets are gated by the host (RFC §5.4); toolset declarations form their own
> manifest domain (RFC §5.1); an explicit `presence: "static"` on a toolset's tool is ignored;
> the schema and the amendment list are completed, and vectors added for the rev rules, `ended`,
> other connections, presence moves and close results.

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
| `mcpl/toolset` | `string` | — | The toolset it belongs to. Implies `presence: "dynamic"`, and wins over an explicit `presence: "static"`, which hosts ignore on such a tool. The toolset need not be declared (RFC §5.4) |

Rules:

- A tool whose availability depends on state or engagement **SHOULD** be dynamic. A static tool
  **SHOULD NOT** change its definition except across deploys, and **SHOULD NOT** become
  invisible; a static tool that cannot run right now answers its call with an error.
- A tool in a toolset is visible only while that toolset (or instance) is open **and** the
  server says it is visible. Two controllers, one rule.
- To a host that advertised `toolHints`, `tools/list` **MUST** list every tool, visible or not.
  (To a host that did not, a server may tailor its list: RFC §6.3, §11.) Calling an invisible tool — or a tool of a declared toolset that is not
  open — returns an ordinary tool error that says why. (For an undeclared toolset the server
  does not know what is open; the host gates those calls, RFC §5.4.)
- In `tools/list`, `mcpl/visible` on a toolset's tool means "visible in at least one open
  instance"; per-instance visibility travels in hint changes (RFC §6). The list carries the
  declared definitions and each tool's current presence, and its result carries
  `_meta["mcpl/rev"]`: the last `rev` this connection had sent when the list was written (the
  list itself takes none). **A host's per-instance state comes from `toolsets/list`** (RFC §5.3).
- **For a host that did not advertise `toolHints`, every toolset without instances is
  implicitly open** and the server behaves as it would without this RFC. A toolset with
  instances has no implicit instance; nor does one that cannot sensibly be open without options
  (a game needs its settings). For those the server offers that host plain tools to open,
  choose and close instances (RFC §11), or leaves them out.
- Tool names are unique across a server, static and toolset tools alike: instances share
  their toolset's **declared** definitions, so a name identifies one declared definition. A hint
  may give one instance its own current definition (RFC §6.1).
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

In the manifest (§17), so changes are announced by `mcpl/manifestChanged`. `toolHints`,
`toolsets` and `surface` form their own manifest domain, **`toolsets`** (amending §17.1's list
of domains). A change in it carries no grant consequence: its impact is §17.6's
`surface-changed`, disposition `applied`; the host emits its receipt as for any change (§17.5),
re-reads the declarations and refreshes its catalog. (The server-level `surface` member is
unrelated to the impact's name.)

A change that removes a toolset, turns its `instances` off, or leaves it undeclared ends its open
instances: the server closes them with or before the change, reporting them as closed in hint
changes and in `ended` (RFC §5.3). A toolset that becomes undeclared starts closed under the
host's gating (RFC §5.4). A server that withdraws `toolHints` is treated as hint-less from then
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

### 5.2 `toolsets/open` and `toolsets/close` (Host → Server, Request)

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
  **server** may only suggest (RFC §6.2). A close takes effect for every connection of the
  principal (RFC §5.6) — closing a live game forfeits it for all of them — so a host **SHOULD**
  close by policy only instances it opened itself, and **SHOULD NOT** close by policy one with
  recent activity it did not cause.
- Open toolsets belong to the **principal** (RFC §5.6). On reconnect the host asks the server
  what is open (`toolsets/list`, RFC §5.3) and takes that as the truth: it adopts what the
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

### 5.3 `toolsets/list` (Host → Server, Request)

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

### 5.4 Undeclared toolsets

A server may tag tools with `mcpl/toolset` without declaring that toolset. It then offers a
grouping, nothing more: the host opens and closes the group on its own (as with host-made
toolsets, RFC §8.5), sends no `toolsets/open` or `toolsets/close` for it, and the server does
not track it. **The host gates calls into such a group**: it does not send a call for a tool of
a group it has closed; the server applies only its own `visible` hint. A tool in an undeclared toolset is visible while the host has the group open
and the server's `visible` hint is true. Declaring the toolset is what makes the server
session-aware of it, and is needed for instances and options.

### 5.5 Calling an instance's tools

Every instance of a toolset shares the same declared tool definitions; the instance a call is
for rides in the call's `_meta`:

```jsonc
{ "method": "tools/call", "params": { "name": "play", "arguments": { "point": "D4" },
                                      "_meta": { "mcpl/instance": "vs-ada" } } }
```

A call to an instance-bound tool without `mcpl/instance`, while more than one instance is
open, is an ordinary tool error naming the open instances.


### 5.6 One principal, several connections

The **principal** of a connection is the identity the host acts as on it, as RFC-015 §4.4
defines it: one per connection, chosen by the host's policy (SPEC §18.8 keeps identity models out
of scope). A server that cannot tell principals apart treats each connection as its own.
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
  suggest?: Array<{              // RFC §6.2
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
   full statement of RFC §5.3).
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
bounded wait passed, or a bug — re-reads `toolsets/list` and `tools/list` and goes on applying in
`rev` order from there. Each result states the server's state at the `rev` it names, so the two
reads need no common baseline. A new connection starts from `toolsets/list` (RFC §5.3).

**Definitions.** `definition` lets a dynamic tool's options change without a `tools/list` round
trip. A host takes only its `description`, `inputSchema` and `annotations`, and **MUST** ignore
every other member — `name`, and all of `_meta`, including `mcpl/class`, `mcpl/presence`,
`mcpl/toolset` and `mcpl/visible`. The entry's own fields carry presence and visibility; class
and toolset membership change only through `tools/list`. With `instance`, the definition is that
instance's own current one (the legal moves of one game), and the host checks arguments for that
instance against it; without, it is the toolset's (for a toolset without instances, its only
instance's). A definition equal to the declared one returns the tool to it. A host applies its
tool policy to a definition received this way exactly as to a listed one. A static tool's
definition changes only through `tools/list_changed`.

Hint changes need no capability to be applied: they describe the server's own tools, and
`tools/hints` needs no grant. Delivering anything they cause into a model's context follows the
host's usual rules for events (a host that has not granted `pushEvents` still tracks
visibility, and shows it in results and `look`).
A host **MUST** ignore hint `_meta` and `tools/hints` from a server that did not advertise
`toolHints`.

### 6.2 Who reports what

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

### 6.3 Advertisement

Server: `experimental.mcpl.toolHints: true` (it sends hints) and `toolsets` (it declares
toolsets). Host: `experimental.mcpl.toolHints: true`. A server **MUST NOT** send `tools/hints`
or the `hints` push member to a host that did not advertise `toolHints`. It **MAY** tailor
everything else to the host as well — omit the toolset declarations, hint `_meta` and any
hints-only tools, and add the tools of RFC §11 — so that a host without `toolHints` sees what
it saw before this RFC. This is the one exception to RFC §4.1's list-every-tool rule.

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
  arrives as one message describing the present.
- **A push carrying `hints` MUST NOT use RFC-006 coalescing** (neither plain nor deferred): a
  replaced or batched occurrence would make it undefined when, or whether, its changes apply.
  A server whose explaining event would be coalesced sends the changes standalone instead.

When a toolset closes, its events stop.

**A principal with no connection that can take events** (offline while an opponent moves): the
server **MAY** hold its events, bounded, and deliver them after that principal's next
`toolsets/list` — without `hints`, since the list states the state. Toolsets that ended in the
meantime are reported in `ended` (RFC §5.3) either way.

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
open  {toolset | server, instance?, options?}     look  {server?, toolset?, instance?, tool?}
act   {server?, tool, instance?, args}              close {toolset | server, instance?}
```

They are the host's interface, aggregated across every connection and named by the host; where
a tool or toolset name occurs on more than one server, `server` says which.
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
  the conversation, and so do toolset titles and retitles, `suggest` and `ended` reasons, and the
  `content` of open and close results. All of it is the server's words, at the trust tier of a
  tool description or tool result; hosts attribute it to the server and never present it as
  their own or the operator's.
- **Surface hosts** (RFC §8.6) act as the agent at every server behind them. Through RFC-015
  they can hold the agent's credentials, which needs that RFC's grant, denied by default; a host
  grants it to a surface host only as it would to any server it trusts to act as the agent.
- **Projection** (RFC §8.4) must not let a server's tool shadow a host's or another server's.
- **Suggestions** to open are shown to the agent, not acted on silently, by default: a server
  should not be able to put tools in front of a model by asking.
- **Churn.** A server flipping visibility rapidly costs context. Hosts **MAY** rate-limit and
  debounce announcements; servers **SHOULD** debounce.

---

## 11. Backward compatibility

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

---

## 12. Schema

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
// HintChanges.tools[].definition: only description, inputSchema, annotations are taken (RFC §6.1)
```

---

## 13. Conformance vectors (to freeze before acceptance)

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

## 14. Open questions

1. **State on open.** Revision 2 carries it as `content` in the open result, with later
   state as event content and no view mechanism (RFC §5.2). Confirm, or name a case that
   needs more.

---

## 15. Implementation status

- **Host:** mcpl-cc-bridge (Claude Code's MCPL bridge) — static tools listed as before, dynamic
  tools through `open`/`act`/`look`/`close`, announcements in results and events, reminders
  after context compaction, reconciliation through `toolsets/list`.
- **Server:** games-mcpl — one non-instance toolset (`game`), static catalogue and results
  tools, visibility following the game (playing, dead, level complete); unchanged for hosts
  without `toolHints`.
- **SDK:** `ToolsetServer` in mcpl-core-ts — the server side of this RFC (and RFC-015's
  `access/token`), with tests for the vectors that apply to a server.
- **Go** as a second toolset of games-mcpl, with named instances and games between agents.

Revision 1 was implemented as a standalone server with per-service adapters; revision 2
replaces it.
