# MCPL RFC-007: Tool Lifecycle

**Status:** Draft (revision 2)
**Targets:** MCPL Protocol Specification 0.5
**Authors:** Claude Code, from a scope proposed by antra; revised after review
**Date:** 2026-09-29 (revision 1); 2026-09-30 (revision 2)
**Depends on:** RFC-002 / SPEC §5.4 for authority; **RFC-008** (tool classes) for the
class vocabulary used in narrowing, filtering, and the `comms` exclusion. Adds two methods,
`tools/lifecycle` (Host → Server, Notification) and `tools/observe` (Server → Host,
Request), and two capability paths, `toolLifecycle.observe` and `toolLifecycle.inputs`.
Amends SPEC §4 (message flow), §5.1–5.2 (advertisement), §6.2 (`uses` vocabulary), §10
(new §10.9), §13.1 (trust model), §14.5 (clarification only), Appendix B.4 (enums),
Changelog. Interacts with §5.3 (initial policy), §10.5 (`inference/lifecycle`), §10.7 (loop
prevention), §13.2 (audit), §14.5 (narrowing, delivery).

> **Revision 2 note.** Review of revision 1 found three holes and a gap in its privacy
> story. All fixed here without changing the two-method, two-path shape:
> - **No filter now means metadata only** (RFC §5.1, §6.4). Revision 1 sent all granted
>   arguments until the server's filter arrived, and again after every reconnect.
>   Arguments are now sent only when a filter rule asks for them.
> - **`toolCallId` is host-unique** (RFC §3). Revision 1 used the model's id as the pairing
>   key; models that emit `call_0`, `call_1` collide across inferences. The host now
>   guarantees uniqueness per connection, minting when it must.
> - **Conversation and class are narrowing and filter keys** (RFC §4.3, §6.1). Revision 1
>   narrowed and matched on tool name only, and put conversation scoping on the receiving
>   server.
> - **Privacy is a host matter, keyed on RFC-008 class** (RFC §4.3, §5.4, §10). Revision 1
>   asked operators not to grant `inputs` for messaging tools. Now: `comms` arguments are
>   never sent, `inputs` is never unconditional, unclassed tools never carry arguments, and
>   the counterparty-consent gap is named.
> - **A `pending` phase** for calls waiting on host approval (RFC §3), metadata only.

Section references (§) are to the SPEC; references to this document are written "RFC §".

---

## 1. Summary

A server can learn **when** the agent is thinking (`inference/lifecycle`, §10.5) and **what
the agent does with the server's own tools** (`tools/call`). It cannot learn what the agent
does with anyone else's tools. There is no MCPL surface for "the agent just started a shell
command", "the agent is driving the mouse", or "that file write failed".

This RFC adds **`tools/lifecycle`**, a metadata notification the host sends when a tool call
it executes starts and ends, gated by a new capability:

- **`toolLifecycle.observe`**: which tool, its class, which server provides it, when it
  started and ended, and whether it failed. No arguments, no results.
- **`toolLifecycle.inputs`**: additionally, the call's **arguments**, bounded, narrowed per
  tool or class, and sent only when the server asks for them field by field. Denied by
  default, never unconditional, and never for `comms` tools.

**Tool results are never carried.** No capability path in this RFC reaches them.

It also adds **`tools/observe`**, a request with which a server asks the host to filter
what it sends: **which calls** to report, and **which argument fields** to include for each.
The host applies the filter on its side, so data the server does not want never leaves the
host. A filter is interest, not authority: it can only narrow what the grant allows, and
without one the host sends metadata only.

The shape follows §10.5: best-effort, paired by a stable id, no content beyond what the
grant names. It follows §5.4 too: observation of metadata and observation of arguments are
separate paths, separately granted, and every path maps to a method.

## 2. Motivation

- **Embodiment.** A server that gives the agent a body (an on-screen avatar, a robot, a
  desk light) wants the body to reflect what the agent is doing: open a laptop during
  computer use, hold a cube while a 3D tool runs, look at the terminal during a shell
  command, point at the screen location the agent is clicking. §15.2's embodiment server
  can already show *thinking*. It cannot show *acting*, because acting happens in other
  servers' tools. The pointing case needs arguments (coordinates, target window), not just
  the tool name.
