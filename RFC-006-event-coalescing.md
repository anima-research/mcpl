# MCPL RFC-006: Event Coalescing

**Status:** Draft (revision 2)
**Targets:** MCPL Protocol Specification 0.5
**Authors:** Claude Code, from a scope proposed by antra
**Date:** 2026-09-21
**Depends on:** nothing for authority — RFC-002 / SPEC §5.4 remains the sole source of what
a connected server may do, and this RFC adds no capability path (§9). Amends SPEC §9
(`push/event` params and result; new `push/render` method) and §14.3 (`channels/incoming`
message and per-message result). Interacts with §9.4 (idempotency), §10.6 (hook timeouts),
§10.7 (loop prevention), §13.2 (audit), §13.3 (hook failure policy), §16 (tags).

> **Revision 2 note.** Revision 1 handled delta-describing events with
> `onConsumed: "reject"`: the host refused a cumulative event whose predecessor had already
> been read, and the server re-described the change against a new baseline and re-sent.
> Review (antra) found that this pushes real complexity into every server: two snapshots
> per key (`baseline`, `lastSent`), outcome-driven state transitions, and a resend path —
> all to reconstruct a boundary only the host can see. Revision 2 removes it:
>
> - **`onConsumed` and the `reject` path are gone.** No outcome ever requires the server to
>   resend or to change what it sends next.
> - **Deferred events (§5) are new.** For content that is a *delta*, the server pushes a
>   keyed notice and the host asks for the content — `push/render` — at the moment of
>   consumption. The server's baseline advances exactly when it renders, so a server needs
>   the one snapshot it already keeps today and nothing else.
> - **Plain coalescing (§4) is now only for self-contained content**, where "replace if
>   unread, otherwise append" is correct with zero server state.
> - The cost moved to the host: a bounded, fallback-protected request on the inference
>   path, only when a deferred event is actually pending (§5.3).

---

## 1. Summary

Some events describe a **moving subject**: a document being typed into, a partial speech
transcript being revised, a sensor reading, a chat message edited seconds after it was sent.
Today every observation of such a subject is a separate, append-only event. If the model has
not run yet, the host's context fills with a stack of stale intermediate states — `cat`,
then `cater`, then `caterpillar` — that the model must read, pay for, and mentally collapse.

This RFC adds an OPTIONAL **`coalesce`** member to `push/event` params and
`channels/incoming` messages, naming a server-chosen **key**, with two modes:

- **Plain** — for *self-contained* content (a value, a full message, a transcript
  hypothesis). A new event replaces the previous event under the same key **iff no model
  has consumed it**; otherwise it appends. Stateless for the server.
- **Deferred** — for *delta* content ("what changed since you last looked"). The server
  pushes a keyed notice; the host calls **`push/render`** when it is about to show the event
  to a model, and the server describes everything since its previous render. Repeated
  notices under one key collapse into one pending slot.

One rule governs both:

> **Unconsumed events are mutable by their sender. Consumed events are history, and history
> is never rewritten.**

The host is the only party that knows where that boundary is. Plain mode lets the host apply
it; deferred mode lets the host *ask at* it. In neither mode does the server have to learn
where it was.

## 2. Motivation

- **Live documents.** A Google Docs / editor integration diffs the document and pushes
  "user inserted `cat` at ¶3". Two seconds later the same insertion reads `caterpillar`. If
  the agent was mid-turn, tuned out, or debounced, both events are waiting for it. Only the
  second is true.
- **Streaming transcripts.** ASR emits partial hypotheses that are revised until final.
  Voice and wearable servers currently either withhold partials (latency) or flood the
  context with them.
- **Latest-value telemetry.** Battery, presence, spend, robot pose: a consumer that has not
  looked yet wants the current value, not the series.
- **Chat edits and deletes before read.** A message edited or deleted before the agent ever
  saw it should simply *be* the edited message, or be gone.

