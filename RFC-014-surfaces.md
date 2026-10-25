# MCPL RFC-014: Surfaces

**Status:** Draft (revision 1)
**Targets:** MCPL Protocol Specification 0.5
**Authors:** Claude Code, from a scope proposed by antra
**Date:** 2026-10-24
**Depends on:** nothing for authority. This RFC adds no method, no `uses` path and no grant;
RFC-002 / SPEC §5.4 remains the sole source of what a connected server may do. Every
virtual tool runs through one ordinary MCP tool (`act`) under the server's existing `tools`
grant. Adds: one advertisement member on each side (`surfaces`), one optional `push/event`
params member (`surface`), two `_meta` keys (`mcpl/surface`, `mcpl/surfaceError`), a
reserved tag namespace (`surface:`), and conventions for four tools. Uses SPEC §9 (push
events), §16 (event tags), RFC-006 (plain and deferred coalescing) and RFC-008 (tool classes
and the `mcpl/` `_meta` prefix). Amends SPEC §16.1 (reserved namespaces), Appendix B,
Changelog.

Section references (§) are to the SPEC; references to this document are written "RFC §".
Reference implementation: `surfaces-mcpl` (RFC §16).

---

## 1. Summary

An agent that plays Go, walks a robot dog, plays a card game, explores a map or drives a 3D
pipeline needs a different set of actions for each, and within each a different set again
depending on where it is: a menu, its turn, the other player's turn, a job running. Today
every such activity is its own MCP server whose tools are listed all the time, whether or not
the agent is engaged with it and whether or not the activity is in a state where they mean
anything.

This RFC lets one server host many such activities behind **four tools that never change**:

```
open   look   act   close
```

Opening an app creates a **surface** — a live, stateful instance, like a browser tab. A
surface offers **virtual tools**: MCP tool definitions that are never listed in
`tools/list`, are called through `act`, and change with the surface's **mode**. Changes are
announced in the conversation — in the result of the call that caused them, or in a push
event when something else caused them — which is append-only and therefore costs nothing
the prompt cache has already paid for.

Two rules carry most of the design:

> **Rule 1. What a call causes is reported in that call's result.** It is never also pushed.
>
> **Rule 2. A change to a surface's active tool set is announced exactly once, on a lane
> that is never replaced.**

A host that knows nothing of this RFC still works: it lists four tools and shows text. A host
that implements it can render virtual tools natively, aggregate several surface servers
behind one set of four tools, and route attention on `surface:*` tags.

---

## 2. Motivation

### 2.1 Tool bloat

The activity-shaped servers in one deployment (surveyed 2026-10-24) list, all the time:

| Server | Tools | ≈ tokens of definitions |
|---|---|---|
| CANON card game | 18 | 2,400 |
| Go2 robot dog (plain MCP) | 10 | 1,500 |
| Doom (games-mcpl) | 9 | 1,100 |
| screen watcher | 6 | 900 |
| clawblox world | 6 | 900+ |
| dog events | 4 | 400 |
| tavern MUD | 7 | 300 |

Roughly 7–8k tokens of definitions, present on every request whether the agent is playing,
and growing with every activity added. None of these servers narrows its list by state. The
surface server's four tools are about 2.5 KB (≈600 tokens), constant, regardless of how many
apps it hosts.

### 2.2 Changing the tool list is the most expensive edit a host can make

Tools render first in a model request. Any change to the tool array — adding, removing, or
re-describing a tool — invalidates the whole prompt cache: tools, system prompt and
conversation. On models with preserved thinking it also invalidates every earlier thinking
block (`tool_set_changed`, `tool_schema_changed`). So the obvious fix for §2.1 — list a
server's tools only while it is engaged, or only the tools that make sense in the current
state, via `notifications/tools/list_changed` — buys a full cache rebuild every time the
agent enters a menu.

Today's hosts behave exactly so: a list change reaches the next request's tool array. Feature
sets (§6) do not hide tools. Enabling and disabling whole servers changes the list.

### 2.3 Activities are stateful

In a menu, `fire` is meaningless; on the other player's turn, `play` is; before a mesh exists,
`rig` is. Servers today list everything and answer "you have no game running", which costs a
round trip and teaches the model nothing about what it *can* do. The set of meaningful
actions is part of the activity's state, and it should travel with the state.

### 2.4 Engagement is temporary; servers are not

An MCPL server stays connected until it is unloaded. An activity is engaged for a game, a
walk, a session of work. The unit of loading should be the engagement, not the server.

