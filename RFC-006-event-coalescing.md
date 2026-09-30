# MCPL RFC-006: Event Coalescing

**Status:** Draft (revision 5)
**Targets:** MCPL Protocol Specification 0.5
**Authors:** Claude Code, from a scope proposed by antra; revised after review
**Date:** 2026-09-21 (revisions 1, 2); 2026-09-22 (revision 3); 2026-09-23 (revision 4); 2026-09-30 (revision 5)
**Depends on:** nothing for authority — RFC-002 / SPEC §5.4 remains the sole source of what
a connected server may do, and this RFC adds no `uses` path (§10). Amends SPEC §9
(`push/event` params and result; new `push/render` method), §9.4 (idempotency), §14.3
(`channels/incoming` message and per-message result). Interacts with §10.6 (hook
timeouts), §10.7 (loop prevention), §13.2 (audit), §13.3 (hook failure policy), §14.5
(channel scoping), §16 (tags), Appendix A (error codes).

> **Revision 5 note.** A plain occurrence supersedes **all older unconsumed work** for its
> subject, including both a frozen render and a batch opened during that render. Revision
> 4 cancelled the frozen batch but kept the second batch, contradicting latest-mode-wins
> and allowing old notice data to reappear after a newer complete snapshot. The reverse
> transition (plain → deferred) now explicitly displaces the unread plain occurrence.
> Vectors 27g–27j cover both transitions and notices arriving after the replacement.

> **Revision 4 note.** Review of revision 3 (antra, PR #5) found two protocol gaps and one
> wrong example:
>
> - **`eventId` is REQUIRED on a coalesced `channels/incoming` message (§3.1).** Revision 3
>   left it optional with dedup falling back to `messageId`, so a coalesced edit that omitted
>   it collided with its own create and was dropped as a duplicate. Legacy messages without
>   `coalesce` keep the optional field; omission with `coalesce` is a per-message
>   `coalesce_invalid`.
> - **Retract and plain replacement during an in-flight render (§5.4 rules 6–7).** Revision
>   3 specified a *notice* arriving mid-render but not a retract or a plain occurrence. A
>   frozen render's late completion could resurrect withdrawn content or overwrite a
>   replacement. Now a frozen batch that is withdrawn or superseded before materialization is
>   *cancelled*: its result, when it arrives, is discarded, and no fallback is materialized
>   for it. If materialization already won the race, the normal consumed/history rules
>   apply. The boundary is atomic.
> - **§9.2's alternate timeline was wrong.** Inference after edit 1 sees edit 1 alone (the
>   original was *replaced*), so create → edit 1 → inference → edit 2 → delete yields
>   `first, replaced, appended, noted`, and the final history is edit 1 + the deletion notice.

