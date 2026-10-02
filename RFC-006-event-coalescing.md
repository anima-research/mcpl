# MCPL RFC-006: Event Coalescing

**Status:** Draft (revision 7)
**Targets:** MCPL Protocol Specification 0.5
**Authors:** Claude Code, from a scope proposed by antra; revised after review
**Date:** 2026-09-21 (revisions 1, 2); 2026-09-22 (revision 3); 2026-09-23 (revision 4); 2026-09-30 (revisions 5, 6, 7)
**Depends on:** nothing for authority — RFC-002 / SPEC §5.4 remains the sole source of what
a connected server may do, and this RFC adds no `uses` path (§10). Amends SPEC §9
(`push/event` params and result; new `push/render` method), §9.4 (idempotency), §14.3
(`channels/incoming` message and per-message result). Interacts with §10.6 (hook
timeouts), §10.7 (loop prevention), §13.2 (audit), §13.3 (hook failure policy), §14.5
(channel scoping), §16 (tags), Appendix A (error codes).

> **Revision 7 note.** Two kinds of change, from reading revision 6 with channels as the
> primary lane.
>
> *Contract, not mechanism.* Several revision-6 requirements described how a host should be
> built rather than what a server or a model can observe. They are restated as outcomes:
> accepted work is never silently lost, but whether it stays replaceable across an
> interruption is the host's choice (§3.2); retries are recognised for a stated window, not
> forever (§3.1), including across host restarts; consumption may be tracked per context
> (§3.3); wake requirements describe observable treatment, not timer architecture (§4.2);
> audit retention follows the host's ordinary policy (§11). Registration lifetime remains
> governed by SPEC §14; this RFC adds no registration step (§3.2). Recovery vectors permit
> both preserved replaceability and conservative append-only delivery (§14).
>
> *Channel gaps.* `coalesce.initial` lets a server mark the birth of a subject, so a host can
> claim `none` without having held every subject forever (§3.3, §6). A host never refuses an otherwise admissible
> occurrence solely for lack of coalescing capacity (§11). Channel scope is not only chat messages:
> keys may span messages, and pure withdrawal is allowed (§3.1, §6). Where a replacement sits
> is the host's choice (§4.1). §8 and §9.5 add ambient channel activity.

> **Revision 6 note.** Channel and push delivery use the same subject and occurrence
> identities. A reconnect changes transport authority, not the identity of the configured
> server binding. Pending work and retry receipts survive reconnect/recovery, while current
> grants and channel registration must be re-established before use. Wake policy is evaluated
> on each replacement; unrelated debounce traffic retains its own quiet period. The companion
> host implementation now covers both delivery lanes and conversation routing.

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
  hypothesis). A new event replaces the previous event under the same key **where it is
  still unread**; otherwise it appends. Hosts may make this decision per context or use a
  conservative shared boundary (§3.3). Stateless for the server.
- **Deferred** — for *delta* content ("what changed since you last looked"). The server
  pushes a keyed notice; the host calls **`push/render`** when it is about to show the event
  to a model, and the server describes everything since its previous render. Repeated
  notices under one key collapse into one pending slot.
- **Retract** — the subject ceased to exist. The host removes any pending version and
  appends the supplied deletion notice where a model saw a version or history is unknown.

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
   keep, never resends based on a coalescing outcome, and never branches on what the host
   did. Transport retries follow the bounded idempotency contract (§3.1).
3. **Stateless key, not an event chain.** The server names the subject, not the prior
   event.
4. **Fail toward today.** On any uncertainty — unknown key, restart, eviction, mixed
   delivery — the host behaves as an append-only host would: it appends, and it keeps the
   deletion notice. The worst outcome is current behaviour.
5. **No new authority.** A server may only touch its own unread deliveries, within a
   scope it is currently authorized for, and everything it supplies
   passes the checks a fresh event would (§10, §11).
6. **Additive.** Absent `coalesce`, nothing changes.

## 3. Identity, scope, and consumption

### 3.1 Three identities

| Field | Answers | Where | Stability |
|---|---|---|---|
| `messageId` | *which message* | `channels/incoming` | Stable across the message's life: creates, edits, and deletes of one platform message share it. Reply/quote targets refer to it. |
| `coalesce.key` | *which subject's pending updates collapse* | both | Stable for the subject. For a chat message, RECOMMENDED `message:<messageId>`. For a participant's state in a channel, per participant. For a document, per document or region. |
| `eventId` | *which occurrence* | both (NEW on `channels/incoming` messages: OPTIONAL without `coalesce`, **REQUIRED** with it) | Fresh per occurrence. Reused **only** when retrying that same occurrence. |

**Idempotency (amends §9.4).** Hosts deduplicate by occurrence: `eventId` when present,
else `messageId`. A `channels/incoming` message whose `messageId` the host has seen but
whose `eventId` is new is a **new occurrence of an existing message** — an edit — not a
duplicate. Occurrence identity is scoped to the server binding, not the transport epoch.
Producers MUST use distinct occurrence IDs across their own restarts as well.

**Retry window for coalesced occurrences.** Hosts MUST recognize admitted occurrences
carrying `coalesce` and return their original
result, without repeating their effects, for at least 3,600,000 milliseconds after first
admission. This guarantee MUST survive reconnects and host restarts. Current admission
checks still apply; a retry cannot restore revoked authority. A host MAY advertise a
longer guaranteed window as `eventCoalescing.retryWindowMs` (§10); omission, including
boolean `true`, means 3,600,000 milliseconds. The value MUST be an integer at least that
large. The host MUST honor the window advertised when it admitted an occurrence, even if
a later initialization advertises a shorter one.

Producers MUST stop retrying when the applicable window has elapsed since their **first
send attempt**, measured by elapsed time, not `timestamp`. If initialization changes while
acceptance is uncertain, the producer uses the shortest window advertised during those
attempts. A producer unable to bound the elapsed time after its own restart MUST NOT retry
the old occurrence. Retrying does not extend the window. An `eventId` repeated after its
window MAY be treated as a new occurrence, so producers cannot rely on deduplication then.
Hosts may retain receipts longer; their storage and retention mechanism is not specified.
This window does not change the base specification's treatment of ordinary traffic.