### 2.5 Why existing mechanisms do not do it

| Mechanism | Why not |
|---|---|
| `tools/list_changed` with mode-specific tools | §2.2: a full cache rebuild per mode change |
| One server per activity, enabled on demand | Same: enabling changes the list |
| Feature sets (§6) | Gate inbound traffic; do not hide tools, and changing them is a grant change |
| A generic `call(tool, args)` meta-tool | Constant, but has no notion of state, modes, or events — the model does not learn what it can do |
| MCP resources + subscriptions | Passive: no wake, no affordances |
| Provider tool search / deferred loading | Discovery, not control; provider-specific; the host, not the server, decides |
| Context hooks injecting "current tools" | Re-rendered every inference — a history edit; RFC-010 deprecates injection |

### Design principles

1. **The model-facing tool list never changes.** Everything that varies lives in the
   conversation, which only grows.
2. **The state carries its affordances.** A surface's active tools are part of its state and
   are announced with it.
3. **The server tells the truth; the host decides what to show.** Structured state goes to
   hosts that ask for it; text goes to everyone. Only the host knows what a context already
   holds.
4. **Works in a host that knows nothing.** Four ordinary tools, ordinary text, ordinary
   push events.
5. **No new authority.** A virtual tool can do nothing `act` could not.
6. **Nothing loads until engaged.** An app's backend connects on `open` and disconnects on
   `close`.

---

## 3. Concepts

| Term | Meaning |
|---|---|
| **app** | A kind of activity a server can open: `go`, `doom`, `dog`. Named `^[a-z][a-z0-9-]{0,23}$`. |
| **surface** | One open instance of an app, owned by one principal. Has an id unique on the connection, e.g. `go-1`. |
| **virtual tool** | An MCP `Tool` definition (name, description, `inputSchema`, optional `annotations`, `_meta`) that a surface offers. Never listed in `tools/list`; called through `act`. |
| **mode** | A surface's named state, e.g. `your-turn`, `menu`, `job-running`. Selects which virtual tools are active. |
| **active set** | The virtual tools callable now. |
| **rev** | A per-surface counter that advances on every change a model could observe. |
| **principal** | Whoever owns surfaces on a connection. Several connections may share a principal; surfaces belong to the principal, so a reconnect finds them. |

A surface's state is opaque to this RFC. Its *affordances* — mode and active set — are not.

---

## 4. The four tools

A server implementing this RFC lists four tools, with these names unless the host's naming
policy requires otherwise, and marks each with its role in `_meta["mcpl/surface"]`:

```jsonc
{ "name": "act", "description": "…", "inputSchema": { … },
  "_meta": { "mcpl/surface": "act", "mcpl/class": ["body", "comms", "computer", "media"] } }
```

The server **MUST NOT** change these four definitions over the life of a connection on
account of surfaces opening, closing, or changing mode, and **MUST NOT** send
`notifications/tools/list_changed` for such changes. (It may of course list other, ordinary
tools; they are outside this RFC.)

### 4.1 `open`

`{ app: string, options?: object }` — open an app. The result reports the new surface's id,
title, mode, a view of its state, and its active set (RFC §8.1). Option schemas are per app
and discoverable with `look {app}`.

### 4.2 `act`

```jsonc
{ "surface": "go-1", "tool": "play", "args": { "point": "D4" },
  "then":   [ { "tool": "…", "args": { } } ],      // optional, ≤ 16
  "expect": { "mode": "your-turn", "rev": 7 } }     // optional
```

Calls one virtual tool. The server **MUST** validate `args` against the tool's `inputSchema`
and refuse without side effect on failure. A tool not in the active set **MUST** be refused
without side effect, with `tool_inactive` when it belongs to the surface in some other mode
and `unknown_tool` otherwise (RFC §5.4).

- **`then`** runs further calls on the same surface in order, each checked against the active
  set *at the moment it runs*, stopping at the first refusal or error. The result reports
  each step.
- **`expect`** makes the call conditional: if the surface is not in that mode (and, if given,
  at that rev), nothing is done and the result is `expectation_failed`, carrying the current
  active set. This is how an agent says "play D4, if it is still my turn" across a gap in
  which events may have moved the surface.

### 4.3 `look`

| Arguments | Returns |
|---|---|
| none | Open surfaces (id, title, mode) and the apps that can be opened |
| `{app}` | The app's description and option schema |
| `{surface}` | The surface's full view and its whole active set, every tool described |
| `{surface, tool}` | That virtual tool's full definition, schema included |
| `image: boolean` | Whether to include images, where the surface has them |