> **Revision 3 note.** Review of revision 2 (antra, PR #5) found three structural holes and
> two under-specified areas; all are addressed here, keeping plain coalescing and deferred
> rendering as they were.
>
> - **Identity is split three ways (§3.1).** Revision 2 required a fresh `messageId` per
>   edit on `channels/incoming`, which breaks reply targets. Now `messageId` is the stable
>   platform message, `eventId` is the occurrence (create / edit / delete), and
>   `coalesce.key` is the subject. `channels/incoming` gains an OPTIONAL `eventId`, and
>   dedup is by occurrence.
> - **Channel scope is explicit across delivery methods (§3.2).** discord-mcpl and
>   portal-mcpl deliver creates via `channels/incoming` when a channel is open and
>   `push/event` when it is closed; edits and deletes are always `push/event`. Revision 2's
>   "keys never cross methods" made those unrelated subjects. A push may now opt into a
>   channel's key namespace with `coalesce.channelId`, admitted against current channel
>   authorization — never inferred from `origin`.
> - **Deletion is one atomic host operation (§6).** Revision 2's "retract, inspect outcome,
>   maybe send `chat:deleted`" had a real defect: *original read → edit pending → delete*
>   retracted the edit, reported success, and left the read original uncorrected. Now
>   `retract` carries the deletion notice; the host removes any pending version **and**
>   appends the notice iff any version of the subject was ever consumed or its history is
>   unknown. Hosts keep a per-subject consumed-history bit past consumption; eviction
>   degrades it to *unknown*, never to *known unread*.
> - **Deferred rendering is a state machine (§5.4):** starting a render freezes its batch,
>   later notices open a new one, a late response cannot displace a materialized fallback,
>   authorization is re-checked when the response arrives, and the whole mode is declared
>   best-effort with different failure consequences for source-backed and notice-only
>   servers.
> - **Open questions are closed (§16):** `channels/incoming` stays; tail positioning stays
>   SHOULD; consumption is permanent; malformed `push/event` is a JSON-RPC error and
>   malformed `channels/incoming` messages are per-message partial failures. Vectors for
>   every case the review named are added (§14), with Discord and Portal worked examples
>   beside Google Docs (§9).

> **Revision 2 note** (retained). Revision 1 handled delta-describing events with
> `onConsumed: "reject"` and a server resend; that forced two snapshots per key and
> outcome-driven state into every delta server. Revision 2 replaced it with deferred events
> and `push/render`, so a server's baseline advances exactly when it renders and it needs
> no state it does not already keep. Plain coalescing was narrowed to self-contained
> content. The cost moved to the host: one bounded, fallback-protected request on the
> inference path, only when a slot is pending.

---

## 1. Summary

Some events describe a **moving subject**: a document being typed into, a partial speech
transcript being revised, a sensor reading, a chat message edited seconds after it was sent.
Today every observation of such a subject is a separate, append-only event. If the model has
not run yet, the host's context fills with a stack of stale intermediate states — `cat`,
then `cater`, then `caterpillar` — that the model must read, pay for, and mentally collapse.

This RFC adds an OPTIONAL **`coalesce`** member to `push/event` params and
`channels/incoming` messages, naming a server-chosen **key**, with two modes and one
withdrawal form:

- **Plain** — for *self-contained* content (a value, a full message, a transcript
  hypothesis). A new event replaces the previous event under the same key **iff no model
  has consumed it**; otherwise it appends. Stateless for the server.
- **Deferred** — for *delta* content ("what changed since you last looked"). The server
  pushes a keyed notice; the host calls **`push/render`** when it is about to show the event
  to a model, and the server describes everything since its previous render. Repeated
  notices under one key collapse into one pending slot.
- **Retract** — the subject ceased to exist. The host removes any pending version and
  appends the server's deletion notice only if a model ever saw a version.

One rule governs all three:

> **Unconsumed events are mutable by their sender. Consumed events are history, and history
> is never rewritten.**

The host is the only party that knows where that boundary is. Plain mode lets the host apply
it; deferred mode lets the host *ask at* it; retraction lets the host *decide across* it. In
no mode does the server have to learn where it was.

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
- **Chat edits and deletes.** A message edited or deleted before the agent saw it should
  simply *be* the edited message, or be gone. A message deleted *after* the agent saw it
  needs a deletion notice. Today's servers can only ever do the second, and the host is the
  only party that knows which case applies.

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
   keep, never resends, and never branches on what the host did.
3. **Stateless key, not an event chain.** The server names the subject, not the prior
   event.
4. **Fail toward today.** On any uncertainty — unknown key, restart, eviction, mixed
   delivery — the host behaves as an append-only host would: it appends, and it keeps the
   deletion notice. The worst outcome is current behaviour.
5. **No new authority.** A server may only touch its own events, only before anyone has
   read them, within a scope it is currently authorized for, and everything it supplies
   passes the checks a fresh event would (§10, §11).
6. **Additive.** Absent `coalesce`, nothing changes.

## 3. Identity, scope, and consumption

### 3.1 Three identities

| Field | Answers | Where | Stability |
|---|---|---|---|
| `messageId` | *which message* | `channels/incoming` | Stable across the message's life: creates, edits, and deletes of one platform message share it. Reply/quote targets refer to it. |
| `coalesce.key` | *which subject's pending updates collapse* | both | Stable for the subject. For chat, RECOMMENDED `message:<messageId>`. For a document, per document or region. |
| `eventId` | *which occurrence* | both (NEW on `channels/incoming` messages: OPTIONAL without `coalesce`, **REQUIRED** with it) | Fresh per occurrence. Reused **only** when retrying that same occurrence. |

**Idempotency (amends §9.4).** Hosts deduplicate by occurrence: `eventId` when present,
else `messageId`. A `channels/incoming` message whose `messageId` the host has seen but
whose `eventId` is new is a **new occurrence of an existing message** — an edit — not a
duplicate. A retry (same `eventId`) SHOULD receive the same result as the original.

A `channels/incoming` message that carries `coalesce` **MUST** carry a non-empty `eventId`.
Without it the `messageId` fallback would make an edit a duplicate of its own create, and
the newest state would be the one discarded. Omission is a per-message validation failure
(`coalesce_invalid`, §13); the message is not admitted and its subject is untouched.
Messages without `coalesce` keep today's behaviour.

> Deterministic occurrence ids that omit the occurrence — `discord_edit_<messageId>` — are
> a defect this table makes visible: the second edit of a message collides with the first
> and is dropped as a duplicate by any §9.4-conformant host. Occurrence ids MUST
> distinguish occurrences (a counter, revision id, or edit timestamp suffices).

### 3.2 Key scope

A key lives in exactly one **scope**, and the full subject identity is the tuple

```
(server connection identity, scope kind, scope id, key)
```

| Delivery | Scope kind | Scope id |
|---|---|---|
| `channels/incoming` message | `channel` | the message's `channelId` |
| `push/event` without `coalesce.channelId` | `featureSet` | the event's `featureSet` |
| `push/event` with `coalesce.channelId` | `channel` | `coalesce.channelId` |

Two servers, two feature sets, or two channels can never address each other's subjects.
A `channel`-scoped push and a `channels/incoming` message with the same `channelId` and
`key` address the **same subject** — which is what lets a create delivered by one method be
edited or deleted by the other without the server remembering which method it used.

**Channel-scoped pushes are admitted against current channel authority.** A `push/event`
carrying `coalesce.channelId` MUST pass ordinary push admission (feature set enabled,
`pushEvents` granted) **and** the checks a `channels/incoming` message for that channel
would pass at this moment: the channel is registered by this server, and `channels.incoming`
is granted and not narrowed away from it (§14.5). A push that fails the channel checks is
refused with `-32017 Channel not permitted` or `-32023 Unknown channel` (§14.6), and no
subject is touched. Hosts MUST NOT derive scope from `origin`, `metadata`, or any other
untrusted field; only `coalesce.channelId` selects channel scope, and only when the host
advertises `channelScopedPush` (§10).

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
have a newer pending batch (§5.4); a subsequent plain occurrence supersedes both. Changing
mode never removes consumed history.

### 3.3 Consumption

An occurrence is **consumed** once its content has been included in the assembly of any
request to any model — agent inference, a subagent, summarization/compression, or a
server-initiated `inference/request`. Consumption is determined **at context assembly**, not
at response: an occurrence in a request that later fails, is refused, or is aborted is still
consumed. Consumption is **permanent**; there is no un-consume (§16).

A **subject** has *consumed history* if any occurrence under it was ever consumed. Hosts
MUST track this per subject as a tri-state — `none` / `some` / `unknown` — for as long as
they track the subject, and MUST degrade it to `unknown`, never to `none`, on eviction,
restart without durable state, or operator intervention. `none` is a positive claim; the
host makes it only when it has held the subject's complete history.

The consumed-check and any replacement or removal MUST be atomic with respect to context
assembly. If a prior occurrence was delivered into several contexts, it is consumed if
consumed in **any**; the host MUST NOT replace in some and append in others.

## 4. Plain coalescing

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
(enablement, grant, §14.5 receipt-time validation, §19.5 reference stubbing, §3.1 dedup,
and §3.2 channel checks when channel-scoped) — a refused occurrence leaves the prior one
untouched —

| Occupant of subject | Host action | `outcome` |
|---|---|---|
| none | Append. Record as occupant. | `"first"` |
| unconsumed (incl. a pending or rendering batch, §5.4 rule 6) | **Replace** (§4.1). Record new occurrence as occupant. | `"replaced"` |
| consumed, or history `unknown` | Append. Record new occurrence as occupant. | `"appended"` |

The server does the same thing in every row: nothing.

**Do not use plain mode for deltas.** "Inserted `caterpillar`" appended after a consumed
"inserted `cat`" double-reports. That is what deferred mode is for.

### 4.1 Replacement

The host removes the prior occurrence from every context it was delivered to and inserts
the new one, within the audience rule of §3.2. The replacement SHOULD be positioned where a
fresh event arriving now would go (normally the tail), not in the prior occurrence's slot:
its content is true as of its own `timestamp`.

The model-visible context MUST NOT contain any trace of the replaced occurrence — no
tombstone, no "(edited)" marker, no collapse count. If the server wants the model to know
changes were folded, it says so in the content.

### 4.2 Wake

Replacement is a correction of an occurrence that is still pending, not a second occurrence.

- The host evaluates wake policy (including tags, §16) on the new occurrence as on any
  event. If the replaced occurrence had not qualified for a wake and the replacement does,
  the host wakes.
- If a wake attributable to the replaced occurrence is already pending, the host MUST NOT
  schedule another.
- A host that debounces wakes MUST bound how far replacements can postpone a pending wake:
  a continuously changing subject must not starve the agent of ever hearing about it.

## 5. Deferred events

For content that is a **delta** relative to what the model last saw. `push/event` only
(§5.5).

### 5.1 The notice

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

`payload.content` is the **fallback**: what the model sees if rendering fails (§5.3). It
MUST be self-contained and SHOULD say how to get the detail by other means.

The host keeps at most one **pending batch** per subject. A notice for a subject with a
pending batch joins it and updates the batch's fallback, `tags`, `timestamp` and latest
`eventId` (`outcome: "replaced"`). If an unread plain occurrence occupies the subject,
the notice removes that occurrence and opens a batch (`"replaced"`), retaining only the
prior audience as §3.2 requires. Otherwise it opens a batch (`"first"`). Consumed plain
occurrences remain history. A batch is not model-visible. Wake is as §4.2.

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

### 5.2 `push/render` (Host → Server, Request)

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
| `params.channelId` | `string` | Present iff the subject is channel-scoped (§3.2) |
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
  concurrently (possible after a host timeout, §5.4) MUST NOT both describe the same span or
  leave a span described by neither.
- **From the notices.** Fold `notices[].data` — concatenate, count, summarize. State: none.
  Render is a pure function of its params. If `dropped > 0`, the server **MUST** say so in
  the content ("…and 12 earlier changes not shown"): a notice-only server has no other way
  to recover them, and silence would misreport coverage.

**Host contract.** The host **materializes** the result as an ordinary, durable occurrence —
positioned as a fresh event (§4.1), carrying the batch's `tags` and latest `origin`,
delivered to the batch's contexts (§3.2 audience) — and proceeds with assembly. The
materialized occurrence is consumed by that request. If the batch was delivered to several
contexts, one render serves all of them at the first consumption by any.

**Empty content means nothing happened.** The subject returned to its baseline (the user
typed `cat` and deleted it). Nothing is appended. A wake that already fired is not undone.

Rendered content is subject to every check a pushed payload would get (§19.5 stubbing, size
limits, content-block validation).

### 5.3 Timeout and failure

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
  notices are consumed unrendered. Their `data` remains in the audit record only. A server
  whose stream is unrecoverable and for whom that matters SHOULD carry enough in the
  fallback to be useful on its own.

An opt-in render cursor that would close the source-backed gap is deferred (§16).

### 5.4 State machine

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
        ▼               ▼                   ▼                    │ (discard, audit)
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
   materialized the fallback is discarded and audit-logged; it MUST NOT replace or amend
   the fallback, even if the fallback is still unconsumed.
4. **Authorization is re-checked at response.** Before materializing a result (or a
   fallback), the host re-runs the batch's admission: feature set still enabled,
   `pushEvents` still granted, and for channel-scoped subjects the §3.2 channel checks. If
   any fails, the host materializes nothing and drops the batch. A batch whose authority
   lapsed *before* assembly is dropped without calling `push/render`.
5. **Rendered content is admitted as content.** The result passes the checks of §5.2
   regardless of what the notices' fallbacks passed.
6. **Retraction or plain replacement during a render cancels the frozen batch.** A
   `retract` (§6) or a plain occurrence (§4) for the subject that arrives while its batch
   is RENDERING acts on the subject as if the frozen batch were an unconsumed occupant:
   retraction removes it; a plain occurrence displaces it and becomes the occupant. The
   batch enters CANCELLED. When the render then completes — with a result, empty, or by
   timeout/error — the host materializes **nothing** for it: the result is discarded and
   audit-logged, and no fallback is materialized. The cancelling operation's own effect
   (nothing, or the plain occurrence, or the deletion notice per §6) is what the model sees.
   A pending batch opened by a notice that arrived after the render started (rule 1) is
   removed by **either** operation: a newer plain occurrence is a complete snapshot and
   supersedes all earlier unconsumed notices, not just the frozen batch. Removed notices
   remain in the audit record. A notice admitted **after** the plain occurrence is new
   work and follows §5.1; cancellation cannot discard that later notice.
7. **The race is decided at materialization, atomically.** If the host has materialized
   the frozen batch (result or fallback) before the retraction or plain occurrence is
   admitted, the materialized occurrence is an ordinary occupant: unconsumed → it is
   replaced or removed as §4/§6 say; consumed → history is `some` and §4/§6 apply. The
   check "is this batch still pending, rendering, or materialized?" and the resulting
   action MUST be one atomic step with respect to the render completion path, so that a
   result and a cancellation cannot both take effect. Servers see nothing of the race:
   their render response is acknowledged either way.

### 5.5 Scope

`deferred` is defined for `push/event` only (feature-set- or channel-scoped). Channel
messages are self-contained; use plain mode. A `channels/incoming` message with
`deferred: true` is malformed (§13).

## 6. Retraction

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
version of the subject*. It MAY be empty for pure withdrawal (a discarded transcript partial
has nothing to announce). For chat deletions it **MUST** be non-empty: a model that read a
message must learn it is gone.

The host removes any unconsumed occupant, pending batch, or **rendering batch** (which
becomes CANCELLED, §5.4 rule 6) of the subject from every context it was delivered to (no
trace, §4.1), then decides on the notice by the subject's consumed history (§3.3):

| Consumed history | Pending version | Host action | `outcome` |
|---|---|---|---|
| `none` (positively known) | any / none | Remove pending; append **nothing** | `"retracted"` |
| `some` | any / none | Remove pending; **append the notice** as an ordinary occurrence (tail) | `"noted"` |
| `unknown` (evicted, restarted, never tracked) | any / none | Remove pending if any; **append the notice** | `"noted"` |
| `some` or `unknown`, and `content` is empty | any / none | Remove pending; append nothing | `"consumed"` |

**The check covers every version, not the current occupant.** *Original read → edit
pending → delete*: history is `some`, so the host removes the pending edit **and** appends
the notice. Revision 2 got this wrong.

A subject the host has never heard of is `unknown`, not `none`: the host cannot distinguish
"never sent" from "evicted", and the conservative result — the notice appears, as it does
today — costs one line of context.

A retraction is `accepted: true` whenever it passes admission (which, for channel-scoped
retractions, includes §3.2's channel checks). A host MAY cancel a pending wake attributable
solely to a removed occupant; it MUST evaluate wake policy on an appended notice as on any
event. After a retraction the subject's slot is empty; its consumed-history bit persists per
§3.3.

## 7. Response

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

## 8. Server guidance (non-normative)

**Which mode?** Ask: *if the model reads only this occurrence, having read or not read any
earlier one, is it correctly informed?* Yes → plain. Only if it read the earlier ones →
deferred. Subject gone → retract, with a notice if a reader would need one.

| Subject | Mode | Scope | Key |
|---|---|---|---|
| Battery, presence, pose, spend gauge | plain | featureSet | per gauge |
| Transcript hypothesis for an utterance | plain; `retract` (empty) for discarded partials | featureSet | per utterance |
| Chat message: create, edit, delete | plain; `retract` (with notice) | channel | `message:<messageId>` |
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
            + coalesce.key = "message:" + id
on edit:    push { eventId: fresh, coalesce: { channelId, key }, tags: ["chat:edited"],
                   content: edited text }
on delete:  push { eventId: fresh, coalesce: { channelId, key, retract: true }, tags: ["chat:deleted"],
                   content: "Message <id> by <author> was deleted." }
```

No branch on any outcome. The `chat:edited` tag on an edit that *replaces* an unread
original is harmless — the model sees one message, marked edited, which is true.

**Negotiation.** Use `coalesce` only with a host advertising `eventCoalescing` (§10),
`deferred` only under `deferred`, and `coalesce.channelId` only under `channelScopedPush`.
An older host ignores the unknown member: plain events stack as today, retractions append
their notice as today, but deferred notices would stack as fallbacks that are never
rendered — a server that must run against both keeps its append-only path for hosts without
`deferred`.

**Keep debouncing.** Coalescing removes the stack, not the traffic.

## 9. Worked examples (non-normative)

### 9.1 Google Docs (deferred, feature-set scope)

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

### 9.2 Discord (plain + retract, channel scope, mixed delivery)

Channel `discord:general` is **open**. Alice posts, edits twice, then deletes — all before
the agent runs:

```
create   channels/incoming { messageId: 123, eventId: c123,   coalesce: { key: "message:123" } }  → first
edit 1   push/event        { eventId: e123a, coalesce: { channelId, key } }                     → replaced
edit 2   push/event        { eventId: e123b, coalesce: { channelId, key } }                     → replaced
delete   push/event        { eventId: d123,  coalesce: { channelId, key, retract: true },
                             content: "Message 123 by Alice was deleted." }                       → retracted
```

The model never sees anything: history is `none`. Had the agent run **after edit 1**, the
same four requests yield `first`, `replaced`, `appended`, `noted`: edit 1 had already
replaced the unread original, so the model saw edit 1 alone; edit 2 is appended as a new
unconsumed occupant, then removed unread by the retraction; and the deletion notice lands
because history is `some`. Final model-visible history: edit 1, then the notice. The server
sent identical requests in both timelines.

Channel **closed**: the create arrives via `push/event` with `coalesce.channelId`; the
tuple is the same, so the edits and delete address the same subject. If the channel closes
*between* create and edit, the edit is admitted against current authority (§3.2) and, if
admitted, replaces the pending create in the contexts it reached — not in any new ones.

### 9.3 Portal (plain + retract, channel scope)

Portal already tags deletions `chat:deleted` and pushes `[message deleted] <id>` — today
unconditionally. With `coalesce: { channelId, key: "message:<id>", retract: true }` and the
same content, that line appears only when the model saw the message. Portal's wake policy
(`chat:deleted → mute`) is unchanged: the appended notice is evaluated by it like any event.

### 9.4 Read original → unread edit → delete (the revision-2 defect)

```
create   → first        agent runs: original CONSUMED, history := some
edit     → appended     (original consumed; edit is a new unconsumed occupant)
delete   → noted        edit REMOVED (unconsumed); notice APPENDED (history is some)
```

Model-visible: original, then "Message 123 by Alice was deleted." Revision 2 produced
original alone, uncorrected.

## 10. No new capability

Replacing or withdrawing one's own unread occurrence, or supplying its content later rather
than sooner, grants no reach beyond `pushEvents` / `channels.incoming`: the server can put
strictly *less* in front of the model than appending would, only in scopes it is currently
authorized for. There is no `uses` path and nothing for RFC-002 to gate. (A new path would
also be harmful: §6.2 invalidates a feature set with an unrecognized `uses` value, so
adopters would lose the whole feature set on older hosts.) `push/render` is gated by the
same grant as the notice it renders (§5.4 rule 4). Channel-scoped pushes are gated by the
grant `channels/incoming` for that channel would need (§3.2).

Host support is a **new top-level member** of the host's `capabilities.experimental.mcpl`:

```jsonc
"eventCoalescing": true
// or, partially:
"eventCoalescing": { "pushEvents": true, "channelsIncoming": true,
                     "deferred": false, "channelScopedPush": true }
```

It is deliberately *not* a leaf under `pushEvents` or `channels`: §5.1 defines boolean
`true` as "every leaf beneath this node", so every existing host advertising
`"pushEvents": true` would be read as claiming support it lacks.

## 11. Security considerations

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
  appends a notice rather than deleting anything read.
- **Deletion cannot hide a read message.** The consumed-history bit degrades only toward
  `unknown`, which yields the notice. A host that cannot remember whether the model saw
  something behaves as though it did.
- **Humans and logs are not models.** The host MUST retain replaced and removed
  occurrences, folded notices with their `data`, both rendered and fallback content, and
  discarded late render results in its durable/audit record (§13.2), linked by `eventId`.
  Only the model-visible context is rewritten. Operator surfaces SHOULD show displaced
  occurrences as displaced.
- **Late binding.** With deferred mode the content is chosen at consumption time. The
  server learns that an inference is imminent and nothing else — no content, no
  conversation identity; `push/render` carries only its own subject. `inference/lifecycle`
  already discloses as much. A host for which even that timing is sensitive should not
  advertise `deferred`.
- **Notice data is inert.** `coalesce.data` is stored and returned, never interpreted, never
  model-visible, bounded (4 KiB × retained notices per batch).
- **Wake shaping.** A server could wake with an urgent tag and render something bland. It
  could equally have pushed the bland event with the urgent tag; tags are claims, never
  authority (§16.6). The audit record shows both.
- **Resource use.** Keys are bounded; hosts MAY bound tracked subjects per server and evict
  (an evicted occupant is treated as consumed; an evicted batch is materialized as its
  fallback; an evicted history bit becomes `unknown`). Render is bounded by timeout.

## 12. Alternatives considered

- **`onConsumed: "reject"` + server resend (revision 1).** Correct, but every delta server
  needs two snapshots per key, outcome-driven transitions, and a resend path.
- **Retract, inspect outcome, then send `chat:deleted` (revision 2).** Two requests and a
  server branch, and wrong for *read original → unread edit → delete*. The host already
  holds the history; the decision belongs to it.
- **Fresh `messageId` per edit (revision 2).** Breaks reply targets and every consumer that
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

## 13. Schema and errors (amends Appendix A, Appendix B)

```ts
interface Coalesce {
  key: string;            // 1..256 bytes UTF-8, opaque to the host
  channelId?: string;     // push/event only: select channel scope (§3.2). Requires channelScopedPush.
  deferred?: boolean;     // push/event only. Default false.
  retract?: boolean;      // Default false. Exclusive with deferred.
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
// channels/incoming message    += eventId?: string            (occurrence id; §3.1 — REQUIRED when coalesce present)
//                              += coalesce?: Coalesce          (channelId, deferred MUST be absent)
// channels/incoming result[i]  += coalesce?: CoalesceResult
// host experimental.mcpl       += eventCoalescing?: boolean
//     | { pushEvents?: boolean; channelsIncoming?: boolean; deferred?: boolean; channelScopedPush?: boolean }
// new method                      push/render  (Host → Server, Request)
```

**Malformed `coalesce`** — missing or oversized `key`; `retract` with `deferred`; `data`
without `deferred` or over 4 KiB; `deferred` or `channelId` on a `channels/incoming`
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

## 14. Conformance vectors

Plain:
1. **First.** Unseen subject → appended; `"first"`.
2. **Replace.** E1(K), no inference, E2(K) → next request contains E2's content and no byte
   of E1's; `"replaced"`.
3. **Consumed.** E1(K), inference, E2(K) → history holds E1 unchanged, then E2; `"appended"`.
4. **Consumption at assembly.** E1(K); an inference including E1 fails before output;
   E2(K) → `"appended"`.
5. **Compression consumes.** E1(K) is summarized before any agent inference; E2(K) →
   `"appended"`.
6. **Repeated edits.** Create, edit₁, edit₂, edit₃, no inference → one occurrence in the
   next request, edit₃'s content, `"replaced"` ×3.
7. **Restart.** E1(K); host restarts without a durable index; E2(K) → `"appended"`.

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
20. **Empty render.** Result `content: []` → nothing appended; batch closed.
21. **Fallback.** Render times out / errors / server disconnected → fallback materialized;
    inference proceeds within the timeout bound.
22. **Notices during render.** N1(K); render starts; N2(K) arrives → `"first"`; render
    params contain N1 only; result materialized; next assembly renders a batch containing
    N2 only.
23. **Late result.** Render times out, fallback materialized (still unconsumed); result
    arrives → discarded, audit-logged; model-visible content is the fallback.
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
    (history `none`) → `"retracted"`; result arrives → discarded, audit-logged; next request
    contains nothing from K — neither rendered content nor fallback nor notice.
27b. **Retract during render, timeout.** As 27a but the render times out → no fallback
    materialized; next request contains nothing from K.
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
33. **Chat notice required.** Retract on a channel-scoped subject with empty content →
    `-32602`.
34. **History persists past slot.** Create; inference; retract (`"noted"`); new create
    under the same K; retract → `"noted"` (bit is `some`, not reset by the empty slot).

Both:
35. **Idempotent retry.** Same `eventId` twice → one effect; equal results.
36. **No second wake / no starvation.** Replacement before a pending wake fires → exactly
    one inference; replacements arriving faster than the debounce, forever → inference
    still occurs within the host's bound.
37. **Audit.** After vectors 2, 16, 23 and 29 the durable record contains E1; N1–N3 with
    rendered and fallback content; the discarded late result; and the removed edit — each
    marked displaced/folded/discarded.
38. **Malformed, per lane.** 257-byte key on `push/event` → `-32602`. In a
    `channels/incoming` batch of three where the second has `deferred: true` → results
    `[accepted, {accepted:false, reason:"coalesce_invalid"}, accepted]`.

## 15. Implementation notes (non-normative)

- **agent-framework.** [PR #196](https://github.com/anima-research/agent-framework/pull/196)
  implements the feature-set-scoped `pushEvents` / `deferred` profile. Pending content
  stays outside context managers until activation assembly, when it is materialized and
  conservatively sealed before compilation. Chronicle records the audit trail and pending
  fallbacks; recovery rechecks current authority without repeating a source-backed render.
  Host support explicitly leaves `channelsIncoming` and `channelScopedPush` false. Channel
  and mixed-delivery vectors therefore remain follow-up work, as does delivery at live tool
  continuation boundaries. The companion's state-machine, gate, and WebSocket tests cover
  its advertised profile, including revision 5's mode transitions. This is a proposed host
  implementation, not evidence that the whole RFC is deployed.
- **mcpl-cc-bridge.** Deliveries held by the wake policy (the `<held>` block) are
  unconsumed until the hook flushes them; plain replacement is a keyed overwrite of the
  held queue, rendering happens in the flush, and anything already emitted as a
  `<channel>` block is consumed.
- **discord-mcpl / portal-mcpl.** Add `coalesce.key = "message:<id>"` and an `eventId` on
  creates (both paths), `coalesce.channelId` + fresh occurrence ids on edits (fixing the
  `discord_edit_<id>` collision), and `retract` + notice on deletes. Portal's
  `[message deleted]` push becomes the retraction's content unchanged.
- **First deferred servers.** A Google Docs server (edits keyed per document, comments per
  thread); mcpl-editor (its debounce stays, `firePushEvent` splits into notice + render).

## 16. Decisions (formerly open questions)

1. **`channels/incoming` stays in this RFC.** Plain mode and retraction are identical
   across lanes, and the mixed-delivery cases (§9.2) are the point; splitting would leave
   chat servers with half a mechanism. Hosts that cannot replace inside a batched user turn
   advertise `channelsIncoming: false`.
2. **Tail positioning is SHOULD.** A replacement's content is true as of its own
   timestamp; placing it where the stale occurrence sat would misorder it against anything
   that arrived between.
3. **Consumption is permanent.** No un-consume after a traceless request; with deferred
   mode the materialized occurrence is history either way, and refusal-rewind's marker is
   an ordinary event.
4. **Render cursor is deferred, not adopted.** The at-most-once gap (§5.3) is accepted for
   source-backed servers. If a server needs exactly-once coverage, a follow-up may add an
   opaque `cursor` echoed by the host on the next render of that subject.
5. **Malformed requests are errors.** `-32602` on `push/event`; per-message
   `coalesce_invalid` on `channels/incoming`, because that lane already defines partial
   acceptance and a whole-batch error would discard valid siblings.