A `channels/incoming` message that carries `coalesce` **MUST** carry a non-empty `eventId`.
Without it the `messageId` fallback would make an edit a duplicate of its own create, and
the newest state would be the one discarded. Omission is a per-message validation failure
(`coalesce_invalid`, §13); the message is not admitted and its subject is untouched.
Messages without `coalesce` keep today's behaviour.

> Deterministic occurrence ids that omit the occurrence — `discord_edit_<messageId>` — are
> a defect this table makes visible: the second edit of a message collides with the first
> and is dropped as a duplicate by any §9.4-conformant host. Occurrence ids MUST
> distinguish occurrences (a counter, revision id, or edit timestamp suffices).

**A channel-scoped key need not name a message.** Presence, position, or status reported
in a channel is a subject too, keyed per participant or per gauge. Successive
`channels/incoming` occurrences under one such key MAY carry different `messageId`s; the
host delivers the unread occupant's own `messageId`, author, and thread.

### 3.2 Key scope

A key lives in exactly one **scope**, and the full subject identity is the tuple

```
(server binding identity, scope kind, scope id, key)
```

| Delivery | Scope kind | Scope id |
|---|---|---|
| `channels/incoming` message | `channel` | the message's `channelId` |
| `push/event` without `coalesce.channelId` | `featureSet` | the event's `featureSet` |
| `push/event` with `coalesce.channelId` | `channel` | `coalesce.channelId` |

The binding identity is **host-owned** and survives reconnects to the same configured
server. A transport epoch is an authorization boundary, not a new coalescing namespace.
Hosts MUST allocate a different binding identity when a configuration is reassigned to a
different server/principal; producers cannot choose that identity through message fields.
For example, the host may bind a configured server ID to its endpoint/command, and require
a new configured ID when credentials select a different principal at the same endpoint.

Every reconnect still repeats initialization and policy negotiation (SPEC §4.2). Stable
subject identity never restores an old grant. This RFC does not change when a channel
registration begins or ends; that remains as SPEC §14 has it, for coalesced and ordinary
traffic alike.

**Accepted work is never silently lost.** An occurrence the host answered `accepted: true`
MUST remain available for delivery under host policy until delivered, replaced or
retracted by its sender (including an empty render result), or dropped because its
authority lapsed (§5.4 rule 4). A disconnect, a restart, or exhaustion of coalescing slots
is not a reason to discard it. This preservation rule does not force a wake for work that
host policy deliberately keeps pending (§4.2). Whether the occurrence **stays replaceable** across
such an interruption is the host's choice: a host MAY instead deliver the pending content
as an ordinary occurrence at that point and treat the subject's history as `unknown`
(principle 4). An interrupted render is not replayed to advance a source-backed baseline a
second time; its batch falls back (§5.3).

Two servers, two feature sets, or two channels can never address each other's subjects.
A `channel`-scoped push and a `channels/incoming` message with the same `channelId` and
`key` address the **same subject** — which is what lets a create delivered by one method be
edited or deleted by the other without the server remembering which method it used.

**Channel-scoped pushes are admitted against current channel authority.** A `push/event`
carrying `coalesce.channelId` MUST pass ordinary push admission (feature set enabled,
`pushEvents` granted) **and** the checks a `channels/incoming` message for that channel
would pass at this moment: the channel is registered by this server, and `channels.incoming`
is granted and not narrowed away from it (§14.5). "Registered" means exactly what it means
for `channels/incoming` on that host; a channel id that appears only in a push's `origin`
is not registered by that appearance.
Closing a channel does not by itself revoke its registration. A push that fails the channel checks is
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

An occurrence is **consumed in a context** once its content has been included in the
assembly of any request from that context to any model — agent inference, a subagent,
summarization/compression, or a server-initiated `inference/request`. Hosts may apply the
conservative cross-context rule below. Consumption is determined **at context assembly**, not
at response: an occurrence in a request that later fails, is refused, or is aborted is still
consumed. Consumption is **permanent**; there is no un-consume (§16).

A **subject** has *consumed history* if any occurrence under it was ever consumed. Hosts
MUST track this per subject as a tri-state — `none` / `some` / `unknown` — for as long as
they track the subject, and MUST degrade it to `unknown`, never to `none`, on eviction,
restart without durable state, or operator intervention. `none` is a positive claim; the
host makes it only when it can establish the subject's complete history, including through
an `initial` claim as below.