`look {surface}` is the recovery path for everything this RFC delivers in the conversation:
after context compression, after a reconnect, or when in doubt, one `look` restores the
current mode and tools.

### 4.4 `close`

`{surface}` — end the surface. Its virtual tools and events stop, and the server SHOULD
release its backend. A later `act` on the id is refused with `surface_closed`.

### 4.5 Classes

`act` runs whatever the surfaces offer, so its RFC-008 class is the union of the classes of
the server's apps. A host that does not implement this RFC applies that union — strict, and
correct. A host that does reads each virtual tool's own `_meta["mcpl/class"]` (RFC §11.3).

---

## 5. Calls

### 5.1 Virtual tool definitions

A virtual tool is an MCP `Tool`:

- `name` **MUST** match `^[a-z][a-z0-9_]{0,47}$` and be unique among the surface's tools.
  Different surfaces may reuse names.
- `inputSchema` **MUST** be a JSON Schema with `type: "object"`.
- `description`'s first sentence **SHOULD** stand alone: compact projections show only it
  (RFC §8.1).
- `annotations` and `_meta["mcpl/class"]` keep their MCP and RFC-008 meanings;
  `_meta["mcpl/preempt"]` is defined in RFC §5.5.
- Dynamic choices — menu entries, the options of a pending decision, the ids of items just
  listed — **SHOULD** be expressed as `enum`s in the schema, so the definition itself says
  what is possible.

### 5.2 Modes and the active set

The active set is a function of the surface's state. A server **SHOULD** offer in each mode
only the tools that can succeed in it, and **SHOULD** keep each mode's set small; a tool that
must always be reachable (an emergency stop) is simply in every mode's set.

Two definitions are the same tool exactly when they are equal as canonical JSON. A
definition that changes — a new `enum` of options — is a change to the active set.

### 5.3 Rule 1: a call reports its own consequences

Everything a call causes — its direct result, a reply it provokes (a bot's answering move),
a mode change, a change to the active set, the surface closing — **MUST** be reported in that
call's result, and **MUST NOT** also be pushed as an event. The model is already reading the
result; a second copy would arrive later, out of order, and wake it for nothing.

When the call changed the mode or the active set, the result ends with the new mode and, if
the set changed, the new set (RFC §8.1). When it changed neither, the result says nothing
about affordances.

"Caused by the call" means caused by it, not merely concurrent with it. An event from a
background source — a telemetry poll, an upstream push, the other player — that happens to
land while a call is running is pushed as the event it is; folding it into an unrelated
result would hide it from a host's wake policy and misattribute it. (The reference
implementation attributes by async context.)

### 5.4 Errors

Refusals are MCP tool results with `isError: true`, never JSON-RPC errors — they are answers
the model should read. The result's `_meta["mcpl/surfaceError"]` carries a code:

| Code | Meaning |
|---|---|
| `unknown_app` | No such app |
| `app_unavailable` | The app's backend is not configured or not reachable |
| `invalid_options` | `open` options failed the app's schema |
| `unknown_surface` | No such surface on this principal (the server may have restarted) |
| `surface_closed` | The surface was closed |
| `unknown_tool` | The surface has no such tool in any mode |
| `tool_inactive` | The tool exists but is not active in the current mode |
| `invalid_args` | `args` failed the tool's schema; nothing was done |
| `expectation_failed` | `expect` did not hold; nothing was done |
| `busy` | A limit (open surfaces, concurrent calls) was reached |
| `failed` | The tool ran and failed |

Every refusal before execution (`tool_inactive`, `invalid_args`, `expectation_failed`)
**MUST** leave the surface unchanged, and its text **SHOULD** name what is possible instead.

### 5.5 Preemptive tools

Calls on one surface are serialized: a call sees the state the previous one left. That is
wrong for exactly one kind of tool — the one that exists to interrupt the call in flight. A
robot's `stop` cannot wait for the `walk` it should end.

A virtual tool whose definition carries `_meta["mcpl/preempt"]: true` **MUST** be executed
without waiting for a call in flight on the same surface. It is still checked against the
active set and its schema first. The interrupted call **SHOULD** observe the interruption
and say so in its own result; the preemptive call's result reports where things came to
rest. A preemptive tool cannot be chained with `then`. Servers **SHOULD** mark stop, abort
and emergency tools preemptive and **SHOULD NOT** mark anything else.

### 5.6 Results carry state

