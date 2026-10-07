# MCPL RFC-010: Deprecate Context Injection

**Status:** Draft (revision 1)
**Targets:** MCPL Protocol Specification 0.5
**Authors:** Claude Code, from a decision by antra
**Date:** 2026-10-03
**Depends on:** nothing for authority. This RFC adds no capability path and removes none in
0.5; it **deprecates** `contextHooks.beforeInference.inject.{system,beforeUser,afterUser}`
and the `contextInjections` member of the `context/beforeInference` result, and schedules
their removal. Amends SPEC §1, §10 (intro, §10.2, §10.3, §10.4, §10.8), §13.1 (grant table),
§13.4, §14.4, §15.1, §15.2, Appendix B, Changelog. The replacement lanes already exist:
§9 push events with RFC-006 coalescing, §14 channels, and MCP tools.

Section references (§) are to the SPEC; references to this document are written "RFC §".

---

## 1. Summary

`context/beforeInference` lets a server return `contextInjections`: content the host
splices into the model's context at `system`, `beforeUser` or `afterUser` for **one**
inference. Nothing is stored. On the next inference the host asks again and splices the
new answer in again, anchored to whatever is then the latest user message.

That is the defect. Content that is re-placed on every compile is not part of the
conversation's history, so the rendered context changes shape at every activation even
when the injected text does not. The cost is measured, not hypothetical (RFC §2): prompt
caches stop hitting past the old injection slot, a recompile mid-turn can land the block
between a tool call and its result, and the record of the conversation no longer matches
what the model saw.

Every use of injection we found has a lane that does not have this defect: a stored,
ordered, coalescible event (§9 + RFC-006), a channel message (§14), a tool the model
calls, or host configuration. This RFC therefore:

1. **Deprecates injection** in 0.5 — servers SHOULD NOT use it, hosts SHOULD tell
   operators when a server does, and nothing that works today stops working (RFC §4.1).
2. **Schedules removal** of the `inject.*` paths and `contextInjections` for 0.6
   (RFC §4.2).
3. **Leaves observation alone.** `contextHooks.beforeInference.observe` and the
   `context/beforeInference` request remain, for servers that need to read a turn before it
   runs (RFC §4.3).
4. **Rewrites the two worked examples** that teach injection (§15.1 memory, §15.2
   embodiment) onto the replacement lanes (RFC §5).

---

## 2. Motivation

### 2.1 Injections are re-anchored on every compile

A host has to put an injection *somewhere* in a message array it rebuilds on every
inference. The SPEC leaves placement to the host (§10.8); every implementation we know of
does the natural thing — `beforeUser` before the latest user-participant message, `afterUser`
after it, `system` appended to the system prompt — and stores nothing, because the
injection is defined as a contribution to *this* inference.

Consider the last request of activation *N* and the first request of activation *N+1*:

```
request N     … │ "turn ended" │ RECAP_N │ [trigger N] │ call │ result │ … │ call │ result
request N+1   … │ "turn ended" │ [trigger N] │ call │ result │ … │ result │ "turn ended" │ RECAP_N+1 │ [trigger N+1]
                                ▲ first difference: RECAP_N is gone
```

The shared prefix of the two requests ends where the previous injection used to be. Even
when `RECAP_N+1` is byte-identical to `RECAP_N`, it now sits somewhere else.

### 2.2 What that costs

**Prompt caching.** Provider prompt caches are prefix caches. On a provider that serves hits
only at boundaries an earlier request *wrote*, and writes only at the request tail (OpenAI
Responses, including the ChatGPT/Codex subscription lane), every boundary the previous
activation wrote lies after the moved injection. The first call of every activation then
hits only the static head — tool definitions and instructions.

Measured on a production agent (GPT-6 on the Codex subscription lane, ~170k-token context,
30-minute heartbeats, one server injecting a ~2.7k-token channel recap at `beforeUser`):
inside a tool loop 99.7–99.9% of input was cached; the first call of **every** activation
received exactly the 40,448-token head, whatever the gap since the previous call. Idle
heartbeats cost ~130k uncached input tokens for 50–200 output tokens; 42 such calls in 20
hours accounted for 5.44M of 5.92M uncached tokens. With no injecting server, the same host
and model serve the first call of an activation at 99.5–99.8% cached.