**Birth of a subject.** A host can only know it holds a subject's complete history if it
knows where that history starts. The server does: it knows a create from an edit. An
occurrence MAY carry `coalesce.initial: true`, asserting that no earlier occurrence of this
subject was ever sent under this binding. On an `initial` occurrence for a subject the host
is not tracking, the host MAY start the subject at `none`. Without `initial`, an untracked
subject starts at `unknown` unless the host can independently establish its complete
history (for example, from an intact record covering the binding's lifetime). If the host
is already tracking the subject, `initial` has no effect: it never lowers `some` or
`unknown`. A retraction never carries `initial` (§13).

> `initial` is a claim, like a tag, and grants nothing. A server that sets it falsely can
> only cause its own later deletion notice to be omitted, which it could achieve more simply
> by never sending the deletion. After history is lost, a host cannot distinguish a new
> subject from an old one merely by looking up its key. `initial` lets the producer make
> that distinction. Restart with complete durable history does not itself lose knowledge.
> A participant returning under a previously used presence key is not a new subject and
> MUST NOT assert `initial`; a producer may instead use a fresh key for each visit.

**Per context.** The consumed-check and any replacement or removal MUST be atomic with
respect to the assembly of each context the occurrence was delivered to. A host MAY decide
per context: replace where the prior occurrence is unread, append where it was read. In a
retraction with a notice, each context with `some` or `unknown` history receives it, and
each with known `none` receives nothing. A host that cannot track contexts separately
treats the occurrence as consumed everywhere once it is consumed anywhere. When contexts differ, the reported
`outcome` is the most conservative among them (`appended` over `replaced`, `noted` over
`retracted`; `consumed` over `retracted` when the withdrawal has no notice). Any reported
`priorEventId` MUST identify an occurrence actually displaced or found consumed; it may be
omitted if the contexts have different predecessors.

This flexibility MUST NOT break a deferred renderer's shared baseline. Once a rendered
occurrence is consumed in one context, its materialized content is preserved in every
recipient context (§5.2), including recipients that have not yet read it. Subsequent
rendered deltas cannot replace that prerequisite in an unread context. Per-context
replacement is useful for complete plain occurrences; it does not authorize dropping a
rendered delta that a later delta depends on.

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
| none, with history known `none` | Append. Record as occupant. | `"first"` |
| unconsumed (incl. a pending or rendering batch, §5.4 rule 6) | **Replace** (§4.1). Record new occurrence as occupant. | `"replaced"` |
| consumed, or history `unknown` | Append. Record new occurrence as occupant. | `"appended"` |

The server does the same thing in every row: nothing.

**Do not use plain mode for deltas.** "Inserted `caterpillar`" appended after a consumed
"inserted `cat`" double-reports. That is what deferred mode is for.

### 4.1 Replacement

For each context where the host treats the prior occurrence as replaceable (§3.3), it
removes that occurrence and inserts the new one, within the audience rule of §3.2.
Contexts where the occurrence is consumed or conservatively sealed retain it and append
the new occurrence.

**Position is the host's choice, under one constraint:** the replacement MUST NOT be placed
before any content a model has consumed in that context. Within the unread region the host
orders it as it orders any other content. Two placements are common and both conform: where
a fresh event arriving now would go (natural for a gauge or a document, whose content is
true as of its own `timestamp`), and where the replaced occurrence sat (natural for a chat
message, which otherwise moves after the replies to it).

In each context where replacement takes place, the model-visible context MUST NOT contain
any trace of the replaced occurrence — no
tombstone, no "(edited)" marker, no collapse count. If the server wants the model to know
changes were folded, it says so in the content.

### 4.2 Wake

Replacement is a correction of an occurrence that is still pending, not a second occurrence.

Whether an occurrence qualifies for a wake is host policy (§16.6). Coalescing MUST apply
that policy to the replacement as it would to a fresh occurrence. These are behavioral
requirements; hosts may implement them with shared timers, separate timers, or no timers:

- A replacement that now qualifies for a wake MUST receive the host's normal wake
  treatment, even if its predecessor did not qualify. It MUST NOT create a second wake
  solely because it replaced an occurrence with an already pending wake for the subject.
- The host MUST NOT start an inference whose sole pending cause has been replaced by a
  non-qualifying occurrence or retracted unread. Other causes can still start inference;
  this does not undo one already begun or prevent eligible content from entering it.
- **No starvation.** For a subject eligible for wake under the current policy, continued
  replacements MUST NOT postpone delivery without bound; the host MUST set a finite
  bound. A deliberate `skip`, revoked authority, or operator pause does not create an
  obligation to wake. The bound constrains postponement caused by replacement, not
  unrelated resource outages.
- Coalescing MUST NOT shorten or extend an unrelated event's configured debounce interval
  solely to implement that bound. Internal timer layout is not part of this contract.

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
positioned per §4.1, carrying the batch's `tags` and latest `origin`,
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
  notices are consumed unrendered. Their `data` never enters model context; audit retention
  follows §11. A server whose stream is unrecoverable and for whom that matters SHOULD carry enough in the
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
        ▼               ▼                   ▼                    │ (discard; audit per §11)
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
   materialized the fallback is discarded (audit per §11); it MUST NOT replace or amend
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
   handled under the audit policy (§11), and no fallback is materialized. The cancelling
   operation's own effect (nothing, or the plain occurrence, or the deletion notice per §6) is what the model sees.
   A pending batch opened by a notice that arrived after the render started (rule 1) is
   removed by **either** operation: a newer plain occurrence is a complete snapshot and
   supersedes all earlier unconsumed notices, not just the frozen batch. Removed notices
   follow the audit policy (§11). A notice admitted **after** the plain occurrence is new
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
version of the subject*. It MAY be empty for pure withdrawal (a discarded transcript partial,
an offer withdrawn before use, or activity the producer intentionally does not correct).
Empty withdrawal cannot inform a model that already read a state that the state changed.
For a deleted chat message it **SHOULD** be non-empty: a model that read a message should
learn it is gone. The host cannot tell a message from any other channel-scoped subject, so it does
not enforce this (§13).

The host removes any unconsumed occupant, pending batch, or **rendering batch** (which
becomes CANCELLED, §5.4 rule 6) of the subject from every context it was delivered to (no
trace, §4.1), then decides on the notice by the subject's consumed history (§3.3):

| Consumed history | Pending version | Host action | `outcome` |
|---|---|---|---|
| `none` (positively known) | any / none | Remove pending; append **nothing** | `"retracted"` |
| `some` | any / none | Remove pending; **append the notice** as an ordinary occurrence (§4.1) | `"noted"` |
| `unknown` (evicted, restarted, never tracked) | any / none | Remove pending if any; **append the notice** | `"noted"` |
| `some` or `unknown`, and `content` is empty | any / none | Remove pending; append nothing | `"consumed"` |

**The check covers every version, not the current occupant.** *Original read → edit
pending → delete*: history is `some`, so the host removes the pending edit **and** appends
the notice. Revision 2 got this wrong.

A subject the host has never heard of is `unknown`, not `none`: the host cannot distinguish
"never sent" from "evicted", and the conservative result — the notice appears, as it does
today — costs one line of context. A subject whose first tracked occurrence carried
`initial` (§3.3) can start at `none`, which makes `"retracted"` reachable for a
message created, edited and deleted after the host last evicted or restarted.

A retraction is `accepted: true` whenever it passes admission (which, for channel-scoped
retractions, includes §3.2's channel checks). Wake handling follows §4.2: a removed
occupant cannot remain the sole cause of an unstarted inference, and an appended notice
receives the host's normal wake-policy treatment. After a retraction the subject's slot is empty; its consumed-history bit persists per
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
| Chat message: create, edit, delete | plain (`initial` on create); `retract` (with notice) | channel | `message:<messageId>` |
| Participant presence / position / status in a channel | plain; `retract` with a departure notice when prior readers need a correction | channel | per participant or visit |
| Ambient channel activity (movement, emotes, joins) | deferred, one digest per channel | channel | per channel |
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
            + coalesce: { key: "message:" + id, initial: true }
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
create   channels/incoming { messageId: 123, eventId: c123,   coalesce: { key: "message:123", initial: true } }  → first
edit 1   push/event        { eventId: e123a, coalesce: { channelId, key } }                     → replaced
edit 2   push/event        { eventId: e123b, coalesce: { channelId, key } }                     → replaced
delete   push/event        { eventId: d123,  coalesce: { channelId, key, retract: true },
                             content: "Message 123 by Alice was deleted." }                       → retracted
```

For a host that uses `initial` to establish `none`, the model never sees anything, even if
the host restarted or evicted this channel's subjects before message 123 existed. Without
`initial`, a host lacking complete history conservatively yields `noted`, and the model
sees a deletion notice for a message it never saw. A host may retain this conservative
behavior even with `initial`. Had the agent run **after edit 1**, the
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
same content, that line appears when the model saw the message or its history is unknown. Portal's wake policy
(`chat:deleted → mute`) is unchanged: the appended notice is evaluated by it like any event.

### 9.4 Read original → unread edit → delete (the revision-2 defect)

```
create   → first        agent runs: original CONSUMED, history := some
edit     → appended     (original consumed; edit is a new unconsumed occupant)
delete   → noted        edit REMOVED (unconsumed); notice APPENDED (history is some)
```

Model-visible: original, then "Message 123 by Alice was deleted." Revision 2 produced
original alone, uncorrected.

### 9.5 Ambient channel activity (deferred, channel scope)

A virtual-world or presence server relays a channel where most traffic is state churn:
participants move, emote, join and leave. Each change is true only until the next one, and
the agent needs the current picture when it looks, not the series. The server keeps one
subject per channel for the churn and one per participant for their state:

```
t0  Bob moves          → notice { channelId, key: "activity", deferred: true }         → first (wake per policy)
t1  Bob moves again    → notice { channelId, key: "activity", deferred: true }         → replaced (joins batch)
t2  Cara joins         → plain  { channelId, key: "presence:cara:visit1", initial: true } → first
t3  Cara says "hi"     → channels/incoming { messageId: 9, eventId: "create:9",
                          coalesce: { key: "message:9", initial: true } }              → first
t4  agent assembles    ← push/render { channelId, key: "activity" }
                        → "Bob moved from the fountain to the gate."
                          (the intermediate position vanished; Cara's presence and greeting
                           are separate occurrences and are delivered as themselves)
t5  Cara leaves        → retract { channelId, key: "presence:cara:visit1" },
                          content: "Cara left the channel."                         → noted
```

Every push in this timeline also carries its own fresh `eventId`, `featureSet`,
`timestamp`, and payload; the abbreviated notice/plain/retract lines show only coalescing
fields and relevant content. The host in this example uses `initial` to establish `none`.
If Cara left before any assembly, the departure would retract her unread presence without
a notice. After t4 the departure notice corrects what the model read; empty withdrawal
would leave that knowledge unchanged. A later visit uses a fresh visit key, or reuses the
participant key without `initial`.

Messages are never folded into the digest: only the churn is. Nothing here requires the
host to know what a "channel message" is; it sees three subjects in one channel scope.

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
                     "deferred": false, "channelScopedPush": true,
                     "retryWindowMs": 3600000 }
```

It is deliberately *not* a leaf under `pushEvents` or `channels`: §5.1 defines boolean
`true` as "every leaf beneath this node", so every existing host advertising
`"pushEvents": true` would be read as claiming support it lacks. `retryWindowMs` is a
numeric guarantee, not a capability-grant leaf. Boolean `true` enables all coalescing
features with the default one-hour retry window; an object may advertise a longer window
(§3.1). The retry guarantee applies to whichever delivery lanes the host supports.

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
  preserves anything read and appends the supplied correction notice when required.
- **Deletion cannot hide a read message.** The consumed-history bit degrades only toward
  `unknown`, which yields any supplied notice. A host that cannot remember whether the model saw
  something behaves as though it did.
- **Humans and logs are not models.** Only the model-visible context is rewritten. A host
  that keeps an audit record (§13.2) SHOULD record replaced and removed occurrences, folded
  notices, and discarded late render results in it, linked by `eventId`, under the same
  retention policy as its other audit entries. Operator surfaces SHOULD show displaced
  occurrences as displaced. Nothing in this RFC requires retaining content its author
  withdrew before anyone read it beyond what the host's audit policy already keeps.
- **Late binding.** With deferred mode the content is chosen at consumption time. The
  server learns that an inference is imminent and nothing else — no content, no
  conversation identity; `push/render` carries only its own subject. `inference/lifecycle`
  already discloses as much. A host for which even that timing is sensitive should not
  advertise `deferred`.
- **Notice data is inert.** `coalesce.data` is stored and returned, never interpreted, never
  model-visible, bounded (4 KiB × retained notices per batch).
- **Wake shaping.** A server could wake with an urgent tag and render something bland. It
  could equally have pushed the bland event with the urgent tag; tags are claims, never
  authority (§16.6). Hosts keeping an audit record SHOULD show both under their policy.
- **Resource use.** Keys are bounded; hosts MAY bound tracked subjects per server and evict
  (an evicted occupant is delivered as an ordinary occurrence and thereafter treated as
  consumed; an evicted batch is materialized as its fallback; an evicted history bit becomes
  `unknown`). Render is bounded by timeout. **Coalescing capacity alone is never a reason to refuse.** A host
  unable to allocate a coalescing slot admits the occurrence and degrades to appending (`"appended"`, or
  `"noted"` for a retraction) exactly as a host without coalescing would; it MUST NOT
  return an error solely for lack of coalescing slots on an occurrence it would otherwise
  accept. Ordinary admission, backpressure, storage limits, and operator policy still
  apply; this is not a promise of unbounded buffering. Overflow deferred occurrences use
  their admitted fallback without invoking `push/render`. Tracked subjects still obey
  replacement/retraction rules; an unknown empty withdrawal returns `"consumed"`.
  In a busy
  channel the number of unread subjects is the size of the backlog, and a refusal there
  would drop the message that mattered.

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
  initial?: boolean;      // Default false. "No earlier occurrence of this subject was sent" (§3.3). Exclusive with retract.
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
//     | { pushEvents?: boolean; channelsIncoming?: boolean; deferred?: boolean;
//         channelScopedPush?: boolean; retryWindowMs?: number } // integer >= 3600000; default 3600000
// new method                      push/render  (Host → Server, Request)
```

**Malformed `coalesce`** — missing or oversized `key`; non-boolean `initial`, `deferred`,
or `retract`; `retract` with `deferred` or with
`initial`; `data` without `deferred` or over 4 KiB; `deferred` or `channelId` on a `channels/incoming`
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

Unless a vector says otherwise, delivery is authorized and eligible under host policy,
capacity is available, retries are within the advertised window, and a subject described
as a create has `initial: true`. Vectors requiring known `none` apply when the host uses
that claim or independently establishes complete history. Hosts that conservatively keep
`unknown` append a supplied deletion notice instead. Timer, index, and storage layout are
not inspected by these vectors.

Plain:
1. **First.** Unseen subject with history established as `none` → appended; `"first"`.
1a. **Unknown first occurrence.** Untracked subject without `initial` or complete history
    → appended; `"appended"`.
2. **Replace.** E1(K), no inference, E2(K) → next request contains E2's content and no byte
   of E1's; `"replaced"`.
3. **Consumed.** E1(K), inference, E2(K) → history holds E1 unchanged, then E2; `"appended"`.
4. **Consumption at assembly.** E1(K); an inference including E1 fails before output;
   E2(K) → `"appended"`.
5. **Compression consumes.** E1(K) is summarized before any agent inference; E2(K) →
   `"appended"`.
6. **Repeated edits.** Create, edit₁, edit₂, edit₃, no inference → one occurrence in the
   next request, edit₃'s content, `"replaced"` ×3.
7. **Restart with conservative delivery.** E1(K); host restarts, preserving E1 as an
   ordinary occurrence rather than replaceable work; E2(K) → `"appended"`, and the next
   request contains E1 then E2 (vector 40). Retry deduplication still holds (§3.1).

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
    arrives → discarded (audit per §11); model-visible content is the fallback.
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
    (history `none`) → `"retracted"`; result arrives → discarded (audit per §11); next request
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
33. **Pure withdrawal in channel scope.** Retract on a channel-scoped subject with empty
    content and history `some` → `"consumed"`; nothing appended. (Revision 6 rejected this
    with `-32602`.) Earlier consumed content remains unchanged; this operation makes no
    claim that the model learned the subject disappeared.
34. **History persists past slot.** Create; inference; retract (`"noted"`); new create
    under the same K; retract → `"noted"` (bit is `some`, not reset by the empty slot).
34a. **Initial after loss of history.** A host using `initial` has evicted history or
    restarted without it; create with `initial: true` under a fresh key; edit; retract with
    notice → `"retracted"`; the next request contains nothing from K. Without `initial`
    or independent complete history, the same sequence → `"noted"`.
34b. **Initial cannot lower history.** Create; inference; a second occurrence with
    `initial: true` under the same K; retract with notice → `"noted"`.
34c. **Capacity degrades, never refuses.** With the host at its subject limit, a new
    channel-scoped create → `accepted: true`, `"appended"`; the content reaches the next
    request. A retract for an untracked subject with notice at the limit → `"noted"`,
    notice delivered. A deferred occurrence at the limit → `"appended"`, fallback delivered
    without rendering. These outcomes assume ordinary admission would accept the event.

Both:
35. **Idempotent retry.** Same `eventId` twice → one effect; equal results.
36. **No starvation.** With delivery available and wake eligibility maintained,
    replacements arrive faster than the host's quiet period → the subject's current content
    reaches a request within the host's stated bound. A subject deliberately matching
    `skip` is not forced to wake by this vector.
37. **Audit** (illustrative; host policy). After vectors 2, 16, 23 and 29 a host that keeps
    an audit record shows E1; N1–N3 with rendered and fallback content; the discarded late
    result; and the removed edit — each marked displaced/folded/discarded.
38. **Malformed, per lane.** 257-byte key on `push/event` → `-32602`. In a
    `channels/incoming` batch of three where the second has `deferred: true` → results
    `[accepted, {accepted:false, reason:"coalesce_invalid"}, accepted]`.

Recovery:
39. **Reconnect retry.** E1 accepted; receipt lost; transport reconnects and policy completes;
    retry E1 within the retry window → original receipt; the next request contains E1's
    content exactly once.
40. **Nothing accepted is lost.** E1 accepted; transport drops, or the host restarts, before
    any inference; the producer returns → the next request contains E1's content (as the
    pending occupant or as an ordinary occurrence — either conforms). E2 for the same
    subject after recovery but before the next assembly has two conforming outcomes:
    if E1 remains replaceable, `"replaced"` and only E2 reaches the request; if recovery
    sealed E1 as an ordinary occurrence, `"appended"` and E1 then E2 both reach it. Neither
    outcome duplicates an occurrence. Revocation and later sender retraction/replacement
    still apply; the preservation guarantee does not override them.
41. **Ordinary traffic unaffected by reconnect.** A registered channel; transport drops and
    reconnects; a `channels/incoming` message without `coalesce` → accepted exactly as it
    would have been under SPEC §14 before this RFC. This RFC adds no registration step.
42. **Binding reassignment.** Reuse a configured label for another endpoint/principal;
    its events cannot replace, retract, or deduplicate the old binding's occurrences.
43. **Current wake treatment.** Under a policy where `skip` is non-qualifying, replace
    the sole cause of an unstarted inference with a `skip` occurrence (or retract it
    unread) → no inference starts solely for the displaced cause. Another eligible cause
    may still start one. Reverse the transition → normal qualifying wake treatment.
44. **Unrelated debounce.** A coalesced subject reaches its postponement bound while an
    unrelated ordinary event is awaiting its configured quiet period → coalescing does
    not shorten or extend the ordinary event's deadline. Timer layout is unrestricted.
45. **Stable reply target across lanes.** Create M via `channels/incoming`; edit via a
    channel-scoped push without a new platform message identity → M remains the reply
    target, regardless of whether the create was already consumed.
46. **Per-context replacement** (only for hosts that track contexts separately). E1
    delivered to contexts A and B; A consumes it; E2 → A holds E1 then E2, B holds E2 only;
    `outcome` is `"appended"`.

47. **Host-restart retry.** E1 accepted, reply lost; host restarts; current policy restored;
    retry E1 within the advertised window → original receipt, no second occurrence.
48. **Window changes.** E1 admitted and acknowledged under a two-hour advertised window;
    reconnect advertises one hour; retry E1 after 90 minutes → still deduplicated. A producer
    uncertain which session admitted E1 uses the shorter advertised window and stops its retries earlier.
49. **Shared render baseline.** Deferred R1 is materialized for contexts A and B; A consumes
    R1, B has not. R2 is rendered relative to R1 → B retains R1 before R2. Optional
    per-context replacement cannot discard R1 from B and strand R2 without its baseline.

Revision 6's wake vectors are retained as behavioral checks 43–44; no vector requires a
particular scheduler data structure. Audit vector 37 remains illustrative under host policy.

### Executable corpus and evidence

[`conformance/event-coalescing-vectors.json`](./conformance/event-coalescing-vectors.json) freezes all 64 labeled rows above, including suffix variants. The corpus contains 77 scenarios: some rows have several permitted timelines or controls, and §6's empty-slot obligation has a separate supplement under vector 34. Each row carries its source contract; each scenario carries setup, profile preconditions, ordered actions, and observable expectations.

The supplied runner distinguishes **Host passes**, **Host failures**, **supporting evidence with a narrower boundary**, **inapplicable profile conditions**, **blocked checks**, **unexercised adapter preconditions**, **server-fixture obligations**, **advisory observations**, and **execution errors**. A missing profile precondition is never a pass. Neither this corpus nor its reference execution changes the RFC's Draft status.

#### Run the suite

Run from the MCPL repository root with Bun. Use an isolated checkout of Agent Framework:

```sh
FRAMEWORK="$(mktemp -d)"
git clone https://github.com/anima-research/agent-framework.git "$FRAMEWORK"
git -C "$FRAMEWORK" checkout --detach 03c31d9b4224f3eb4195a6a1b1126c47b5fb39bc
(cd "$FRAMEWORK" && bun install --ignore-scripts)
bun test conformance/event-coalescing-runner.test.mjs conformance/coalescing-timing.test.mjs conformance/coalescing-peer.test.mjs
bun run conformance/check-event-coalescing.mjs \
  --framework "$FRAMEWORK" \
  --report /tmp/event-coalescing-report.json
```

Use `--case 21,34,43` to select particular RFC labels. The report identifies that selection; a selected run is not full-corpus evidence. The runner records the suite revision, dirty state, source hashes, actual Host revision, resolved dependency versions, and declared profile. It exits nonzero for any failed expectation, blocked check, unexercised precondition, or execution error. A genuinely inapplicable profile condition is reported as such, not counted as a pass. A failing transport or fixture is an execution error, not evidence of a Host conformance defect. Ordinary Host-drive errors are execution errors, and every forced `assemble` needs a new observed provider request; an empty request list cannot satisfy exclusion-only assertions. The explicitly expected model-failure scenario instead requires a witnessed failed request carrying its input.

The pinned reference run exposes four distinct Host behaviors as failures:

- **Vector 21, disconnected before assembly:** accepted deferred work disappears. After reconnect, the same binding, operator policy, effective grant, and enabled feature sets are restored; retry returns the original acceptance, and a fresh ordinary control is admitted. The accepted fallback still reaches no request. This differs from temporarily withholding work until authority is re-established.
- **Vector 34, §6 empty-slot supplement:** the first `noted` deletion notice is stored, but the next create returns `replaced` and removes it. The ordinary notice was retained as the subject's occupant. The narrower history-bit scenario passes: a second deletion still returns `noted`.
- **Vector 36, required postponement bound:** the inspected EventGate/Framework/coalescer paths provide no finite bound for the reset-only debounce policy. A bounded live run records an ordinary single-event delivery control and 25 eligible plain same-subject occurrences against continuously running Host event loops. Actual gate decisions, admissions, scheduler state, request contents, and assembly/provider timestamps witness sustained eligibility and delivery availability. The finite run corroborates the missing mechanism; it does not prove infinite starvation on its own. This source assessment is a reviewed account of the pinned paths, not an automatic detector for arbitrary implementations. The report carries it only when all three inspected source-file hashes match. Changed source is unassessed rather than inheriting this verdict.
- **Vector 43, two timelines:** a debounced qualifying occurrence is replaced by a `skip` occurrence or retracted unread before inference begins. Its old debounce cause still starts a request. Skip-only, qualifying-only, and skip-to-qualifying controls distinguish this from a general failure to honor the wake policy.

The report carries the observations behind each checked step, including wire receipts, actual provider-request messages, private Host policy/binding readouts, render requests, published channel messages, and trace events. The frozen expected values remain spec-derived even when the pinned Host fails them.

#### What the adapter observes

[`agent-framework-coalescing.mjs`](./conformance/agent-framework-coalescing.mjs) runs a synthetic MCPL peer over real loopback WebSockets. [`coalescing-host-worker.mjs`](./conformance/coalescing-host-worker.mjs) imports the actual Framework in a separate Bun subprocess with a temporary Chronicle store and a synthetic model provider. The peer remains alive across Host restarts and SIGKILL, preserving the endpoint identity while the Host's process state is lost. Test files and runtime logs stay in the temporary directory.

The model provider copies the actual assembled message payloads at provider entry, so later Host mutation cannot rewrite the observations. It can fail after assembly, with the public no-retry error policy selected for vector 4, so failure cannot be mistaken for an unconsumed occurrence. Compression uses the real autobiographical strategy. Held render responses expose cancellation, timeout, and late-response races without replacing the coalescer's state machine. Overlapping peer render handlers retain their own request records across awaits, so out-of-order inference-request responses cannot be attributed to a later render.

The fixture can queue a Host-requested inference, change grants through the real connection's grant API, invoke the actual channel tools, and deliberately keep one recipient idle by withholding its pending wake. These controls drive the existing scheduler and policy objects; they do not synthesize coalescing outcomes or consumption watermarks. Operator configuration, grants, binding, and enabled features are observed directly where those distinctions matter.

A `restart` stops the Host and launches a new process on the same store. A `kill` sends SIGKILL without a graceful stop. Killing a render-started Host happens after the peer has observed its `push/render`; recovery must materialize the admitted fallback without a second render. The pending-deferred recovery scenario permits either a retained pending render or conservative fallback delivery, while requiring exactly one materialization.

The default profile establishes `none` from `initial`, keeps untracked history conservative otherwise, uses conservative recovery/shared consumption, retains 64 notices, advertises a one-hour retry window, and uses the actual five-second render deadline. These are profile choices, not new protocol constants.

The report separates conditional applicability from missing implementation or measurement support:

| RFC label | Reference-profile disposition |
|---|---|
| 15 | Inapplicable: this profile advertises `channelScopedPush`, so the absent-leaf condition does not apply |
| 34c | Inapplicable: the Host prunes idle subjects above a soft target rather than imposing a hard live-subject admission cap |
| 46 | Inapplicable: the Host chooses conservative shared consumption, which the RFC permits |
| 36 | Failed required bound, supported by inspected source and the bounded live observation |
| 44 | Blocked by #36's missing required bound; this is not an optional capability exemption |
| 23 | Unexercised unread-fallback precondition; a separate supporting scenario checks the late result after consumption |
| 27e, before-consumption variant | Unexercised materialized-but-unread precondition |
| 31, 34a | The adapter does not construct lost-history recovery while preserving accepted content |
| 48 | The adapter does not construct a change from a previously advertised two-hour guarantee to one hour |

All rows remain in the corpus. A Host with a hard capacity limit needs an observed saturation readout and successful ordinary-admission controls before its overflow outcomes are assessed. A different history policy must establish the scenario's stated known-none or unknown-history precondition. Deferred `first` outcomes are independent of the plain-mode known-none rule.

The timing oracles use actual request/content witnesses, accepted eligible replacement cadence, and no-pause/running-loop controls. They reject negative or nonfinite elapsed values and a standalone delivery timestamp without a provider request. A finite bound is an observation of Host policy, not a new wire field or a value supplied merely to make the test pass. The reference probe declares one-millisecond clock resolution and a 60-millisecond scheduling/observation allowance; these are fixture measurement limits, not protocol timing constants. Assembly-start and provider-entry observations come from wrappers around the actual request builder and synthetic transport seam, without changing their decisions.

For #44, a capable adapter must record an ordinary-only control that actually honors its configured quiet interval and the combined run with the ordinary wake still pending when the bound fires. It must link a nonempty content marker to the recorded ordinary wire input and provider request, record the uniquely identified ordinary wake's occurrence, and explicitly observe both Host and gate unpaused. It must identify the ordinary wake's own cause separately from the coalesced-bound wake, link that bound wake to an actual current-content request, and preserve the ordinary wake offset relative to its control within the declared clock/lag allowance. Subject and ordinary requests are selected by independently recorded recipient identities, not by whether their contents satisfy the expectation. Every combined request to the subject recipient must remain in the subject check; an ordinary-only request to another recipient is checked on its own delivery lane. The worker records recipient identity at the actual request-builder seam. An earlier request caused by the coalesced event can legitimately contain ordinary content already stored in context; that alone does not mean the ordinary timer was shortened. The oracle does not impose a universal `[200,201]` millisecond delivery window. The reference Host cannot exercise this check until a finite bound exists, so its report remains blocked rather than inventing a passing timestamp.

Vector 27 checks the synthetic notice-only conformance server's dropped-count report and is labeled `server-fixture`. Vector 37 retains actual audit readouts without making an optional retention policy mandatory. These distinctions qualify what the evidence establishes; they do not change the frozen requirements or the RFC's status.

#### Consume the vectors

Each case has `id`, `contract`, `kind`, and `variants`. A variant has `name`, `setup`, `requires`, and `steps`. Steps have stable `id` values and an `op`; wire sends carry the unmodified JSON-RPC `method` and `params`. A receiving implementation gets those values, not a locally reconstructed interpretation of the expected state.

The supplied adapter implements these controls:

- `send` and `register` deliver wire requests; `channelTool` invokes an actual Host channel tool.
- `render` selects an immediate, empty, held, error, inference-requesting, or notice-summary peer response. `waitRender` and `releaseRender` coordinate on actual requests.
- `turn` drives existing wakes; `assemble` requests and drives a Host inference. `startTurn` and `joinTurn` expose a render in flight. `suppressWake` keeps a selected recipient idle.
- `restart`, `kill`, `disconnect`, `reconnect`, and `reassign` alter the real lifecycle boundary. `grant` and `disableFeature` alter the actual admission policy.
- `failNextModel`, `compress`, `wait`, and `observe` supply the indicated fixture condition or observation.

Conditional scenarios also name controls their adapter must provide: `materializeWithoutConsume` stops at that model-visibility boundary; `restartWithoutHistory` preserves accepted content while losing consumed-history knowledge; `fillCapacity` establishes a declared hard subject limit; `consumeContext` assembles one recipient only; `advertiseWindow`, `reconnectWithWindow`, and `advanceClock` exercise the specified guarantee across elapsed time; `continuousReplacements` measures current-content provider delivery under sustained eligible traffic against a single ordinary-event control; `unrelatedDebounce` compares the ordinary wake cause against an ordinary-only control while a coalesced bound fires. Advertising a capability in an adapter profile is a claim that the adapter genuinely constructs that condition, not permission to substitute an expected answer.

Expectations address raw observations by dotted `path`. `eq` compares a value exactly; `oneOf` allows the listed alternatives; `sameAs` compares with an earlier step's observed value. Text checks use `includes`, `excludes`, `counts`, and `order`. `requestText` is the last provider request's messages; `allRequestText` covers every observed request, so superseded or private content cannot pass merely by disappearing from a later request. `allContextText` covers stored context. `recoveryContent` uses `recoveryFrom` to read the earlier receipt: `replaced` requires the new occurrence alone, while `appended` requires one preserved old occurrence followed by the new one; `exactlyOneOf` permits one of the listed materializations, once. Event-identity checks inspect every stored copy with that `eventId`; model-specific checks select the actual request's `config.model` and can require a request count, including zero for a recipient that must still be unread. `audienceFrom` derives recipients from an earlier delivery snapshot and checks each original recipient and each nonrecipient separately. Advisory scenarios retain their actual observations even when they have no mandatory content assertion.

For another implementation, pass `--adapter /path/to/adapter.mjs`. Export `createAdapter(root)`, returning `identity`, `profile` (including its `capabilities`), and `open(setup)`. Each opened session supplies `step(action)` and `close()`; the reference adapter and worker define the observation shape. Keep state-transition decisions in the implementation under test and expected-value comparisons in the runner. Other languages can consume the same wire/actions and expected properties directly.

## 15. Implementation notes (non-normative)

- **agent-framework.** [PR #196](https://github.com/anima-research/agent-framework/pull/196)
  at `6352d47` implements revision 6 across both delivery lanes, channel-scoped pushes,
  and deferred push rendering. Revision 7 alignment still requires handling `initial`,
  accepting empty channel-scoped withdrawal, and ordinary-delivery fallback at coalescing
  capacity. Cross-message subjects also need a reply-provenance regression case: the
  latest incoming message supplies its own identity; omitted fields on edits of that
  same message should continue to inherit its existing identity. Its durable receipts already exceed the default retry guarantee; it can keep
  the one-hour advertisement default. Conservative cross-context consumption and tail
  placement remain conforming choices. This note does not claim revision 7 conformance.
  Pending content stays outside context managers until safe activation assembly. Shared
  contexts wait for other readers' live turns; conversation forks receive their own events.
  Both channel lanes enforce the same registration, grant, and optional channel allow-list.
  A single append-only Chronicle operation journal is authoritative: acceptance,
  replacement, retraction, render decisions, and delivery receipts are appends. A pure
  reducer reconstructs pending work, subject history, and the occurrence index without
  issuing RPCs, writing context, or waking a model. Assembly appends a publication intent
  before writing context, then appends completion. The intent seals the occurrence against
  replacement; its stable delivery ID makes an interrupted publication idempotent.
  Recovery records its decisions as new appends, uses admitted fallbacks for unfinished
  renders, and waits for fresh authority. Endpoint or command reassignment changes the
  binding namespace. Older experimental snapshots/receipt stores are imported once;
  uncertain pending deliveries are sealed conservatively and deduplicated against legacy
  context markers. Full replay and the in-memory receipt-position index currently grow
  with journal history. Tests exercise mixed-lane updates, stable reply identity,
  permission changes, replay, interrupted appends/publication, and wake cancellation. This remains
  a proposed implementation, not a claim of production deployment. Live tool-continuation
  injection is not part of this implementation.
- **mcpl-cc-bridge.** Deliveries held by the wake policy (the `<held>` block) are
  unconsumed until the hook flushes them; plain replacement is a keyed overwrite of the
  held queue, rendering happens in the flush, and anything already emitted as a
  `<channel>` block is consumed.
- **discord-mcpl / portal-mcpl.** Add `coalesce: { key: "message:<id>", initial: true }`
  and an `eventId` on creates (both paths), `coalesce.channelId` + fresh occurrence ids on edits (fixing the
  `discord_edit_<id>` collision), and `retract` + notice on deletes. Portal's
  `[message deleted]` push becomes the retraction's content unchanged.
- **First deferred servers.** A Google Docs server (edits keyed per document, comments per
  thread); mcpl-editor (its debounce stays, `firePushEvent` splits into notice + render).

## 16. Decisions (formerly open questions)

1. **`channels/incoming` stays in this RFC.** Plain mode and retraction are identical
   across lanes, and the mixed-delivery cases (§9.2) are the point; splitting would leave
   chat servers with half a mechanism. Hosts that cannot replace inside a batched user turn
   advertise `channelsIncoming: false`.
2. **Positioning is the host's, above the consumed boundary.** Revisions 2–6 recommended
   the tail because a gauge's content is true as of its own timestamp. For a chat message
   the same rule moves an edited message after its replies. Both placements keep the
   consumed prefix intact, which is the only property a server or a model can rely on, so
   the RFC states that constraint and no preference (§4.1).
2a. **The RFC specifies outcomes, not host mechanisms.** Accepted work survives interruption
   through replacement, withdrawal, ordinary delivery, or authority-based rejection.
   Retrying within the advertised window does not duplicate an occurrence, including across
   restart. Wake eligibility and unrelated delivery timing remain observable guarantees;
   timer layout does not. The RFC requires no particular journal, index, snapshot, or
   retention architecture. Audit follows host policy. Our journal implementation remains
   one way to provide these guarantees.
3. **Consumption is permanent.** No un-consume after a traceless request; with deferred
   mode the materialized occurrence is history either way, and refusal-rewind's marker is
   an ordinary event.
4. **Render cursor is deferred, not adopted.** The at-most-once gap (§5.3) is accepted for
   source-backed servers. If a server needs exactly-once coverage, a follow-up may add an
   opaque `cursor` echoed by the host on the next render of that subject.
5. **Malformed requests are errors.** `-32602` on `push/event`; per-message
   `coalesce_invalid` on `channels/incoming`, because that lane already defines partial
   acceptance and a whole-batch error would discard valid siblings.