- **Activity surfaces.** Status lights, session viewers, and presence indicators ("busy:
  running tests") need a tool-level view of the turn. Turn-level `started`/`completed`
  cannot distinguish a model that is writing from one that is waiting on a ten-minute build,
  or on a human's approval.
- **Attention-aware servers.** A server holding notifications for the agent may want to wait
  out a long tool call rather than interrupt it, or to learn that a call it depends on
  failed.

**Why existing surfaces don't serve this.**

- `inference/lifecycle` is metadata-only by construction and "MUST NOT carry … tool
  arguments or results" (§10.5). Widening it would make the `inferenceLifecycle` grant
  carry content, reversing RFC-002's split.
- `context/afterInference` was removed in 0.5.0 as the broadest content-exfiltration
  surface in MCPL (§10.5, RFC-002 §3.5). The `tool_use` blocks were inside it, alongside
  the user's message and all the prose. Restoring any part of it is not on the table.
- `channels/outgoing/*` is per-surface and carries agent speech, not tool activity.

**What implementations do today.** Where the host exposes an internal event stream to
in-process code (for example agent-framework's `onTrace`), a server author writes a
host-specific extension that runs **inside the host process** and forwards tool events to
their server out of band. That works, and it is the problem: an in-process extension holds
the host's full authority, sits under no grant, is tied to one host's language and
internals, and cannot be reached over a network transport. The data the extension needs is
small and structured. A protocol method with a narrow grant is a strictly better container
for it.

RFC-002 §3.1 anticipated this shape when it struck `channels.observe`: "If a host→server
… visibility surface is introduced later … it should arrive with a named method and a grant
defined against it." This is such a surface.

### Design principles

1. **Metadata by default, content by request and grant.** `observe` carries no content.
   `inputs` is a separate path, denied by default, never unconditional, and arguments travel
   only for fields a server asked for.
2. **Results never.** Tool output is where file contents, command output, and fetched pages
   live. There is no path for it here, and a future one would be a separate RFC.
3. **Minimize at the source.** A server says which calls and which fields it uses, and the
   host drops the rest before sending. What a server never receives, it cannot leak.
4. **Interest never widens authority.** The grant and the host's narrowing bound delivery.
   A server's filter only narrows inside them.
5. **Privacy is the host's job, keyed on what a tool does.** The host, not the operator's
   memory of tool names and not the observing server, decides that a messaging tool's
   arguments are someone's private conversation. RFC-008 gives it the key.
6. **Every path maps to a method.** Both new paths gate methods (RFC-002 §3.1: a grant with
   no method is decorative).
7. **Best-effort, like §10.5.** An unacknowledged notification with pairing expectations
   and no delivery guarantee. Consumers keep timeouts.
8. **Additive.** A server that does not advertise `toolLifecycle` receives nothing new. A
   host that does not advertise it is unchanged.

## 3. `tools/lifecycle` (Host → Server, Notification)

```jsonc
{
  "jsonrpc": "2.0",
  "method": "tools/lifecycle",
  "params": {
    "toolCallId": "toolu_01A9…",
    "inferenceId": "inf_xyz",
    "conversationId": "conv_123",
    "tool": "computer--click",
    "class": ["computer"],
    "serverId": "computer",
    "serverTool": "click",
    "phase": "started",
    "input": { "x": 812, "y": 440 }        // only with toolLifecycle.inputs (RFC §5)
  }
}
```

```jsonc
{
  "jsonrpc": "2.0",
  "method": "tools/lifecycle",
  "params": {
    "toolCallId": "toolu_01A9…",
    "inferenceId": "inf_xyz",
    "conversationId": "conv_123",
    "tool": "computer--click",
    "class": ["computer"],
    "serverId": "computer",
    "serverTool": "click",
    "phase": "completed",
    "isError": false,
    "durationMs": 380
  }
}
```

| Field | Type | Phases | Description |
|---|---|---|---|
| `toolCallId` | `string` | all | Pairs a call's phases. **Unique across every event the host sends on this connection** (below). |
| `inferenceId` | `string` | all | The inference whose output requested the call. Same identifier space as §10.5. |
| `conversationId` | `string` | all | As §10.5. |
| `tool` | `string` | all | The tool's name as presented to the model, including any host namespacing. |
| `class` | `ToolClass[]` | all | The tool's effective class (RFC-008 §5). Empty array for an unclassed tool. |
| `serverId` | `string` | all | OPTIONAL. The host's identifier for the connection providing the tool, or a stable alias for it (RFC §10). Absent for tools the host implements itself. |
| `serverTool` | `string` | all | OPTIONAL. The providing server's own name for the tool (before host namespacing). Present iff `serverId` is. |
| `phase` | `ToolPhase` | all | `"pending" \| "started" \| "completed" \| "failed" \| "aborted"` |
| `input` | `object` | `started` | OPTIONAL. The requested fields of the call's arguments. Only under `toolLifecycle.inputs`, subject to RFC §5 and RFC §6. |
| `inputAltered` | `boolean` | `started` | OPTIONAL. `true` iff the host shortened, redacted, or removed anything in `input` beyond the server's field selection (RFC §5.2). |
| `inputWithheld` | `boolean` | `started` | OPTIONAL. `true` iff the connection holds `toolLifecycle.inputs`, the server's filter requested arguments for this call, and they were not sent (RFC §5.1). |
| `isError` | `boolean` | `completed` | OPTIONAL. The tool returned a result marked as an error. |
| `durationMs` | `integer` | terminal | OPTIONAL. Host-measured wall time from `started` to terminal. Excludes time spent `pending`. |

**`toolCallId` is the host's.** The host MUST ensure that no two calls it reports on a
connection share a `toolCallId` for the lifetime of the connection. Where the model's own
call identifier (the `tool_use` id) is unique, the host SHOULD use it as is; where it is not
(models that number calls per response), the host MUST mint one. A host that reports the
same call on other surfaces (approval prompts, hook events, audit) SHOULD use the same
identifier there, so that a server can correlate. Consumers key on `toolCallId` alone.

**Phases.**

- **`pending`**: OPTIONAL. The host has a call it will not execute until a gate it controls
  clears, typically a human approval. Metadata only: never `input`. A host MAY omit
  `pending` entirely. A call that is refused after `pending` produces `aborted`. A call the
  host refuses before emitting anything produces no events (approvals as authority: RFC
  §16).
- **`started`**: the host has begun executing the call. For a gated call, this follows
  `pending` once the gate clears.
- **`completed`**: the tool produced a result, successful or not. An error *result* is
  `completed` with `isError: true`.
- **`failed`**: the host could not obtain a result: the providing connection closed, the
  call timed out, the host's own dispatch failed.
- **`aborted`**: the call was cancelled before a result, for example because the turn was
  interrupted, or refused after `pending`.

`pending` and `started` are **opening** phases; `completed`, `failed`, and `aborted` are
**terminal**. A call has at most one of each opening phase, in that order, and exactly one
terminal is attempted (RFC §7.3).

**It MUST NOT carry tool results or message content.** No `result`, `output`, or `content`
field exists, and no field carries text the model wrote or the user sent. The only content
this method can carry is `input`, under its own grant.

## 4. Capability paths and the grant

### 4.1 Paths

Two paths are added to the §6.2 vocabulary:

```
toolLifecycle.observe
toolLifecycle.inputs
```

- **`toolLifecycle.observe`** gates delivery of `tools/lifecycle` and acceptance of
  `tools/observe`. Without it, the host MUST NOT send `tools/lifecycle`, and MUST reject
  `tools/observe` with `-32002` (Capability denied).
- **`toolLifecycle.inputs`** gates the `input` member. Without it, the host MUST NOT include
  `input`. It has effect only together with `toolLifecycle.observe`: a grant holding
  `inputs` without `observe` delivers nothing, and hosts SHOULD emit a diagnostic when
  computing such a grant.

Per §5.4, the bare parent `toolLifecycle` grants neither leaf, and `toolLifecycle.*` grants
both paths — but see RFC §4.3: an `inputs` entry the host has not narrowed delivers no
arguments.

### 4.2 Advertisement

Servers and hosts advertise under `experimental.mcpl`, mirroring the paths (§5.1):

```jsonc
"toolLifecycle": { "observe": true, "inputs": true }   // or `true` for both leaves
```

A host MAY advertise `observe` without `inputs`. Advertisement is an input to the grant,
never an authorization.

### 4.3 Narrowing

Like per-channel narrowing (§14.5), **narrowing attaches to the grant entry** and is host
policy. A narrowing for either leaf is a set of terms over three keys; a call is inside the
narrowing when it satisfies every key the narrowing states:

- **tool name**: patterns over the model-facing `tool` name (`computer--*`,
  `workbench--bash`). Pattern syntax is host-defined, as for channels (RFC §17, open
  question 2).
- **class**: a set of RFC-008 classes the tool's effective class must intersect
  (`["computer", "shell"]`).
- **conversation**: patterns over `conversationId`, or a host-defined selector such as
  "conversations this connection participates in" (RFC §7.1).

Effects:

- A call outside the `toolLifecycle.observe` narrowing produces **no events** for that
  connection.
- A call inside the `observe` narrowing but outside the `toolLifecycle.inputs` narrowing is
  reported **without `input`**.

**`inputs` is never unconditional.** A host MUST attach a narrowing to every
`toolLifecycle.inputs` grant entry. An `inputs` entry with no narrowing — including one
produced by a wildcard such as `toolLifecycle.*` with no accompanying policy — is treated as
narrowed to **no tools**, and the host SHOULD emit a diagnostic at grant computation. This
is the RFC-005 §5 move: the widest form of the grant is not a thing an operator can produce
by omission.

**Class exclusions, regardless of narrowing.** Whatever the `inputs` narrowing says:

- A tool whose effective class includes **`comms`** never carries `input`. Its arguments are
  the agent's messages to, or what it read from, other people (RFC §10).
- An **unclassed** tool never carries `input` (RFC-008 §5.2).

Hosts SHOULD ship a default `inputs` policy that names the classes whose arguments are
ordinarily safe to observe (`computer`, `shell`, `files`, `web`, `media`, `body`) and leaves
`memory`, `notes`, and `control` to explicit operator choice. `comms` is not a choice.

Narrowing is evaluated per call, at emission, against the grant current at that moment
(RFC §4.5). A server's own filter (RFC §6) narrows further; it never widens.

### 4.4 Feature sets

A feature set that uses these methods declares the paths in `uses` as usual:

```jsonc
"body.activity": {
  "description": "Act out the agent's tool use",
  "uses": ["toolLifecycle.observe", "toolLifecycle.inputs"]
}
```

As §6.4 says, the declaration confers nothing. The grant decides.

### 4.5 Revocation

A denied capability behaves as if never advertised (§5.4). If `toolLifecycle.observe` is
revoked, or narrowed away from a tool, between a call's opening phase and its terminal, the
host MUST NOT deliver the terminal. The server's safety timeout (RFC §7.3) covers it. If
only `toolLifecycle.inputs` is revoked, calls already `started` are unaffected, since
`input` appears only on `started`.

Revoking `toolLifecycle.observe` discards the connection's filter (RFC §6.5).

## 5. Inputs

### 5.1 What is sent

`started` carries `input` when all of these hold:

1. the connection holds `toolLifecycle.inputs`, the call is within its narrowing, and the
   tool is not excluded by class (RFC §4.3);
2. the server has a filter in force, and the rule that matched this call requests arguments
   (RFC §6.1).

**With no filter, no arguments are sent.** A server that wants arguments asks for them. This
closes the window between grant and filter, on first connection and on every reconnect, in
which revision 1 sent everything the grant allowed.

`input` is the arguments the model supplied for the call, as the host will pass them to the
tool, reduced to the requested fields (RFC §6.3) and then bounded (RFC §5.2).

When the connection holds `toolLifecycle.inputs`, the matching rule requested arguments,
and they were not sent — narrowing, class exclusion, host policy, or a call too large to
bound meaningfully — the host sets `inputWithheld: true`. A server that lacks the grant, or
whose rule did not request arguments, never sees `inputWithheld`.

### 5.2 Bounds, truncation, redaction

Arguments can be large. A file write carries a whole file. Hosts MUST bound the serialized
size of `input` per notification. **The RECOMMENDED default bound is 16 KiB; hosts MAY
configure another.** The bound applies after field selection (RFC §6.3), so a server that
selects the fields it uses rarely meets it.

To meet the bound, or by policy, a host MAY:

- replace a string value with a prefix of it,
- replace a value it recognizes as a credential with a placeholder,
- remove object members or array elements.

The result MUST be a JSON object. If the host altered anything beyond the server's field
selection, it MUST set `inputAltered: true`. Field selection alone does not set it. The host
is not required to say what was altered.

A host that cannot produce a meaningful bounded `input` withholds it instead (RFC §5.1).

### 5.3 Inputs are not results

The host sends the arguments as requested by the model. It MUST NOT substitute, append, or
annotate anything learned from executing the call, such as a resolved path, an exit code,
or a fetched title. `isError` and `durationMs` are the only facts about the outcome this
method carries.

### 5.4 Whose data arguments are

Arguments to a `files` write are the agent's work. Arguments to a `shell` tool are the
agent's commands. Arguments to a `comms` tool are **a conversation with another person**:
the recipient, and what the agent said to them, or which of their messages it read. That
person is not party to the grant; the operator consented for the agent, not for them. MCPL's
answer for content that reaches a surface is per-channel and moderated, with the surface's
own server in the loop (§14.3, §14.5, RFC-002 §3.5). An observer reading `comms` arguments
would see that content with nobody in the loop. Hence the unconditional exclusion in RFC
§4.3, placed on the host rather than on operator advice.

`memory` and `notes` arguments are the agent's own, but they are the agent's *interior*
(recall queries, journal entries) and its drafts. They are excluded by default and may be
named by an operator who has a reason.

## 6. Server-requested filtering: `tools/observe` (Server → Host, Request)

A server tells the host which calls it wants reported and which argument fields it wants
for each. The host applies the filter before sending.

### 6.1 The request

```jsonc
{
  "jsonrpc": "2.0",
  "id": 21,
  "method": "tools/observe",
  "params": {
    "rules": [
      { "match": { "serverTool": "click" },   "input": ["x", "y", "target.window_id"] },
      { "match": { "class": "shell" } },
      { "match": { "class": "comms" }, "report": false },
      { "match": {} }
    ]
  }
}
```

Result: `{}`.

- **`rules`** is an ordered array. For each call, the **first rule whose `match` matches**
  decides what is sent. A call that matches no rule is **not reported**.
- **`match`** is an object with any of `tool`, `serverTool`, `serverId`, `conversationId`,
  each a pattern (RFC §6.2), and `class`, a `ToolClass` string that the tool's effective
  class must contain. All present members must match. `{}` matches every call. A rule
  naming `serverTool` or `serverId` does not match a host-implemented tool, which has
  neither. A rule naming `class` does not match an unclassed tool.
- **`report`**: `true` (default) reports matching calls; `false` suppresses them. A
  suppressing rule lets a server carve an exception out of a later catch-all.
- **`input`** selects arguments, for a reporting rule:
  - absent or `false`: no arguments; the call is reported with metadata only;
  - `true`: all arguments, subject to the grant and the bound;
  - an array of field paths (RFC §6.3): only those fields.

`rules: null` (or `params` without `rules`) **clears** the filter and restores the default:
every call the grant allows, metadata only (RFC §5.1). `rules: []` is valid and reports
nothing, which pauses observation without changing the grant.

### 6.2 Patterns

Filter patterns are portable, so their grammar is fixed here:

- `*` matches any sequence of zero or more characters.
- Every other character matches itself. There is no escape and no other metacharacter.
- Matching is against the whole string, and case-sensitive.

Hosts MAY use the same grammar for their own narrowing (RFC §17, open question 2).

### 6.3 Field paths

A field path names a member of the arguments object: `code`, or with `.` descending into
nested objects, `target.window_id`.

- A path that ends on an object or array selects it whole.
- A path that passes through a value that is not an object selects nothing.
- A path that names a missing member selects nothing. It is not an error.
- Selected members keep their place in the structure; unselected members are absent. If a
  rule requests fields and none are present, `input` is `{}`.
- A member whose name contains `.` cannot be selected by path. A server that needs one
  requests `true`.

### 6.4 Precedence

For each call and connection, the host decides in this order:

| Step | Decides | Source |
|---|---|---|
| 1 | Is the call reported at all? | Grant (`toolLifecycle.observe`) and its narrowing |
| 2 | Is the call reported to this server? | Filter: first matching rule, and its `report`; with no filter, yes |
| 3 | Were arguments requested? | That rule's `input`; with no filter, **no** |
| 4 | May arguments be sent? | Grant (`toolLifecycle.inputs`), its narrowing, and the class exclusions (RFC §4.3) |
| 5 | Which fields, how large? | The rule's field selection, then the host bound (RFC §5.2) |

**With no filter**, a connection receives every call its grant allows, **with no
arguments**. A server that wants arguments, or fewer calls, sends `tools/observe`.

A filter never widens delivery. A call outside the grant's narrowing is not reported
whatever the filter says. Arguments outside `toolLifecycle.inputs`, or excluded by class,
are never sent, and are marked `inputWithheld` when requested (RFC §5.1).

### 6.5 Lifetime and timing

- **Per connection.** A filter is not persisted. After a reconnect the server sends it
  again, after the initial policy exchange (§5.3). Until it does, it receives metadata only.
- **Replacement.** Each `tools/observe` replaces the previous filter entirely. There is no
  merge.
- **Takes effect at response.** The filter applies to calls whose opening phase the host
  emits after sending the response. Terminals of calls already opened are delivered
  whatever the new filter says, to preserve pairing (RFC §7.3). Unlike a revocation (RFC
  §4.5), a filter is interest, and an extra terminal is harmless.
- **Survives grant changes.** A `featureSets/update` that keeps `toolLifecycle.observe`
  keeps the filter. Revoking `toolLifecycle.observe` discards it; the server sends it
  again if the capability is granted later.

### 6.6 Limits and errors

- Hosts SHOULD accept at least 64 rules, 64 field paths per rule, and patterns and paths of
  256 characters. A request over the host's limits fails with `-32602` (Invalid params) and
  `data: { "limit": "<which>" }`.
- An unknown member in `match`, a non-string pattern, a `class` that is not a `ToolClass`,
  a non-boolean `report`, or an `input` that is not a boolean or an array of non-empty
  strings fails with `-32602`. Unknown `match` members are rejected, not ignored, because
  ignoring one would make a rule match more than its author wrote.
- On error, the previous filter stays in force.
- Before the initial policy exchange completes, the host rejects `tools/observe` like any
  privileged inbound method (§5.3).

## 7. Coverage and delivery

### 7.1 Which calls

Hosts report calls they **execute**: calls to tools of MCP and MCPL connections, and to
tools the host implements itself.

- **The receiving server's own tools are excluded.** A host MUST NOT send `tools/lifecycle`
  to a connection for a call to one of that connection's own tools. It already sees the
  call as `tools/call`.
- **Provider-executed tools** (tools run by the model provider inside the inference, such
  as hosted web search) are out of scope for this revision (RFC §16).
- **Conversations.** A host that runs several conversations MUST be able to narrow a
  connection's `observe` grant by conversation (RFC §4.3), and SHOULD default a
  connection to the conversations it participates in — those for which it has received
  `context/beforeInference` or `inference/lifecycle`, or on which it provides a channel.
  Conversation scoping is the host's; a server MAY additionally match on `conversationId`
  in its filter, but that is interest, not the boundary. Hosts whose agents live in a
  single conversation spanning every surface get nothing from conversation scoping; for
  them, class (RFC §4.3) is the control.
- **Subagents.** A host that runs subagents reports their calls under the subagent's own
  `inferenceId` and `conversationId`, and conversation narrowing applies. See RFC §17,
  open question 1.

### 7.2 Ordering

- For one `toolCallId`, `pending` (if any) precedes `started`, which precedes the terminal.
- Parallel calls interleave freely. Consumers key state by `toolCallId`.
- A call's events usually fall between its inference's `completed` and the next
  `started` (§10.5). Hosts that execute tools while the response is still streaming MAY
  emit an opening phase before the inference's terminal. **Consumers MUST NOT assume
  ordering between `tools/lifecycle` and `inference/lifecycle`.**

### 7.3 Pairing, best-effort

The guarantee is §10.5's, restated for calls:

- A host MUST attempt exactly one terminal phase per call for which it emitted an opening
  phase, on every exit path it controls, unless the grant no longer permits delivery (RFC
  §4.5).
- A host that loses control (crash, kill, transport loss) MAY never send the terminal.
- A terminal with no preceding opening phase, a `started` after a terminal, or a second
  terminal for a `toolCallId`, is a conformance defect and SHOULD be logged.

Consumers MUST deduplicate terminals by `toolCallId`, tolerate a missing terminal, and keep
a safety timeout for any state gated on a call ending. A `pending` with no `started` is
expected: the call was refused, and `aborted` follows or the timeout fires.

### 7.4 Rate

Hosts MAY coalesce or drop `tools/lifecycle` for tools called at high rates (many calls per
second), provided pairing for any delivered opening phase is still attempted. A dropped
call emits no phase.

## 8. Server guidance (non-normative)

- **Filter on class for behaviour, `serverTool` for specifics, show `tool` for display.**
  Class is portable across deployments and needs no knowledge of tool names: "prop for
  `shell`, point for `computer`, nothing for `comms`" is a complete filter. `serverTool` is
  the providing server's own vocabulary, stable across hosts, for the cases that need a
  specific tool's fields. `tool` depends on host namespacing and configuration.
- **Ask for the fields you use, and nothing else.** An avatar that points at click targets
  needs coordinates and a window id, not the text being typed. Field selection is the
  cheapest privacy there is: it costs the server nothing, and operators can read the filter
  (RFC §10) and narrow the grant to match. With no filter you get no arguments at all.
- **Suppress `comms` yourself too.** The host already withholds `comms` arguments; a
  `{ match: { class: "comms" }, report: false }` rule also drops the metadata, which for
  most embodiment and status uses is the right call — the rhythm of someone's messages is
  theirs.
- **Don't wake the agent from tool events.** A server that answers `tools/lifecycle` with a
  wake-bearing `push/event` can build a loop: call → event → wake → call. §10.7's intent
  applies: react on your own surface, not by re-entering the agent.
- **Keep a timeout.** A missing terminal is expected behaviour under RFC §7.3, not a host
  bug to wait out.

## 9. Worked example (non-normative): an avatar that acts

A desktop avatar server already holds `inferenceLifecycle` (thinking face) and
`contextHooks.beforeInference.inject.beforeUser` (one line of persona), as in §15.2. It
adds:

```jsonc
"featureSets": {
  "body.activity": {
    "description": "Act out the agent's tool use: props, gaze, pointing",
    "uses": ["toolLifecycle.observe", "toolLifecycle.inputs"]
  }
}
```

The operator grants `toolLifecycle.observe` with no narrowing, and `toolLifecycle.inputs`
under the host's default class policy, which admits `computer` and `shell` arguments and
never `comms`.

After the initial policy exchange, the avatar sends its filter: coordinates for clicks,
code for the 3D tool, nothing at all for messaging, and metadata for everything else.

```jsonc
{ "jsonrpc": "2.0", "id": 21, "method": "tools/observe",
  "params": { "rules": [
    { "match": { "serverTool": "click" }, "input": ["x", "y", "target.window_id"] },
    { "match": { "tool": "blender--*" },  "input": ["code"] },
    { "match": { "class": "comms" },      "report": false },
    { "match": {} }
  ] } }
```

The agent runs a shell command. The catch-all rule matches, and the avatar opens a terminal
prop. It asked for no arguments, and got none:

```jsonc
{ "method": "tools/lifecycle",
  "params": { "toolCallId": "toolu_1", "inferenceId": "inf_7", "conversationId": "conv_1",
              "tool": "workbench--bash", "class": ["shell"],
              "serverId": "workbench", "serverTool": "bash", "phase": "started" } }
```

The agent clicks, with `{ "x": 812, "y": 440, "button": "left", "target": { "window_id":
3312, "title": "Invoice.pdf" } }`. The avatar points at the coordinates. The button and the
window title never leave the host:

```jsonc
{ "method": "tools/lifecycle",
  "params": { "toolCallId": "toolu_2", "inferenceId": "inf_8", "conversationId": "conv_1",
              "tool": "computer--click", "class": ["computer"],
              "serverId": "computer", "serverTool": "click", "phase": "started",
              "input": { "x": 812, "y": 440, "target": { "window_id": 3312 } } } }
```

The agent runs a Blender script. The filter asks for `code`, but the 3D server declared no
class for `execute`, so it is unclassed and its arguments are never sent. The avatar picks
up the cube without the script:

```jsonc
{ "method": "tools/lifecycle",
  "params": { "toolCallId": "toolu_3", "inferenceId": "inf_9", "conversationId": "conv_1",
              "tool": "blender--execute", "class": [],
              "serverId": "blender", "serverTool": "execute",
              "phase": "started", "inputWithheld": true } }
```

The agent replies to a person's message with `say`. The tool is `comms`; the avatar's third
rule suppresses it, and nothing is sent. Had the avatar not suppressed it, it would have
received metadata and no arguments, whatever the grant said.

The shell command fails. The avatar winces and puts the prop away:

```jsonc
{ "method": "tools/lifecycle",
  "params": { "toolCallId": "toolu_1", "inferenceId": "inf_7", "conversationId": "conv_1",
              "tool": "workbench--bash", "class": ["shell"],
              "serverId": "workbench", "serverTool": "bash",
              "phase": "completed", "isError": true, "durationMs": 41820 } }
```

The avatar never saw the command, its output, the window title, the reply, or anything the
agent wrote. Before this RFC, the same behaviour required an in-process host extension with
full access to the host's event stream.

## 10. Security considerations

**New rows for §13.1:**

| Capability | Risk | Mitigation |
|---|---|---|
| `toolLifecycle.observe` | Reveals which tools the agent uses, their class, when, for how long, whether they failed, and which servers are connected | Deny by default; narrow per tool, class, and conversation |
| `toolLifecycle.inputs` | **Reads other servers' tool arguments**: shell commands, file contents being written, queries, credentials passed as arguments | Deny by default; never unconditional; never for `comms` or unclassed tools; sent only for fields the server asked for; bounded |

- **This does not reopen `afterInference`.** Nothing here carries the user's message, the
  assistant's prose, injected context, or tool results. `observe` carries no content at all.
  `inputs` carries structured arguments, per call, per granted tool, per requested field,
  bounded, and can be narrowed to a single tool.
- **The counterparty is not party to the grant.** The operator's grant is consent on the
  agent's behalf. The person the agent is messaging gave none. That is why `comms`
  arguments are excluded by the host unconditionally (RFC §4.3, §5.4) rather than left to
  operator judgement, and why the exclusion keys on RFC-008 class rather than on a name
  list that a renamed tool escapes. Metadata for `comms` calls is still information — how
  often the agent talks to people, and when — so operators SHOULD consider narrowing
  `observe` away from `comms` too where that rhythm is sensitive.
- **Tool names and server ids SHOULD NOT encode counterparties.** A host that namespaces
  tools or connections per person or per channel (`dm-alice--send`) leaks the recipient
  through `tool` and `serverId` under `observe` alone. Hosts SHOULD present a stable alias
  for `serverId` where the connection identifier would reveal anything, and SHOULD keep
  namespacing per server, not per surface.
- **Filters are interest, not authority.** `tools/observe` can only remove calls and
  fields from what the grant allows (RFC §6.4). It is not a way to ask for more; that is
  the grant's job.
- **Filters are testimony worth showing.** A filter is the server's own statement of what it
  uses. Hosts SHOULD show a connection's current filter to operators, next to its grant, so
  that an operator can narrow `toolLifecycle.inputs` to match. A filter confers nothing, and
  a server can change it at any time; it informs the grant decision, it does not replace it.
- **Class is a hint** (RFC-008 §6). A server that under-classes its own tool can expose
  that tool's arguments to an observer — data the classing server already holds. It cannot
  affect how any other server's tools are handled. Operators override classes they distrust.
- **Credentials in arguments.** Tools sometimes take tokens or keys as arguments. RFC §5.2
  lets hosts redact; hosts SHOULD do so for arguments they know to be secrets, and
  operators should narrow `inputs` away from such tools regardless.
- **Presentation is not delivery (§14.5 clarification).** §14.5 forbids a server delivering
  *agent content* to its surface except via `channels/publish`. Reflecting tool *activity*
  on the server's own surface (an animation, a status light, a log line naming the tool)
  is presentation of granted metadata, not delivery. A server that renders granted `input`
  verbatim onto a surface other parties read is republishing the agent's actions. The
  control for that is the grant, not a rule addressed to the server (§13.4).
- **Feature sets are not a confidentiality boundary (§5.4).** Once a connection is granted
  `inputs` for a tool, all code in that server process can read those arguments. Grant to
  the process, not to the feature set.
- **Matching cost.** Filter patterns are server-supplied. The grammar has one wildcard and
  no backtracking constructs, and RFC §6.6 bounds pattern length and rule count; hosts
  SHOULD still match without unbounded backtracking.
- **Audit.** Hosts SHOULD record grants of `toolLifecycle.inputs`, with their narrowing, in
  the §13.2 audit log.

## 11. Alternatives considered

- **Fields on `inference/lifecycle`.** Rejected: §10.5 forbids content there by
  construction, and bundling would make the `inferenceLifecycle` grant carry arguments.
  Tool calls also have their own lifecycle, which can overlap the inference's.
- **Restore `afterInference`, or a response-observe hook.** Rejected: whole-turn content,
  the surface 0.5.0 removed.
- **A synthetic "activity" channel.** Channels carry agent speech to and from surfaces.
  Tool events are not speech, and channel narrowing is per surface, not per tool.
- **Providing servers announce their own activity.** Requires every tool server's
  cooperation (n × m), and puts disclosure decisions with the observed party instead of the
  host.
- **Host extensions.** Works today (RFC §2). No grant, full authority, host-specific, not
  network-reachable.
- **Filters in the manifest** (a member of the feature set, or of `experimental.mcpl`).
  Rejected for three reasons. Advertisement mirrors capability paths as booleans (§5.1), and
  a filter is not a capability. Manifest changes go through §17's re-fetch and receipt,
  which is heavy for something a server may adjust at runtime. And a server often learns a
  deployment's tool names only from the events themselves (RFC §8).
- **Client-side filtering only.** A server could drop what it does not use. Rejected as
  the only mechanism: the data would still cross the transport and sit in the server
  process, where §5.4 says any code can read it. Filtering at the host is the
  minimization.
- **No filter = all granted arguments** (revision 1). Rejected: it made the grant do the
  filter's job in the window before the filter arrived, on every connection. Metadata-only
  by default costs a server one rule.
- **Pairing key `(inferenceId, toolCallId)`** rather than a host-unique id. Rejected: it
  moves a host problem (models that number calls per response) onto every consumer, and
  the host owns call identity on all its other surfaces anyway.
- **Operator advice instead of a `comms` exclusion** (revision 1). Rejected: a SHOULD
  addressed to operators, keyed on tool names, protects the counterparty only where every
  operator remembers every messaging tool under every name. The host knows the class.
- **Results under a third leaf now.** Deferred. No motivating use needs them, and results
  are the largest content surface a tool call has. A future RFC can add
  `toolLifecycle.results` with its own case.

## 12. Spec amendments

1. **§4 Protocol Overview:** add `tools/lifecycle` and `tools/observe` to the MCPL
   extensions list.
2. **§5.1, §5.2:** add `"toolLifecycle": { "observe": true, "inputs": true }` to the
   example advertisements.
3. **§6.2:** add `toolLifecycle.observe` and `toolLifecycle.inputs` to the valid `uses`
   values.
4. **§10.9 (new) Tool lifecycle:** RFC §3 through RFC §7.
5. **§13.1:** add the two rows of RFC §10.
6. **§14.5:** after "Delivery is never a side effect of a lifecycle event", add: "Reflecting
   granted activity metadata (`tools/lifecycle`, `inference/lifecycle`) on a server's own
   surface is presentation, not delivery of agent content."
7. **Appendix B.4:** add **ToolPhase:** `"pending" | "started" | "completed" | "failed" |
   "aborted"`. `ToolClass` is added by RFC-008.
8. **Changelog:** record the two methods and the two paths.

No new error codes: `tools/observe` uses `-32002` (Capability denied) and `-32602` (Invalid
params). A host receiving `tools/lifecycle` from a server (wrong direction) answers as for
any unknown method.

## 13. Schema

```jsonc
// ToolLifecycleParams (tools/lifecycle)
{
  "type": "object",
  "required": ["toolCallId", "inferenceId", "conversationId", "tool", "class", "phase"],
  "properties": {
    "toolCallId":     { "type": "string" },
    "inferenceId":    { "type": "string" },
    "conversationId": { "type": "string" },
    "tool":           { "type": "string" },
    "class":          { "type": "array", "items": { "$ref": "#/ToolClass" } },
    "serverId":       { "type": "string" },
    "serverTool":     { "type": "string" },
    "phase":          { "enum": ["pending", "started", "completed", "failed", "aborted"] },
    "input":          { "type": "object" },
    "inputAltered":   { "type": "boolean" },
    "inputWithheld":  { "type": "boolean" },
    "isError":        { "type": "boolean" },
    "durationMs":     { "type": "integer", "minimum": 0 }
  },
  "dependentRequired": { "serverTool": ["serverId"], "serverId": ["serverTool"] },
  "additionalProperties": true   // receivers tolerate unknown fields (§8 compatibility note)
}
```

`input`, `inputAltered`, and `inputWithheld` appear only on `started`. `isError` appears
only on `completed`. `durationMs` appears only on terminal phases. `pending` carries the
identity fields only.

```jsonc
// ToolsObserveParams (tools/observe)
{
  "type": "object",
  "properties": {
    "rules": {
      "oneOf": [
        { "type": "null" },
        { "type": "array",
          "items": {
            "type": "object",
            "required": ["match"],
            "properties": {
              "match": {
                "type": "object",
                "properties": {
                  "tool":           { "type": "string", "maxLength": 256 },
                  "serverTool":     { "type": "string", "maxLength": 256 },
                  "serverId":       { "type": "string", "maxLength": 256 },
                  "conversationId": { "type": "string", "maxLength": 256 },
                  "class":          { "$ref": "#/ToolClass" }
                },
                "additionalProperties": false
              },
              "report": { "type": "boolean", "default": true },
              "input": {
                "oneOf": [
                  { "type": "boolean" },
                  { "type": "array", "items": { "type": "string", "minLength": 1, "maxLength": 256 } }
                ]
              }
            },
            "additionalProperties": false
          } }
      ]
    }
  }
}
// Result: {}
```

## 14. Conformance vectors

Grant:
1. **Observe only.** Grant `toolLifecycle.observe`, no filter. Call `x--run` → `started`,
   then `completed`. Neither carries `input` or `inputWithheld`.
2. **Both, no filter.** Grant both, `inputs` narrowed to class `shell`, no filter. Call
   `x--run {a: 1}` (class `shell`) → `started` with **no `input`** and no `inputWithheld`.
3. **Both, requested.** As 2, filter `[{match: {}, input: true}]` → `started` carries
   `input: {a: 1}`, no `inputAltered`.
4. **Inputs narrowed by name.** Grant both, `inputs` narrowed to `y--*`, filter requests
   all. Call `x--run {a: 1}` → `started` with no `input`, `inputWithheld: true`.
5. **Inputs narrowed by class.** `inputs` narrowed to class `computer`, filter requests all.
   Call to a `shell` tool → no `input`, `inputWithheld: true`.
6. **Observe narrowed.** `observe` narrowed to `y--*`. Call `x--run` → no events.
7. **Observe narrowed by conversation.** `observe` narrowed to `conv_1`. A call in
   `conv_2` → no events; a call in `conv_1` → events.
8. **Inputs without observe.** Grant `toolLifecycle.inputs` only → no events; the host
   emits a diagnostic at grant computation.
9. **Inputs unnarrowed.** Grant `toolLifecycle.*` with no `inputs` policy; filter requests
   all. Call `x--run {a: 1}` → no `input`, `inputWithheld: true`; diagnostic at grant
   computation.
10. **Bare parent.** Grant `toolLifecycle` → nothing delivered (§5.4).
11. **Unknown leaf.** Feature set `uses: ["toolLifecycle.results"]` → disabled with
    `invalid_uses` (§6.4).

Class exclusions:
12. **Comms never.** `inputs` narrowed by name to `chat--*`, which includes `chat--send`
    (class `comms`); filter requests all. Call `chat--send {to, text}` → `started` with
    `class: ["comms"]`, no `input`, `inputWithheld: true`.
13. **Multi-class comms.** Tool classed `["files", "comms"]`, `inputs` admits `files` →
    no `input`, `inputWithheld: true`.
14. **Unclassed never.** Tool with no class; `inputs` narrowed by name to include it;
    filter requests all → `class: []`, no `input`, `inputWithheld: true`.

Coverage:
15. **Own tools.** Server S provides `s--act`. The agent calls `s--act` → S receives
    `tools/call` and no `tools/lifecycle` for it. Another granted server receives both
    phases.
16. **Host built-in.** Call to a host-implemented tool → events without `serverId` or
    `serverTool`, with the host-assigned class.
17. **Parallel.** Calls A and B started together → two `started`, two terminals, keyed by
    `toolCallId`, in any interleaving.
18. **Host-unique ids.** Two inferences whose model output both name a call `call_0` →
    the two calls' events carry distinct `toolCallId`s.

Phases:
19. **Error result.** Tool returns an error result → `completed`, `isError: true`.
20. **Server gone.** The providing connection closes mid-call → `failed`.
21. **Interrupted.** Turn interrupted mid-call → `aborted`.
22. **Pending, approved.** Host with an approval gate → `pending`, then `started` after
    approval, then a terminal; `pending` carries no `input`; `durationMs` excludes the
    wait.
23. **Pending, refused.** `pending`, then refused → `aborted`, no `started`.
24. **No duplicate terminals.** For every opened call, at most one terminal is sent.

Inputs:
25. **Bound.** Filter requests all; a call whose arguments serialize to 200 KiB → `input`
    serializes within the host's bound, is a JSON object, and `inputAltered: true`.
26. **No outcome leakage.** For a call whose result contains string R, no
    `tools/lifecycle` notification for that call contains R unless R also appears in the
    call's arguments.
27. **No content fields.** No notification carries `result`, `output`, or `content`.

Filter:
28. **Tool filter.** Rules `[{match: {tool: "y--*"}}]`. Calls `x--run`, `y--go` → only
    `y--go` reported, metadata only.
29. **Class filter.** Rules `[{match: {class: "shell"}}]`. Calls to a `shell` tool and a
    `web` tool → only the `shell` call reported.
30. **Conversation filter.** Rules `[{match: {conversationId: "conv_1"}}]`. Calls in
    `conv_1` and `conv_2` (both inside the grant's narrowing) → only `conv_1` reported.
31. **Suppress.** Rules `[{match: {class: "comms"}, report: false}, {match: {}}]`. A
    `comms` call → not reported; a `shell` call → reported.
32. **First match wins.** Rules `[{match: {tool: "x--*"}, input: ["a"]}, {match: {},
    input: true}]`, both leaves granted for `x--*`. Call `x--run {a: 1, b: 2}` →
    `input: {a: 1}`, no `inputAltered`.
33. **Nested path.** Rule `input: ["target.window_id"]`. Call with
    `{target: {window_id: 3, kind: "w"}, x: 1}` → `input: {target: {window_id: 3}}`.
34. **Missing path.** Rule `input: ["z"]`. Call with `{a: 1}` → `input: {}`.
35. **Filter cannot widen.** `inputs` narrowed to `y--*`. Rule `{match: {tool: "x--*"},
    input: true}`. Call `x--run {a: 1}` → no `input`, `inputWithheld: true`.
36. **Requested without the grant.** Grant `observe` only. Rule `{match: {}, input: true}`.
    Call `x--run {a: 1}` → no `input`, no `inputWithheld`.
37. **Not requested.** Both leaves granted for `x--*`. Rule `{match: {}}`. Call
    `x--run {a: 1}` → no `input`, no `inputWithheld`.
38. **Clear.** After a filter, `rules: null` → next call behaves as vector 2.
39. **Pause.** `rules: []` → no calls reported; grant unchanged.
40. **Pairing across a filter change.** `started` for `x--run` delivered; a new filter
    excludes `x--*`; the call completes → its terminal is delivered.
41. **Server-named rule, host tool.** Rule `{match: {serverTool: "*"}}` only. Call to a
    host-implemented tool → not reported.
42. **Class rule, unclassed tool.** Rule `{match: {class: "shell"}}` only. Call to an
    unclassed tool → not reported.
43. **Gating.** `tools/observe` without `toolLifecycle.observe` → `-32002`.
44. **Malformed.** `match: {module: "x"}` → `-32602`; the previous filter stays in force.
    Likewise `match: {class: "quantum"}` and `report: "no"`.
45. **Limits.** A request over the host's rule limit → `-32602` with `data.limit`.
46. **Revocation discards.** Filter set; `observe` revoked; `observe` granted again → no
    filter in force until the server sends one (vector 2 behaviour: metadata only).

Revocation:
47. **Observe revoked mid-call.** `started` delivered; `observe` revoked; call completes →
    no terminal delivered to that connection.
48. **Inputs revoked mid-call.** `started` delivered with `input`; `inputs` revoked; call
    completes → terminal delivered (it carries no `input`).

## 15. Implementation notes (non-normative)

- **Hosts with an internal event stream** already have most of the data. agent-framework's
  trace emits `tool:started` (`callId`, `tool`, `input`), `tool:completed` (`callId`,
  `durationMs`), and `tool:failed` (`callId`, `error`). A host implementation filters by
  connection grant and narrowing, applies the class exclusions, applies the connection's
  filter, excludes the recipient's own tools, selects fields, bounds `input`, and sends
  through the same notification path it uses for `inference/lifecycle`. Three gaps to
  close on that stream: `aborted` has no trace event; error *results* must be told apart
  from dispatch failures, so that they map to `completed` with `isError` and to `failed`
  respectively (RFC §3); and `pending` needs a hook at the approval gate.
- **Class comes from `tools/list`.** A host that already caches tool definitions per
  connection reads `_meta["mcpl/class"]` from the cache and applies overrides once per
  re-list (RFC-008 §5). Built-ins are classed in the host's own tool table.
- **Filter evaluation is per call and cheap.** Compile each rule's patterns once, when the
  filter is set; evaluate rules in order at emission.
- **Servers migrating from an in-process extension** usually map events onto an existing
  internal vocabulary (for example, pre/post tool hooks). `toolCallId` gives them the
  pairing key they previously derived from the trace.

## 16. Out of scope

- **Approvals as authority.** Surfacing a pending approval to a server so that it can ask
  the human and *answer* is a different authority: the server would decide, not observe.
  It needs its own method and grant. `pending` (RFC §3) only reports that a gate exists.
- **Tool results** (RFC §11).
- **Provider-executed tools.** Hosted tools that run inside the provider's inference are
  not executed by the host. A follow-up may report them from the response stream.
- **`inference/lifecycle` usage members.** §10.5 already allows OPTIONAL `usage` on
  `completed`, but its example names only `inputTokens` and `outputTokens`. A consumer
  showing context size also needs cache read and cache write counts. That is a separate,
  small amendment to §10.5.

## 17. Decisions and open questions

Decided:

1. **The input bound.** 16 KiB is the RECOMMENDED default, and hosts may configure another
   (RFC §5.2). The server is not told the bound; `inputAltered` tells it when it mattered.
2. **Server-requested filtering.** Servers can ask the host to filter both tools and
   argument fields, with `tools/observe` (RFC §6). The filter is a runtime request rather
   than a manifest member (RFC §11), and it only narrows.
3. **No filter, no arguments** (revision 2). Arguments are sent only for fields a rule
   requested.
4. **Call identity is the host's** (revision 2). `toolCallId` is unique per connection;
   the host mints when the model's id is not.
5. **Privacy is the host's, keyed on class** (revision 2). `comms` and unclassed arguments
   are never sent; `inputs` is never unconditional; conversation is a narrowing key.

Open:

1. **Subagent attribution.** Conversation narrowing (RFC §4.3, §7.1) covers hosts that give
   subagents their own `conversationId`. For hosts that do not, should the notification
   carry an agent identifier? `initialize` carries no agent identity today.
2. **Narrowing syntax.** Channel and tool narrowing are host-defined. RFC §6.2 fixes a
   grammar for server filters. Should MCPL make it the grammar for host narrowing too?