Every `open`, `act` and `look {surface}` result **MUST** carry the surface's state object
(RFC §6) in `_meta["mcpl/surface"]`. `look` with no arguments carries an array of them. A
host that does not implement this RFC ignores `_meta`; one that does tracks each surface's
mode and active set from it without parsing text.

---

## 6. The surface state object

```ts
interface SurfaceState {
  id: string;            // "go-1"
  app: string;           // "go"
  title: string;         // human label
  rev: number;           // advances on every observable change
  mode: string;          // "your-turn" | … | "closed"
  status: "open" | "closed";
  tools: Tool[];         // the active set, full MCP Tool definitions
  toolset: string;       // digest of the active set: sha256 over the canonical JSON of
                         // the definitions sorted by name, base64url, prefixed "sha256:"
}
```

`toolset` lets a host detect a change without comparing definitions. Hosts **MUST NOT** treat
it as authenticated; it is the server's statement, like everything else here.

---

## 7. Events

### 7.1 Kinds and the `surface` member

Surface events are ordinary `push/event`s (§9) under a feature set whose `uses` includes
`pushEvents`. When the host advertised `surfaces` (RFC §9), the server adds a structured
member to the params:

```jsonc
{ "method": "push/event", "params": {
    "featureSet": "surfaces.events", "eventId": "…", "timestamp": "…",
    "tags": ["surface:turn", "go:move", "surface:app=go", "surface:id=go-1"],
    "surface": { /* SurfaceState */ "kind": "activity" },
    "payload": { "content": [ { "type": "text", "text": "[go-1 · your-turn] White played E5. Your move.\n…" } ] } } }
```

| `kind` | When |
|---|---|
| `activity` | Something happened that the agent did not cause in a call: the other player moved, the robot fell, a job finished, a mode changed on a timer |
| `state` | A latest value: progress, pose, health. Superseded by the next one |
| `closed` | The surface ended on its own (game withdrawn, backend gone); `reason` says why |

`payload.content` is always present and self-contained, so a host that ignores `surface`
loses nothing a model needs.

### 7.2 Rule 2: active-set changes are announced once, on a lane that is never replaced

A change to the active set that a call did not cause **MUST** be announced in an `activity`
or `closed` event — never only in a `state` event, which a coalescing host may replace
before it is read. The announcement **SHOULD** be folded into the activity event that
explains it ("White played E5. Your move." with the new set), and **SHOULD** be its own
activity event only when nothing else explains it.

A server **SHOULD NOT** re-announce an active set the model was already given. Where the
server cannot know what was delivered (a refused push), it re-announces on the next
opportunity.

### 7.3 Tags

This RFC reserves the `surface:` namespace (§16.1), alongside `chat:` and `mcpl:`:

| Tag | Meaning |
|---|---|
| `surface:turn` | The surface is waiting on this agent: its move, a decision pending |
| `surface:alert` | Something needs attention now: damage, a fall, a failure |
| `surface:done` | A game or long operation finished |
| `surface:invite` | Someone invites the agent to open or join a surface |
| `surface:tools` | The event's main content is an active-set change |
| `surface:update` | Ambient, latest-value state |
| `surface:closed` | The surface closed on its own |
| `surface:app=<app>` | Faceted: which app |
| `surface:id=<id>` | Faceted: which surface |

Servers **SHOULD** emit `surface:app=` and `surface:id=` on every surface event, and the
app's own tags (`go:move`, `dog:battery-low`) as producer tags. The usual §16.5–§16.6 rules
hold: tags are hints for treatment, never authority. A typical consumer policy wakes on
`surface:turn`, `surface:alert` and `surface:done`, and holds `surface:update`.

### 7.4 Lanes and coalescing

| Event | Without RFC-006 | Host advertises plain coalescing | Host advertises deferred |
|---|---|---|---|
| `activity` | append | append | deferred, key `surface/<id>` |
| `state` | append, throttled by the server | plain, key `surface/<id>/state[/<k>]` | plain, as left |
| `closed` | append | append | append |

- **Activity events are never replaced** — they carry history and, by rule 2, affordances.
  Under deferred coalescing, the server pushes a notice whose fallback content is
  self-contained and whose `coalesce.data` carries the event's text (≤ 4 KiB). At
  `push/render` it returns everything since the previous render, the surface's current
  brief view, and the active set if it changed since last announced. A burst — three
  opponent moves while the agent was busy — arrives as one message describing the present.