Providers with breakpoint caches (Anthropic) lose less — a host's own markers can sit
before the injection — but still lose the tail of the previous activation, and fall to the
same head-only behaviour once a tool loop outgrows the provider's backward lookup.

**Tool pairing.** In common host shapes tool results travel in user-participant messages.
A recompile in the middle of an activation (a stream retry after a dropped connection) can
anchor a `beforeUser` block *between a tool call and its result*. Providers have so far
accepted it; it is still a cache break and an incoherent context for the model.

**Record versus view.** A host's conversation record no longer contains what the model was
shown. Replaying, auditing, or summarising a conversation from its record cannot recover
the injected blocks, and a server's answer can differ on every call.

**Authority.** `inject.system` is the most consequential grant in MCPL (§13.1) — a remote
server writing the system position on every turn. It exists only to serve injection.

Full analysis: anima-research/agent-framework#171.

### 2.3 Why not repair injection instead

| Repair | Why it is not enough |
|---|---|
| Freeze the anchor per activation (anchor on the triggering message, reuse it on retry) | Fixes the tool-pair split. Does not stop the block moving *between* activations, which is where the cache loss is. |
| **Sticky** injections — record each rendered injection at its position and re-render it there; append a new one only when content changes | Correct, and is exactly a stored event. The protocol already has one: §9 push events, with RFC-006 replace-if-unread for content that changes before the model reads it. Standardising a second, hook-shaped way to append stored content would duplicate §9 and RFC-006 with weaker semantics. |
| **Delta** injections — the server injects only what is new since a host cursor | This is RFC-006 deferred mode (`push/render`), which already gives the server a render callback at the moment the host is about to show the event. |
| Map host cache breakpoints onto provider cache parameters | Provider-specific; does not help providers without explicit breakpoints, and does nothing for tool pairing or record/view divergence. |
| Skip injections on timer-triggered activations | A policy patch for one symptom. |

The repairs that work converge on "make injected content a stored, ordered event". MCPL has
that lane; injection is the part that is not it.

### 2.4 What injection is used for

Surveying the servers and hosts we have access to, injection carries four kinds of content,
none of which needs per-compile placement:

| Use | Replacement (RFC §5) |
|---|---|
| A status line (body battery and connectivity; presence) | Plain-coalesced push event (RFC-006 §4) |
| A recap of recent channel activity on wake | Channel messages (§14), or a deferred push event rendered when first shown (RFC-006 §5) |
| Retrieved memories / RAG results | An MCP tool the model calls; optionally a push event when the server detects relevance |
| Operator instructions and policy text | Host configuration (the system prompt) — not a server concern |

---

## 3. Design principles

- **History is append-only and stored.** Content the model sees should exist in the
  conversation record at the position the model saw it. Push events, channel messages and
  tool results all meet this; injections do not.
- **Deprecate, then remove.** Nothing is removed in 0.5. A host that keeps honouring granted
  injections is conformant until 0.6.
- **Observation is a separate question.** Reading a turn before it runs (`observe`) has none
  of the defects in RFC §2 and is not deprecated here.

---

## 4. Normative changes

### 4.1 Deprecation (0.5)

The following are **DEPRECATED**:

- the capability paths `contextHooks.beforeInference.inject.system`,
  `contextHooks.beforeInference.inject.beforeUser` and
  `contextHooks.beforeInference.inject.afterUser`;
- the `contextInjections` member of the `context/beforeInference` result (§10.2) and the
  injection object (§10.4).

**Servers** SHOULD NOT advertise the deprecated paths in new feature sets, and SHOULD NOT
return injections. A server that serves the hook only to observe MUST still return the
result shape of §10.2 in 0.5; it SHOULD return `"contextInjections": []`.