**Why the server cannot do this alone.** Server-side debouncing (mcpl-editor does 1.5 s /
5 s max) reduces the stack but cannot eliminate it, because the server does not know when
inference runs. `inference/lifecycle` (§10.5) could tell it, but that is an unacknowledged,
best-effort notification the spec says consumers must not rely on. The consumption boundary
is host-private state; the mechanism has to live where the state is.

### Design principles

1. **Never rewrite what a model has seen.** Coherence of history and prompt-cache stability
   both follow from this one rule. An unconsumed event has never been in a request, so
   replacing it invalidates nothing.
2. **Servers stay simple.** A server adopting this RFC keeps no state it does not already
   keep, never resends, and never branches on what the host did. (Revision 1 failed this.)
3. **Stateless key, not an event chain.** The server names the subject, not the prior
   event.
4. **Fail toward append.** On any uncertainty — unknown key, restart, eviction, mixed
   delivery — the host treats the prior event as consumed. The worst outcome is today's
   behaviour.
5. **No new authority.** A server may only touch its own events, only before anyone has
   read them, and everything it supplies passes the checks a fresh event would (§8, §9).
6. **Additive.** Absent `coalesce`, nothing changes.

## 3. The `coalesce` member

```ts
coalesce?: {
  key: string;          // 1..256 bytes UTF-8, opaque to the host
  deferred?: boolean;   // push/event only. Default false (plain).
  retract?: boolean;    // Default false. See §6.
}
```

**Key scope.** A key is scoped to *(server connection identity, `featureSet`)* for
`push/event` and *(server connection identity, `channelId`)* for `channels/incoming`. Two
servers, two feature sets, or two channels can never address each other's events. Plain and
deferred events under the same scope share one key space: a key has at most one unconsumed
occupant, of whichever mode was sent last.

**`eventId` is unchanged.** Every event carries its own fresh `eventId` / `messageId`, and
§9.4 idempotency applies per event: a retry with the same `eventId` is a duplicate of *that*
event and SHOULD receive the same result. Reusing `eventId` to mean "replace" is rejected
(§11).

### 3.1 Consumption

An event is **consumed** once its content has been included in the assembly of any request
to any model — agent inference, a subagent, summarization/compression, or a server-initiated
`inference/request`. Consumption is determined **at context assembly**, not at response: an
event in a request that later fails, is refused, or is aborted is still consumed.

The consumed-check and any replacement MUST be atomic with respect to context assembly.

If the host delivered the prior event into more than one context (multiple agents, forks),
it is consumed if it is consumed in **any** of them; the host MUST NOT replace in some
contexts and append in others.

If the host cannot determine the state of the prior event — restart with an in-memory index,
eviction, operator removal — the prior event is **consumed**.

## 4. Plain coalescing

For content that is **complete in itself**: reading only the newest event leaves the model
correctly informed, and reading an older one followed by the newest is merely redundant,
never wrong.

```jsonc
{ "method": "push/event", "params": {
    "featureSet": "body.status", "eventId": "evt_41", "timestamp": "…",
    "coalesce": { "key": "battery" },
    "payload": { "content": [ { "type": "text", "text": "Battery 79%" } ] } } }
```

After the admission checks the host would apply to the same event without `coalesce`
(enablement, grant, §14.5 receipt-time validation, §19.5 reference stubbing, §9.4 dedup) —
a refused event leaves the prior one untouched —

| Prior event under key | Host action | `outcome` |
|---|---|---|
| none | Append. Record as the key's occupant. | `"first"` |
| unconsumed | **Replace** (§4.1). Record new event as occupant. | `"replaced"` |
| consumed / unknown | Append. Record new event as occupant. | `"appended"` |

The server does the same thing in every row: nothing.

**Do not use plain mode for deltas.** "Inserted `caterpillar`" appended after a consumed
"inserted `cat`" double-reports. That is what deferred mode is for.

### 4.1 Replacement