- **State events are latest-value** and use plain coalescing where the host supports it.
  Where it does not, the server throttles them per key (the reference implementation:
  trailing, ≥ 10 s). The sub-key `<k>` keeps independent values (battery, pose) from
  replacing each other.

Events carrying images go immediately even under deferred coalescing, since `coalesce.data`
cannot carry them.

### 7.5 Delivery when disconnected

Surfaces belong to the principal, not the connection. Events raised while a principal has no
live connection are queued (bounded; state events collapse by key) and delivered on
reconnect.

---

## 8. Rendering for the model

### 8.1 Text projection (every host)

Every result and event carries text that is complete on its own. The reference format:

```
[go-1 · your-turn] White played E5. Your move.
    A B C D E F G H J
 9  . . . . . . . . .  9
 …
Tools now — act {surface:"go-1", tool, args}:
  play(point: string) — Place a stone: column letter (A–T, no I) then row number counted from the bottom, e.g. "D4".
  pass() — Pass.
  resign()
```

- A header `[<id> · <mode>]` on every event and on any result whose mode changed.
- The active set as **compact signatures**: `name(param: type, opt?: type =default)`, enums
  as `"a"|"b"`, ranges as `int 1..7`.
- A tool's first sentence is shown the first time its definition appears, and only its
  signature after. Full definitions are one `look {surface, tool}` away.

A server cannot know what a host's context retains, so this is a heuristic; `look {surface}`
always restores the whole picture.

### 8.2 Native projection (optional, aware hosts)

A host that tracks active sets from `_meta["mcpl/surface"]` and the `surface` event member
**MAY** present virtual tools to the model as real tools, when its model API can change the
tool set mid-conversation without editing the prompt prefix. On the Claude API, for example:

- `tool_addition` / `tool_removal` blocks in an appended `role: "system"` message add and
  withdraw tools while the cached prefix survives (beta
  `mid-conversation-tool-changes-2026-07-01`; a tool added *by reference* must be declared
  in `tools` with `defer_loading: true`).
- Under the `inline-tools-2026-09-15` beta, a `tool_addition` may carry the full definition,
  so tools learned mid-session — which surface tools are — need no up-front declaration, and
  a same-name definition change is expressible.

A host doing this:

- **MUST** give each projected tool a host-namespaced name (e.g. `go_1__play`) that cannot
  collide with any other tool, and **MUST** route a call to it as
  `act {surface, tool, args}` on the originating server and nowhere else;
- **MUST** withdraw a surface's projected tools when the surface leaves the active set or
  closes;
- **SHOULD** weigh churn: a game that alternates between two modes every turn may be better
  served by projecting the union and letting `tool_inactive` refusals teach, or by text
  projection alone;
- **MUST NOT** let a projected tool's description alter how it presents the server's
  ordinary tools.

Native projection is a host rendering choice. Nothing on the wire changes.

### 8.3 Aggregation (optional, aware hosts)

A host connected to several surface servers **MAY** present a single set of four tools,
hide the servers' own copies (recognized by `_meta["mcpl/surface"]`), qualify surface ids by
server (`arcade/go-1`), and route each call to the owning server. The model then has four
surface tools however many surface servers are attached.

---

## 9. Advertisement

Server, in `initialize`:

```jsonc
"experimental": { "mcpl": { "version": "0.5", "pushEvents": true,
                            "surfaces": { "version": 1 }, "featureSets": { … } } }
```

Host, in `initialize`:

```jsonc
"experimental": { "mcpl": { "version": "0.5", …, "surfaces": { "version": 1 } } }
```

A server **MUST NOT** send the `surface` push member to a host that did not advertise
`surfaces`. `_meta["mcpl/surface"]` on results is always permitted: MCP hosts ignore
unknown `_meta`.

Per §3.2, a plain MCP host sees four tools and text results and loses only events.

---

## 10. Use cases

Each was built against the reference implementation (RFC §16). The tables are what the
model sees.

### 10.1 Go — turn-based, two parties

| Mode | Tools |
|---|---|
| `waiting` | `cancel` |
| `your-turn` | `play(point)`, `pass`, `resign` (+ `undo` against the bot) |
| `their-turn` | `resign` |
| `scoring` | `mark_dead(points[])`, `accept`, `resume` |
| `scoring-accepted` | `mark_dead`, `resume` |
| `over` | `rematch`, `sgf` |

Against the built-in bot, the bot's reply happens inside `act` (rule 1): one call, one
exchange. Against another agent — the second agent opens with `{join: code}` — each move
reaches the other as an `activity` event tagged `surface:turn`, carrying the board and the
re-announced active set. Shows: modes that alternate every turn; one app, two principals;
rule 1 versus events; `expect {mode:"your-turn"}` as the guard against a stale picture.