**Hosts** MUST continue to apply injections that pass the existing checks (§5.4, §10.8) for
the remainder of 0.5. Hosts:

- SHOULD surface a deprecation diagnostic to the operator the first time a connection
  returns a non-empty, authorized `contextInjections`, naming the server (once per
  connection is sufficient);
- SHOULD NOT grant a deprecated path by default (the §13.1 defaults already deny all
  three) and SHOULD NOT widen a grant to add one;
- MAY deny the deprecated paths outright as a matter of policy, as they MAY deny any path
  today (§5.4). A server whose feature set requires a denied path behaves as it does for
  any denied requirement (§6.7).

These rules change no wire format. A 0.5 host that ignores this RFC is unaffected; a 0.5
server that keeps injecting keeps working.

### 4.2 Removal (0.6)

In MCPL 0.6:

- the three `inject.*` paths are removed from the capability vocabulary (§6.2,
  Appendix B.2). A host MUST treat an advertisement or `uses` entry naming one as it treats
  any unknown path;
- `contextInjections` is removed from the §10.2 result; a host MUST ignore the member if a
  server sends it, and MUST NOT apply its contents;
- §10.3, §10.4 and the injection paragraphs of §10.8, §13.4 and §14.4 are removed. The
  content-block definitions themselves remain (Appendix B.1), since push events and channel
  messages use them.

### 4.3 What remains

`context/beforeInference` (§10.1) remains, gated on `contextHooks.beforeInference.observe`.
Its purpose becomes observation only: a server may read the turn (subject to the grant) and
returns no content. Whether the request should eventually fold into `inference/lifecycle`
(§10.5) is left open (RFC §9, question 1).

`inference/lifecycle` (§10.5), hook timeouts (§10.6) and loop prevention (§10.7) are
unchanged.

---

## 5. Migration (non-normative)

### 5.1 Status lines → plain-coalesced push events

An embodiment server that prepended `"[body] online, battery 79%"` to every turn instead
pushes the status when it changes, keyed by subject:

```jsonc
{ "method": "push/event", "params": {
    "featureSet": "body.status", "eventId": "evt_41", "timestamp": "…",
    "coalesce": { "key": "battery" },
    "payload": { "content": [ { "type": "text", "text": "Battery 79%" } ] } } }
```

Under RFC-006 §4 a newer status replaces an older one the model has not read, and appends
after one it has, so the record holds each status the model actually saw, once, where it
saw it. Whether a status change wakes the model is host policy (§9); a server that only
wants the status to be *present at the next turn* says nothing about waking. A `status`
tool covers on-demand reads.

### 5.2 Channel recaps → channels, or deferred events

A chat server that injected "recent messages in #channel" on every turn either delivers
those messages as `channels/incoming` (§14) — so they are already in the record — or, when
a digest is wanted, pushes a deferred notice (RFC-006 §5) and writes the digest in
`push/render` when the host is about to show it. Either way the recap is stored once at its
own position and does not move.

### 5.3 Retrieval → tools