The host removes the prior event from every context it was delivered to and inserts the new
one. The replacement SHOULD be positioned where a fresh event arriving now would go
(normally the tail), not in the prior event's slot: its content is true as of its own
`timestamp`.

The model-visible context MUST NOT contain any trace of the replaced event — no tombstone,
no "(edited)" marker, no collapse count. If the server wants the model to know changes were
folded, it says so in the content.

### 4.2 Wake

Replacement is a correction of an occurrence that is still pending, not a second occurrence.

- The host evaluates wake policy (including tags, §16) on the new event as on any event. If
  the replaced event had not qualified for a wake and the replacement does, the host wakes.
- If a wake attributable to the replaced event is already pending, the host MUST NOT
  schedule another.
- A host that debounces wakes MUST bound how far replacements can postpone a pending wake: a
  continuously changing subject must not starve the agent of ever hearing about it.

## 5. Deferred events

For content that is a **delta** relative to what the model last saw.

### 5.1 The notice

```jsonc
{ "method": "push/event", "params": {
    "featureSet": "gdoc.observe", "eventId": "evt_8f31", "timestamp": "…",
    "tags": ["gdoc:edit"],
    "coalesce": { "key": "doc:1AbC…:edits", "deferred": true },
    "payload": { "content": [
      { "type": "text", "text": "“Q4 plan” was edited (details unavailable — use get_document)." }
    ] } } }
```

`payload.content` is the **fallback**: what the model sees if rendering fails (§5.3). It
MUST be self-contained and SHOULD say how to get the detail by other means.

The host keeps at most one **pending slot** per key. A notice for a key with a pending slot
updates that slot's fallback, `tags`, `timestamp` and `eventId` and creates nothing
(`outcome: "replaced"`); otherwise it opens a slot (`"first"`). A slot is not
model-visible. Wake is as §4.2.

Servers send a notice whenever the subject changes (debounced). They do not compute a diff
at that point and do not need to know whether a slot is already open.

**Notice data.** A deferred notice MAY carry `coalesce.data`: an arbitrary JSON value,
at most 4 KiB serialized, private to the server. The host stores it with the slot, never
interprets it, never shows it to a model, and hands every retained notice's `data` back in
`push/render` (§5.2). This is what lets a server with no queryable source of truth — a
webhook relay, a commit feed — coalesce without buffering anything itself: the host holds
the run, the server folds it. Servers that *can* re-read their subject (a document) don't
need it, though it is a convenient place for hints such as who edited or which regions were
touched.

Hosts MUST retain at least the 64 most recent notices per slot and MAY drop older ones,
reporting how many were dropped.

### 5.2 `push/render` (Host → Server, Request)

When the host assembles a request that would include a pending slot, it first asks the
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
| `params.key` | `string` | The slot's key |
| `params.eventId` | `string` | `eventId` of the latest notice folded into the slot |
| `params.notices` | `Notice[]` | Every retained notice folded into the slot, oldest first: `eventId`, `timestamp`, and `data` if the notice carried one. Fallback content is not echoed. |
| `params.dropped` | `integer` | Notices older than `notices[0]` that the host discarded (§5.1). `0` if none. |
| `result.content` | `ContentBlock[]` | Everything that changed under this key **since the server's previous successful render of it** (or since observation began). MAY be empty. |
| `result.timestamp` | `string` | OPTIONAL. As-of time of the rendered state; defaults to receipt time |

**Server contract.** Return one description covering the whole run. A server may produce it
either way:

- **From the source.** Describe `last render → now`, then treat *now* as the new last
  render. State: one baseline per key, advanced on render instead of on push. `notices` can
  be ignored. Intermediate changes that cancelled out vanish, which is usually what is
  wanted.