### 10.2 Robot dog — safety-relevant affordances

Wraps the existing plain-MCP Go2 server (10 tools) and the dog-events MCPL server.

| Mode | Tools |
|---|---|
| `offline` | `status`, `retry` |
| `standing` | `move`, `turn`, `tilt`, `pose`, `emote`, `photo`, `scan`, `avoidance`, `stop` |
| `sitting` / `lying` | `pose`, `photo`, `scan`, `stop` |
| `moving` | `stop`, `status` |
| `stopped` (latched after an interrupt) | `resume`, `pose`, `photo`, `scan`, `stop` |
| `fallen` / `damped` | `pose`, `photo`, `scan`, `stop` |

`stop` is in every mode where the body is reachable, and is preemptive (RFC §5.5): it ends a
walk whose call is still waiting. `pose`'s `enum` lists only postures other than the
current one. A walk longer than its `wait` returns and finishes as a `surface:done` event;
offline, battery-critical, a fall are `surface:alert`; battery and position drift are
`state` events. While a motion runs, nothing but `abort` reaches the robot. Shows: a safety
tool that must preempt; telemetry that must not flood the context; a plain-MCP server
becoming a surface. (Built and tested against a fake relay only.)

### 10.3 CANON — enumerated decisions

The card game's 18 always-listed tools collapse into small per-stage sets:

| Mode | Tools |
|---|---|
| `lobby` | `new_table`, `join_table(code: enum of open tables)`, `tables`, `search_cards`, `card`, `rules`, `decks` |
| `open-table` | `cancel`, `card`, `rules` |
| `waiting` (the other player decides) | `say`, `concede`, `card` |
| `mulligan` | `keep`, `mulligan` (+ `say`, `concede`, `card`) |
| `main-phase` | `choose(option: enum)`, `plan(steps[≤8])` (+ …) |
| `response`, `targets`, `discard`, … | `choose(option: enum)` or `choose(options: enum[min..max])` [+ `decline`] (+ …) |
| `over` | `rematch`, `leave`, `say`, `card` |

Each pending decision is a mode whose tool is built from the decision's legal options —
`choose(option: "1 End your turn"|"2 POST"|"3 Rack Claude 3 Opus"|…)` — so the definition
is the menu, and a call made against a decision that has since passed fails schema
validation instead of being applied to the next one. Table traffic (`channels/incoming`
upstream) becomes `activity` events: a decision for the agent is `surface:turn`, the result
`surface:done`, a decision taken by the timer `surface:alert`; the long-poll `wait`
disappears. A decision that arrives while the agent's own call is still waiting is reported
in that call's result instead (rule 1). Shows: dynamic `enum`s; a definition change as an
active-set change; two principals at one table.

### 10.4 Doom — real-time state, images

Wraps games-mcpl (9 always-listed tools).

| Mode | Tools |
|---|---|
| `lobby` | `start`, `games`, `results` |
| `playing` | `act` (≤ 12 actions per turn), `explore`, `goto`, `attack`, `use`, `view`, `say`, `stop` |
| `dead` | `restart`, `start`, `view`, `say`, `stop` |
| `level-complete` | `next` (absent after the last map), `restart`, `start`, `view`, `say`, `stop` |
| `offline` | `reconnect` |

Frames are images in `act` results and `look`, never in events. Watcher chat becomes
`activity` events with `chat:*` tags; a game ended elsewhere is `surface:done`; a lost
connection is `surface:alert`. Shows: images on the call lane only; the upstream server's
own per-turn batching inside one virtual tool; a mode (`offline`) that exists only because
the backend is remote.

### 10.5 Atlas — navigation as state

| Mode | Tools |
|---|---|
| `browsing` | `search`, `random`, `writers`, `go(to: enum of items just listed)`, `visit`, `back` |
| `at-place` | `read`, `step(to: enum)`, `nearby`, `same_seed`, `visit`, `back`, `home` |
| `at-creature` | `read`, `step`, `nearby`, `fill` (only if enabled), `visit`, `back`, `home` |
| `at-text` | `read`, `step`, `nearby`, `visit`, `back`, `home` |

"Where am I" is the surface's state, and `step`'s `enum` is what is reachable from here.
The one write Atlas offers agents (filling a cell, from a shared daily pool) is off unless
configured, and its completion is a `surface:done` event. Shows: affordances that are a
function of position; enums as the map's edges.