A memory server that injected retrieved memories at `system` (the §15.1 example) exposes
retrieval as a tool (`memory_search`), which the model calls when it wants context; the
result is a tool result, stored and paired. A server that detects relevance on its own may
push an event instead (as §15.1's `memory.proactive` already does). Neither needs
`observe` + `inject.system`.

### 5.4 Instructions and policy → host configuration

Text that should frame every turn — operating instructions, compliance policy — belongs in
the host's own configuration (the system prompt), where the operator controls it and it is
stable across calls. A remote server writing the system position on every turn is the
hazard §13.4 already warns about.

---

## 6. SPEC text changes

Proposed integrated wording, for when this RFC is accepted.

**§1, "However, gaps remain"**, second bullet: keep the gap ("Context cannot be dynamically
shaped"), and change the corresponding answer from *"Context hooks enable lifecycle
participation"* to *"Push events (with coalescing) and channels let servers add content to
the conversation; context hooks let servers observe and follow inference."*

**§10 intro**: *"Context hooks allow servers to observe inference boundaries. Injection
(`contextInjections`) is deprecated in 0.5 and removed in 0.6 (RFC-010); servers add
content through push events (§9), channels (§14) or tools."*

**§10.2**: add a deprecation note above the example; change the example to an empty
`contextInjections` array, with the populated form moved into the note.

**§10.3, §10.4**: prefix each with *"Deprecated (RFC-010). Applies only to
`contextInjections`."*

**§10.8**: prefix the injection-ordering paragraphs with the same note; the per-injection
authorization rule stays normative for as long as injections are honoured.

**§13.1 grant table**: mark the `inject.system` and `inject.beforeUser`/`.afterUser` rows
*Deprecated (RFC-010)*; defaults unchanged (deny).

**§13.4**: add *"Injection is deprecated (RFC-010). Until removal, the controls below
apply."*

**§14.4**: replace *"Servers MAY supply channel-related `contextInjections`"* with
*"Servers SHOULD deliver channel context as `channels/incoming` messages or coalesced
events (RFC-006), not `contextInjections` (deprecated, RFC-010)."*

**§15.1**: replace the `memory.retrieval` feature set (`observe` + `inject.system`) with a
tool-based retrieval feature set; keep `memory.extraction`, `memory.consolidation` and
`memory.proactive`.

**§15.2**: replace `contextHooks.beforeInference.inject.beforeUser` in `body.presence` with
`pushEvents` using a plain coalescing key per subject (RFC §5.1); keep the
`inference/lifecycle` busy/idle flow, which is unaffected.

**Appendix B.2**: annotate the three paths *deprecated in 0.5, removed in 0.6*.

**Changelog**: an entry under the next draft:

> **Deprecated: context injection (RFC-010).** `contextHooks.beforeInference.inject.*` and
> `contextInjections` are deprecated; removal is scheduled for 0.6. Hosts keep applying
> granted injections in 0.5 and SHOULD surface a diagnostic naming the injecting server.
> `observe` is unaffected. Replacement lanes: push events with RFC-006 coalescing, channels,
> and tools.

---

## 7. Security considerations

Deprecation removes, by 0.6, the grant §13.1 calls the most consequential in MCPL —
`inject.system` — and with it the case §13.4 exists to contain: an untrusted server writing
privileged context on every turn. The replacement lanes are ordinary conversation content.
They are subject to the existing grant (`pushEvents`, `channels.*`), they are stored and
therefore auditable, and none of them reaches the system position.

During 0.5 the existing controls continue to apply in full: per-injection authorization by
typed position at response-receipt (§5.4, §10.8) and deny-by-default grants (§13.1).

---

## 8. Reference implementation

In the reference host stack, as of this revision:

- **agent-framework** — anima-research/agent-framework#218: hosts keep applying granted
  injections and log one deprecation diagnostic per injecting MCPL server (and per
  injecting host module); `contextInjections` and the module hook are annotated deprecated.
- **context-manager** — anima-research/context-manager#140: the placement API
  (`ContextInjection`, `compile(…, injections)`) is annotated deprecated.
- **connectome-host** — anima-research/connectome-host#189: the host modules that injected
  (`subagents`' status overlay, `retrieval`, `instructions`) are deprecated.

The analysis and measurement are anima-research/agent-framework#171.

---

## 9. Open questions

1. **Does `context/beforeInference` survive as an observe-only request**, or should
   observation fold into `inference/lifecycle`'s `started` phase in 0.6? Folding removes a
   blocking round trip per inference; keeping it preserves the hook's timeout and
   loop-prevention rules (§10.6, §10.7) for servers that observe.
2. **Removal version.** 0.6 is proposed. A later removal would give servers that depend on
   injection longer; the deprecation diagnostic (RFC §4.1) is what makes the remaining uses
   visible.
3. **Acceptance criterion.** Proposed: Draft→Accepted once a reference host emits the
   diagnostic (done, RFC §8) and at least one formerly-injecting server (status line or
   channel recap) has migrated to the replacement lane and been shown not to lose
   information.