- **From the notices.** Fold `notices[].data` — concatenate, count, summarize, whatever
  suits the subject. State: none. Render is then a pure function of its params, which also
  makes it safe for a host to retry. If `dropped > 0` the server SHOULD say so ("…and 12
  earlier changes").

**Host contract.** The host **materializes** the result as an ordinary, durable event —
positioned as a fresh event (§4.1), carrying the slot's `tags` and `origin` — closes the
slot, and proceeds with assembly. The materialized event is consumed by that request. The
host renders a slot **once**: if the slot was delivered to several contexts, the single
result is materialized into all of them at the first consumption by any.

**Empty content means nothing happened.** The subject returned to its baseline (the user
typed `cat` and deleted it). The host closes the slot and appends nothing. A wake that has
already fired is not undone; an agent that wakes to nothing new is a cost, not an error.

Rendered content is subject to every check a pushed payload would get (§19.5 stubbing, size
limits, content-block validation). If the feature set has been disabled since the notice,
the host MUST NOT call `push/render` and drops the slot.

### 5.3 Timeout and failure

`push/render` is on the inference path, so it follows hook discipline:

- Hosts SHOULD enforce a timeout; 5 seconds is RECOMMENDED (as `beforeInference`, §10.6).
  Hosts SHOULD render multiple pending slots concurrently.
- On timeout, error, or a disconnected server, the host materializes the **fallback**
  content instead and closes the slot. Inference is never failed or blocked beyond the
  timeout on account of a render.
- A server handling `push/render` MUST NOT issue `inference/request` (§10.7).
- A server whose render result was not delivered has nonetheless advanced its baseline, and
  that span of change is described to no one. This at-most-once gap is accepted: the
  fallback tells the model the subject changed and how to look, and for the subjects this
  mode targets the truth remains readable at the source. (§15 Q3 sketches an opt-in cursor.)

Compared with `context/beforeInference`, the call happens only when a slot is pending,
needs no injection grant, and its result becomes history rather than a per-request overlay.

### 5.4 Scope

`deferred` is defined for `push/event` only. Channel messages are self-contained; use plain
mode. A `channels/incoming` message with `deferred: true` is malformed (§12).

## 6. Retraction

For plain events whose subject ceased to exist before it was read — a chat message deleted
before the agent saw it, a transcript partial discarded as noise. (Deferred events do not
need it: an empty render is the retraction.)

```jsonc
"coalesce": { "key": "dmsg_123", "retract": true }, "payload": { "content": [] }
```

A retraction carries a fresh `eventId` and empty content (the one case in which §9.2's
`content` may be empty; hosts MUST ignore any content present).

| Occupant of key | Host action | `outcome` |
|---|---|---|
| unconsumed event, or pending slot | Remove it, no trace (§4.1). Forget the key. | `"retracted"` |
| consumed | Nothing. | `"consumed"` |
| none / unknown | Nothing. | `"absent"` |

A retraction never appends and is `accepted: true` whenever it passes admission. This is the
one place a server may care about an outcome: on `"consumed"`, a chat server sends today's
`chat:deleted` event. That is a stateless decision made in the response handler — no
baseline, nothing remembered.

A host MAY cancel a pending wake attributable solely to the retracted event.

## 7. Response

`push/event` results and `channels/incoming` per-message results gain an OPTIONAL member:

```ts
coalesce?: { outcome: "first" | "replaced" | "appended" | "retracted" | "consumed" | "absent";
             priorEventId?: string }
```

A supporting host MUST include it whenever the request carried `coalesce` and passed
admission. It is **informational**: apart from the retraction case above, no outcome
requires the server to do anything. A result without it means the host did not coalesce.

## 8. Server guidance (non-normative)

**Which mode?** Ask: *if the model reads only this event, having read or not read any
earlier one, is it correctly informed?* Yes → plain. Only if it read the earlier ones →
deferred.

| Subject | Mode | Key |
|---|---|---|
| Battery, presence, pose, spend gauge | plain | per gauge |
| Transcript hypothesis for an utterance | plain (+ `retract` for discarded partials) | per utterance |
| Chat message, edited or deleted before read | plain (+ `retract`) | platform message id |
| Document edits, comment-thread activity, "N new commits" | deferred | per document / thread / repo |

**The whole of a deferred server:**

```
on subject change (debounced):   push notice { key, deferred: true, fallback }
on push/render(key):             d = describe(baseline[key], now); baseline[key] = now; return d
```

Compare today's append-only server, which is the same two lines fused: on change, describe,
advance, push. Nothing is added but the split.

A server with nothing to re-read keeps no baseline at all:

```
on occurrence:                   push notice { key, deferred: true, data: occurrence, fallback }
on push/render(key, notices):    return summarize(notices.map(n => n.data))
```

Worked example:

```
t0  user types "cat"        → notice K                      → first   (slot opens; wake)
t1  (agent busy)
t2  user types "erpillar"   → notice K                      → replaced (same slot)
t3  agent turn assembles    ← push/render K → "inserted “caterpillar”"   (baseline := t3)
t4  user appends " soup"    → notice K                      → first   (new slot)
t5  agent turn assembles    ← push/render K → "inserted “ soup” after “caterpillar”"
```

**Negotiation.** Use `coalesce` only with a host advertising `eventCoalescing` (§9), and
`deferred` only if it advertises `deferred`. An older host ignores the unknown member: plain
events merely stack as they do today, but deferred notices would stack as fallbacks that
are never rendered. A server that must run against both keeps its append-only path for
hosts without `deferred` — which is the code it already has.

**Chat edits.** Send the edited text as a plain event keyed by message id, tagged
`chat:edited`. Unread original → the model sees one message (marked edited, which is true).
Read original → it sees the edit appended, exactly as today. No branch.

**Keep debouncing.** Coalescing removes the stack, not the traffic.

## 9. No new capability

Replacing or withdrawing one's own unread event, or supplying its content later rather than
sooner, grants no reach beyond `pushEvents` / `channels.incoming`: the server can put
strictly *less* in front of the model than appending would. There is no `uses` path and
nothing for RFC-002 to gate. (A new path would also be harmful: §6.2 invalidates a feature
set with an unrecognized `uses` value, so adopters would lose the whole feature set on
older hosts.) `push/render` is gated by the same grant as the notice it renders: the host
calls it only for a slot opened by an admitted `push/event` under a still-enabled feature
set.

Host support is a **new top-level member** of the host's `capabilities.experimental.mcpl`:

```jsonc
"eventCoalescing": true
// or, partially:
"eventCoalescing": { "pushEvents": true, "channelsIncoming": false, "deferred": true }
```

It is deliberately *not* a leaf under `pushEvents` or `channels`: §5.1 defines boolean
`true` as "every leaf beneath this node", so every existing host advertising
`"pushEvents": true` would be read as claiming support it lacks.

## 10. Security considerations

- **Admission is not bypassed.** Replacements and rendered content are validated as fresh
  events. A permissive first event cannot carry a later one past a check.
- **Own events only.** Key scope includes the server's connection identity.
- **Nothing a model saw can be altered.** A server cannot gaslight an agent about its own
  past: by construction the agent has no past with the replaced event.
- **Humans and logs are not models.** The host MUST retain replaced and retracted events,
  folded notices, and both the rendered and fallback content of a slot in its durable/audit
  record (§13.2), linked by `eventId`. Only the model-visible context is rewritten. Operator
  surfaces SHOULD show displaced events as displaced rather than hiding them.
- **Late binding.** With deferred mode the content is chosen at consumption time, so a
  server can decide what to say knowing inference is imminent. It learns nothing else (no
  content, no conversation identity — `push/render` carries only its own key), and
  `inference/lifecycle` already discloses as much. A host for which even that timing signal
  is sensitive should not advertise `deferred`.
- **Notice data is inert.** `coalesce.data` is stored and returned, never interpreted,
  never model-visible, and bounded (4 KiB × retained notices per slot). It gives the server
  nothing but its own bytes back. It is retained in the audit record with its notice.
- **Wake shaping.** A server could wake with an urgent tag and render something bland. It
  could equally have pushed the bland event with the urgent tag; tags are claims, never
  authority (§16.6). The audit record shows both.
- **Resource use.** Keys are bounded in size; hosts MAY bound live keys per server and evict
  (an evicted occupant is treated as consumed; an evicted slot is materialized as its
  fallback). Render is bounded by timeout.

## 11. Alternatives considered

- **`onConsumed: "reject"` + server resend (revision 1).** Correct, but every delta server
  needs two snapshots per key, outcome-driven transitions, and a resend path. Removed.
- **Dual payload** — every event carries both an incremental and a cumulative description
  and the host picks. No resend, but the server still tracks where the unread run began
  (from outcomes) and computes two diffs per event. Half the complexity of revision 1 for
  the same result deferred mode gives for none.
- **Reuse `eventId` to mean replace.** Collides with §9.4; existing hosts *drop* a repeated
  `eventId` as a duplicate (agent-framework `push-handler.ts`), so the newest state would be
  the one discarded.
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

## 12. Schema (amends Appendix B)

```ts
interface Coalesce { key: string; deferred?: boolean; retract?: boolean;
                     data?: unknown }   // deferred only; ≤ 4 KiB serialized; server-private
interface Notice   { eventId: string; timestamp: string; data?: unknown }
interface CoalesceResult {
  outcome: "first" | "replaced" | "appended" | "retracted" | "consumed" | "absent";
  priorEventId?: string;
}
interface PushRenderParams { featureSet: string; key: string; eventId: string;
                             notices: Notice[]; dropped: number }
interface PushRenderResult { content: ContentBlock[]; timestamp?: string }

// push/event params            += coalesce?: Coalesce
// push/event result            += coalesce?: CoalesceResult
// channels/incoming message    += coalesce?: Coalesce          (deferred MUST be absent/false)
// channels/incoming result[i]  += coalesce?: CoalesceResult
// host experimental.mcpl       += eventCoalescing?: boolean
//                                  | { pushEvents?: boolean; channelsIncoming?: boolean; deferred?: boolean }
// new method                      push/render  (Host → Server, Request)
```

A malformed `coalesce` (missing/oversized `key`; `retract` with `deferred`; `deferred` on
`channels/incoming`; `data` without `deferred` or over 4 KiB) MUST cause refusal (`accepted: false`, `reason: "coalesce_invalid"`),
not a silent append.

## 13. Conformance vectors

Plain:
1. **First.** Unseen key → appended; `"first"`.
2. **Replace.** E1(K), no inference, E2(K) → next request contains E2's content and no byte
   of E1's; `"replaced"`.
3. **Consumed.** E1(K), inference, E2(K) → history holds E1 unchanged, then E2; `"appended"`.
4. **Consumption at assembly.** E1(K); an inference including E1 fails before output;
   E2(K) → `"appended"`.
5. **Compression consumes.** E1(K) is summarized before any agent inference; E2(K) →
   `"appended"`.
6. **Scope isolation.** Same key string across two servers, two feature sets, two channels →
   no cross-replacement.
7. **Admission first.** E2(K) under a disabled feature set → refused; E1 remains replaceable.
8. **Restart.** E1(K); host restarts without a durable index; E2(K) → `"appended"`.

Deferred:
9. **One slot.** N1(K), N2(K), N3(K), no inference → exactly one `push/render` at next
   assembly; the request contains the rendered content once and no fallback text.
9a. **Notices returned.** In vector 9, `push/render` params carry N1–N3 oldest-first, each
    with the `data` it was sent with, byte-equivalent; `dropped: 0`. With 100 notices and a
    host retaining 64, `notices.length + dropped == 100` and the retained ones are the
    newest. No `data` value appears in any model request.
10. **Render is history.** After vector 9, a second inference with no new notice issues no
    `push/render` and its request contains the same materialized event, byte-identical.
11. **New slot after consumption.** N1(K), inference, N2(K) → `"first"`; second render.
12. **Empty render.** Render returns `content: []` → nothing appended; slot closed.
13. **Fallback.** Render times out / errors / server disconnected → fallback content
    materialized; inference proceeds within the timeout bound.
14. **Disabled before render.** Feature set disabled between notice and assembly → no
    `push/render`; nothing appended.
15. **Render once.** Slot delivered to two contexts → one `push/render`; both contexts
    receive the same materialized event.
16. **No inference from render.** A server issuing `inference/request` while handling
    `push/render` is refused (§10.7).

Both:
17. **Retract.** Unconsumed occupant or pending slot + `retract` → `"retracted"`, next
    request contains nothing from K. Consumed → `"consumed"`. Unknown → `"absent"`.
18. **Idempotent retry.** Same `eventId` twice → one effect; equal results.
19. **No second wake / no starvation.** Replacement before a pending wake fires → exactly
    one inference; replacements arriving faster than the debounce, forever → inference
    still occurs within the host's bound.
20. **Audit.** After vectors 2 and 9 the durable record contains E1, and N1–N3 with both
    rendered and fallback content, each marked displaced/folded.
21. **Malformed.** 257-byte key; `retract`+`deferred`; `deferred` on `channels/incoming` →
    `coalesce_invalid`; nothing appended.

## 14. Implementation notes (non-normative)

- **agent-framework.** `PushHandler` already owns `eventId` dedup and is the natural home
  for the `(serverId, featureSet, key) → occupant` index. The context manager already has
  `removeMessage` / `addMessage`. Missing pieces: a per-message *consumed* watermark set at
  request assembly (agent inference **and** compression), and a pre-assembly step that
  renders pending slots — adjacent to where `HookOrchestrator` runs `beforeInference`, and
  able to share its timeout plumbing. The cache rule — mutate only beyond the last cache
  marker — is implied by "unconsumed" but worth asserting. The index is in-memory today, so
  vector 8's fail-toward-consumed is the behaviour to implement; slots lost in a restart
  should be materialized as fallbacks rather than dropped if the host can persist that much.
- **mcpl-cc-bridge.** Deliveries held by the wake policy (the `<held>` block) are
  unconsumed until the hook flushes them; plain replacement is a keyed overwrite of the held
  queue and rendering happens in the flush. Anything already emitted as a `<channel>` block
  is consumed.
- **First servers.** A Google Docs server (deferred; edits keyed per document, comments per
  thread); mcpl-editor (its debounce stays, `firePushEvent` splits into notice + render);
  voice/transcript servers (plain, key per utterance); discord-mcpl edit/delete-before-read.

## 15. Open questions

1. **Split `channels/incoming` into a follow-up?** Plain mode is identical there, but hosts
   map channel messages onto turns with more freedom (§14.3) and replacement inside a
   batched user turn may be awkward. The per-lane advertisement lets a host opt out.
2. **Tail positioning (§4.1) as SHOULD**, or in-place as default? Tail is more truthful
   about time; in-place is simpler.
3. **Opt-in render cursor.** To close the at-most-once gap (§5.3): `push/render` result MAY
   carry an opaque `cursor`; the host passes back, on the next render of that key, the
   cursor of the last render it *durably materialized*; a server able to re-describe from a
   cursor does so. Costs the host one durable string per key and costs servers that ignore
   it nothing. Deferred until a server needs it.
4. **Un-consume after a traceless request?** Revision 1 allowed a host to treat an event as
   unconsumed again if the only request that included it left no output, cache entry, or
   derived artifact (refusal-rewind is the case). Dropped here for simplicity; with deferred
   mode the materialized event is simply history either way.
5. **`reason` vocabulary.** `coalesce_invalid` is a machine-meaningful `reason` on
   `push/event`, where §9.3 treats `reason` as free text.