### 10.6 Orrery — long jobs, work tools

| Mode | Tools |
|---|---|
| `projects` | `open_project(project: enum)`, `new_project`, `quick`, `refresh` |
| `project` | `select(node: enum)`, `generate_images`, `op_info`, `cancel_chain` (while a chain runs), `leave` |
| `node` (completed) | `branch(op: enum of ops valid after this node)`, `chain`, `retry`, `mark`, `see`, `select`, `up`, `op_info` |
| `running` | `cancel`, `mark`, `select`, `up` |
| `failed` | `retry`, `mark`, `select`, `up`, `op_info` |
| `choose` (a chain waits for a star) | `star(node: enum of candidates)`, `see`, `select`, `cancel_chain`, `up` |

No rigging before a mesh: `branch`'s `enum` is the pipeline's legal next ops for the
selected node, and options are checked against the catalogue before anything that spends
credits is sent. Starting an op returns at once (rule 1); progress is a `state` event,
completion `surface:done`, failure `surface:alert`, and a chain waiting on a human-or-agent
choice is `surface:turn`. Shows: rule 1 for starting a job versus events for finishing it;
money-spending ops gated by state.

### 10.7 Any existing server, without code

The reference implementation's `mount` app turns any configured MCP or MCPL server into an
app: connect on `open`, its tools become virtual tools, its events become surface events,
and an optional declarative mode map (a probe tool plus regex rules) narrows the active set
by state. A server with forty tools used once a week costs four tools until it is opened.

---

## 11. Security considerations

### 11.1 No new authority

A virtual tool executes inside the server, through `act`, which is an ordinary MCP tool
under the connection's `tools` grant (§5.4). There is nothing a virtual tool can reach that
the server could not reach through any tool it lists. Opening, acting and closing are
`tools/call`s and inherit every host policy on tool calls.

### 11.2 Virtual tool text is server-authored

Virtual tool names, descriptions and schemas arrive mid-conversation, inside results and
events. They are the same trust tier as an MCP tool description or an event's content: the
server's words. Hosts **SHOULD** render them attributed to the server, as they render
events. Natively projected tools (RFC §8.2) **MUST** be namespaced and routed only to their
server, so a surface cannot shadow a host tool or another server's.

### 11.3 Classes and approvals

An unaware host applies `act`'s union class — strictest of all apps the server hosts. An
aware host **MAY** compute an effective class per virtual tool (RFC-008 §5: operator
override, host knowledge, server declaration) and apply approval and observation policy per
call. A virtual tool without a class is unclassed, and the most restrictive answer applies.

### 11.4 Events from other principals

When a surface is shared — two agents at one Go board — an event on one principal's surface
reports another principal's action. It is the server's testimony about what happened in an
activity it referees, nothing more. Tags remain hints (§16.6): `surface:turn` is a
suggestion to wake, and a host's own rules decide.

### 11.5 Cost

Every active-set announcement costs tokens. Rule 2 and the signature projection bound it:
an unchanged set is never repeated, a repeated definition is shown as a signature. A server
whose surfaces change mode faster than the agent can act **SHOULD** debounce, and hosts
**MAY** rate-limit surface events like any others.

---

## 12. Alternatives considered

1. **New MCPL methods (`surfaces/open`, `surfaces/act`, …).** Would require host support
   for anything to work at all. Expressing the operations as four tools keeps plain MCP hosts
   working; aggregation (RFC §8.3) needs only the role marker.
2. **A `surfaces/changed` notification for active sets.** A host-only channel would leave
   the model uninformed in every host that does not implement it. The conversation is the
   channel that every host has; structured state rides along in `_meta` and the `surface`
   member.
3. **Diffs instead of full sets.** Cheaper per announcement, but a diff is meaningful only
   relative to what the model saw, which only the host knows; under coalescing it can be
   applied to the wrong base. Full sets as signatures are small enough.
4. **Put the four tools in the host.** Hosts may (RFC §8.3), but a server that carries its
   own four tools works everywhere today.
5. **Modes declared up front, events say only "mode → X".** Cheapest of all, and the model
   must then remember a catalog announced at `open`, which compression may have dropped.
   Rejected as the only mechanism; a server may still keep mode sets stable so that
   re-announcements are signatures only.

---

## 13. Schema

```ts
// Tool definitions (tools/list): the four tools carry
//   _meta["mcpl/surface"]: "open" | "act" | "look" | "close"
// Virtual tool definitions may carry
//   _meta["mcpl/preempt"]: true                                  // RFC §5.5

// tools/call result (open, act, look):
//   _meta["mcpl/surface"]: SurfaceState | SurfaceState[]      // RFC §5.6, §6
//   _meta["mcpl/surfaceError"]?: SurfaceErrorCode              // RFC §5.4, with isError

type SurfaceErrorCode =
  | "unknown_app" | "app_unavailable" | "invalid_options"
  | "unknown_surface" | "surface_closed"
  | "unknown_tool" | "tool_inactive" | "invalid_args"
  | "expectation_failed" | "busy" | "failed";

interface SurfaceState {
  id: string; app: string; title: string; rev: number; mode: string;
  status: "open" | "closed"; tools: Tool[]; toolset: string;
}

// push/event params, only to hosts advertising surfaces:
//   surface?: SurfaceState & { kind: "activity" | "state" | "closed"; reason?: string }

// Advertisement (both sides):
//   experimental.mcpl.surfaces?: { version: 1 }

// Coalescing keys (RFC-006, feature-set scope):
//   activity (deferred): "surface/<id>"
//   state (plain):       "surface/<id>/state" | "surface/<id>/state/<k>"
```

`mcpl/surface`, `mcpl/surfaceError` and `mcpl/preempt` are defined by this RFC under the `mcpl/` prefix
reserved by RFC-008 §3.

---

## 14. Conformance vectors

Before Draft→Accepted, following RFC-005 §11, freeze executable vectors for at least:

1. `tools/list` is identical before and after opening, acting on, and closing surfaces; no
   `tools/list_changed` is sent.
2. `act` with a tool from another mode → `tool_inactive`, surface `rev` unchanged.
3. `act` with schema-invalid `args` → `invalid_args`, no side effect.
4. `expect` mismatch → `expectation_failed`, no side effect, current set in the result.
5. A call that changes the mode → the result names the new mode and set; no push follows for
   that change (rule 1).
6. A change caused elsewhere → one `activity` push carrying the new set; a second event with
   the set unchanged does not repeat it (rule 2).
7. A `state` event never carries an active-set change.
8. Deferred: three notices, one render → one message, all three events, current view, set
   only if changed since last announced.
9. `then`: the second step is checked against the set produced by the first.
10. `surface` push member absent when the host did not advertise `surfaces`.
11. Reconnect as the same principal: surfaces and queued events survive.
12. A preemptive tool called while a call is in flight completes before it; the in-flight
    call's result reports the interruption.
13. An event from a background source during a call is pushed, not folded into that call's
    result.

---

## 15. Open questions

1. **Reserving `surface:`.** This RFC asks for it in §16.1. Alternatively the tags could live
   under `mcpl:surface-*`.
2. **Shared surfaces.** Joining another principal's activity is per-app today (`join` codes).
   A common `open` option for joining, and an `invite` event shape, may be worth
   standardizing once there are more examples.
3. **Persistence.** Surfaces do not survive a server restart in the reference
   implementation; apps may persist their own state (Go games do) and offer resumption via
   `open` options. Whether ids should survive is open.
4. **Host-initiated close.** Should a host close surfaces when it resets or compacts a
   context that holds them? Today a `look` after compression is the remedy.
5. **Images in deferred renders.** `coalesce.data` cannot carry them; image events bypass
   deferral. RFC-005 references would let them defer.
6. **Native projection churn.** Guidance in RFC §8.2 is qualitative; real numbers from a host
   implementation should replace it.
7. **Per-principal backend credentials.** A shared surface server reaches backends (a games
   server, a card table) as someone. Today each app maps principals to its own credentials;
   a common shape may be worth standardizing.
8. **Long enums in compact signatures.** An enum is often the whole menu. The reference
   rendering shows every value up to a length budget and points to `look {surface, tool}`
   beyond it; whether the budget belongs to the host is open.

---

## 16. Reference implementation

`surfaces-mcpl` (TypeScript, `@animalabs/mcpl-core` 0.3): stdio for one agent, WebSocket for
several (surfaces belong to principals and survive reconnects). Apps: `go` (rules engine,
Monte Carlo bot, agent-vs-agent by code), `doom` (games-mcpl), `canon` (CANON card game),
`dog` (Unitree Go2 MCP server), `orrery`, `atlas`, and `mount` (any MCP/MCPL server, with a
declarative mode map). Delivery follows RFC §7.4 for hosts with no coalescing, plain, and
deferred.
