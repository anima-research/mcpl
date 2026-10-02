# MCPL RFC-009: Provisional channel input streams

**Status:** Experimental draft. This RFC defines a complete plain-text trial profile; it does not amend the integrated SPEC or freeze a generic stream vocabulary. Acceptance requires the Portal STT exercise in RFC §12.

**Targets:** MCPL Protocol Specification 0.5.

**Authors:** Kit and Tessa, from Sol's proposal recorded in [mcpl#3](https://github.com/anima-research/mcpl/issues/3).

**Date:** 2026-10-02.

**Depends on:** SPEC §5.4 capability grants and §14 channel registration, authorization, and incoming-message ingestion.

Section references written as “SPEC §” refer to [SPEC.md](./SPEC.md). References written as “RFC §” refer to this document.

## 1. Purpose and scope

A speech-to-text producer may replace words it previously recognized. Treating each hypothesis as `channels/incoming` would turn unfinished speech into durable messages and repeated inference triggers. This RFC separates a provisional stream from its one accepted final message.

> A partial input may be perceived and prepared against without becoming durable authored speech. Exactly one accepted final enters the normal channel band.

This profile covers full replacement snapshots of Unicode plain text, Host-authorized leases, bounded updates, finalization, cancellation, and executable conformance traces. Audio transport, microphone consent, patch encodings, rich content, generic sensor schemas, and a UI presentation protocol are outside its scope. Consent remains visible and owned by the recording transport. An input-stream grant is not recording consent.

The protocol carries lifecycle facts. The Host chooses whether provisional text informs volatile UI, floor or addressing evidence, local preparation, explicitly opted-in incremental inference, or nothing. A Server cannot select attention policy through a stream, its text, or a tag.

The words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY describe requirements for implementations of this experimental profile. Existing MCPL implementations remain governed by SPEC.md.

## 2. Advertisement, grants, and compatibility

### 2.1 Explicit advertisement

A participating Server and Host each advertise the following under `capabilities.experimental.mcpl`:

```json
{
	"version": "0.5",
	"channels": {
		"incoming": true,
		"inputStreaming": true
	}
}
```

`channels.inputStreaming: true` is an explicit advertisement of the capability path `channels.incoming.streaming`. It is not a capability path named `channels.inputStreaming`. An implementation MUST recognize this advertisement only when `channels` is an object and its own `inputStreaming` member is the boolean `true`.

This is a deliberate local exception to SPEC §5.1's mirrored advertisement tree. `channels.incoming` is already an executable leaf with a boolean wire shape. Keeping `incoming: true` preserves that shape for existing consumers. Extending the descendants of the old boolean would make old manifests claim a new behavior under SPEC §5.1's expansion rule. A distinct member preserves the old advertisement and makes the new opt-in explicit.

For this capability only, neither `channels: true`, `incoming: true`, nor another ancestor boolean shorthand advertises input streaming. `channels.streaming: true` continues to mean Host → Server outgoing streaming. Nested `incoming: {"streaming": true}` and a literal `"incoming.streaming"` member are not this profile's advertisement.

The original manifest is still the input to the SPEC §17 digest. The advertisement mapping does not rewrite the manifest before hashing.

### 2.2 Positive authorization

Every method in RFC §3 requires both `channels.incoming` and `channels.incoming.streaming` in the current effective grant, with the current per-channel scope. Neither path grants the other. SPEC §5.4's full-path, single-segment wildcard matching still applies: `channels.*` cannot match the new depth-three path. A bare `channels.incoming` grant cannot authorize input streaming.

The Host MUST require explicit advertisement by both peers before granting input streaming. The initial or expanded grant becomes usable only after the SPEC §5.3/§6.7 Request/receipt exchange finishes. Advertisement alone grants nothing. A Host MUST reject input methods until policy is ready.

Hosts implementing this RFC add `channels.incoming.streaming` to the feature-set `uses` vocabulary. An experimental feature set can declare:

```json
{
	"experimental.portal.inputStreams": {
		"description": "Provisional plain-text channel input",
		"uses": ["channels.incoming", "channels.incoming.streaming"]
	}
}
```

The completion-only feature set remains separate so an older Host can disable the unknown experimental set without disabling ordinary messages. Channel methods carry no `featureSet`; their authority comes from the connection grant and registered channel, as in SPEC §14.1.

### 2.3 Completion-only fallback

If the new capability is absent, a Server sends no input-stream methods. When an utterance finishes, it sends one ordinary `channels/incoming` Request under the ordinary incoming grant. The old Host receives one completed message.

For an accepted stream, `channels/input/complete` is the sole final-input submission. The Host runs the ordinary ingestion and routing path internally; the Server MUST NOT also send the same final through `channels/incoming`. A timeout or lost response to `complete` is an uncertain outcome, not permission to fall back. The Server may retry the exact Request while the lease is valid. Disconnect and expiry follow RFC §8.

A rejected open creates no stream. A Server may use the completion-only path for the finished utterance if the ordinary incoming grant permits it. Such fallback does not bypass a denial of the channel or sender.

## 3. Methods and data types

All four methods are JSON-RPC Requests from Server to Host. Using Requests makes rejection, stale revisions, and terminal receipts observable without introducing a second diagnostics channel. A producer MUST wait for successful open before sending the other methods.

| Method | Purpose |
|---|---|
| `channels/input/open` | Authorize and allocate a bounded stream lease. |
| `channels/input/update` | Replace the current provisional snapshot. |
| `channels/input/complete` | Submit one final snapshot to ordinary ingestion. |
| `channels/input/abort` | Discard a provisional stream without authoring a message. |

The following types apply throughout this profile:

- Identifiers are nonempty strings of at most 256 Unicode scalar values. Identity comparisons are exact and case-sensitive, without Unicode normalization.
- `startedAt` and `expiresAt` are integers between 0 and 253402300799999 inclusive, counting milliseconds since the Unix epoch (through the end of year 9999). `startedAt` is the producer's observation of when the utterance began, not a Host authorization timestamp.
- `revision` is a positive safe integer, at most 9007199254740991. An accepted open starts with Host revision 0 and no text. Revisions may skip numbers.
- `contentType` is exactly `text/plain`.
- `text` is a string of Unicode scalar values, possibly empty. Unpaired UTF-16 surrogates are invalid. `maxChars` counts Unicode scalar values, not UTF-16 code units, UTF-8 bytes, or grapheme clusters. Thus `🙂` counts as one and `e` followed by U+0301 counts as two.
- `contentDigest` is `sha256:` followed by the 64 lowercase hexadecimal digits of SHA-256 over the exact UTF-8 encoding of `text`. No normalization, trimming, or line-ending conversion occurs.

Objects defined in this RFC reject unknown members with `-32602`. JSON-RPC envelope members remain governed by MCP. Transport implementations MUST enforce a bounded frame size and parse budget before application-level content handling. The scalar-value limit alone is not a frame-size limit.

## 4. Opening and binding a stream

### 4.1 Request

```json
{
	"jsonrpc": "2.0",
	"id": 41,
	"method": "channels/input/open",
	"params": {
		"streamId": "utterance-17",
		"channelId": "portal:room-4",
		"messageId": "utterance-17-final",
		"sender": {"id": "speaker-7", "name": "Ada"},
		"contentType": "text/plain",
		"startedAt": 1790917200000,
		"expiresAt": 1790917260000
	}
}
```

All shown params are required except `sender.name`. `threadId` is an optional identifier. The `sender` object contains only required `id` and optional `name`; the name is a display hint of at most 256 Unicode scalar values, not identity evidence. Open carries no transcript text and no provisional tags or addressing claims.

The Host first checks the current effective grant, actual registered inbound or bidirectional channel, authenticated Server principal, and the sender that this connection is permitted to represent. A claimed sender ID is not authentication. Host adapters must establish the allowed sender binding from their authenticated transport or configured connector authority.

The Host binds the lease to that connection, the current registration generation, channel identity, sender identity, final `messageId`, optional `threadId`, and accepted display metadata. Unregistering or replacing the channel registration invalidates the lease, even if the textual channel ID is reused. A Host MUST perform this admission before accepting or decoding high-rate application payloads; bounded JSON framing and envelope parsing necessarily precede application authorization.

`expiresAt` requests a deadline. It MUST be later than Host receipt time and no earlier than `startedAt`. The Host MAY shorten the deadline according to its maximum stream duration, but MUST NOT extend it beyond the request. An accepted deadline MUST be later than Host receipt time. The Host enforces the resulting duration with a monotonic clock so wall-clock adjustments cannot extend a lease.

### 4.2 Acceptance and limits

```json
{
	"jsonrpc": "2.0",
	"id": 41,
	"result": {
		"accepted": true,
		"streamId": "utterance-17",
		"transportEpoch": "host-connection-8",
		"leaseId": "host-lease-31",
		"expiresAt": 1790917230000,
		"maxUpdateHz": 10,
		"maxChars": 4096,
		"mode": "volatile"
	}
}
```

Every result field shown is required. `maxChars` is a positive safe integer. `maxUpdateHz` is a finite positive number. The Host issues a fresh opaque `leaseId` and an opaque `transportEpoch` identifying the actual connection lifetime. IDs must not collide within the Host's relevant state. Neither ID is a bearer credential: possessing it does not replace the authenticated connection or current grant.

Open is the one method that does not echo the Host epoch or lease: its response establishes them. The Host binds open to the receiving connection before returning them. Every later method echoes them and uses the effective `expiresAt`, not the requested deadline if the Host shortened it.

`mode` states the Host's selected treatment for this lease (RFC §9). A successful open is authorization to submit within these limits, not a promise to display partials or wake the model. A refusal is a JSON-RPC error, not `{accepted:false}`, consistently with SPEC §6.6.

### 4.3 Reservations and open retries

The Host reserves `streamId` within the connection epoch and the canonical key `(authenticated Server principal, registered channel identity, messageId)` when it accepts open. Another stream cannot reserve the same canonical key concurrently. Ordinary `channels/incoming` and streamed completion MUST use the same canonical reservation and deduplication namespace. An open reservation prevents ordinary incoming from independently committing that key; a committed key prevents a second commit through either path. The registered channel identity is the Host's stable identity for the underlying channel, distinct from the registration generation. Reconnecting or re-registering the same underlying channel does not create a new canonical deduplication namespace. Textually identical channel IDs on unrelated connections do not by themselves establish the same registered channel identity.

While the stream is still open, retrying open with identical parsed params and JSON object member order ignored returns the original result. The request ID may differ. It does not allocate another lease, extend expiry, or reset limits. An identical open retry after a terminal transition returns `terminal`; it does not reopen the stream. Reusing that `streamId` with different params returns `conflict`. Authorization and expiry checks precede replay or terminal handling.

A Host MUST bound both concurrent leases and retained epoch identifiers. When admitting another stream would exceed those budgets, it rejects open with `resource_limit`. It MUST NOT evict an identifier and then treat its replay as a new stream. Both the stream identifier and its canonical-key reservation remain reserved through the epoch after abort or expiry. Terminal identifiers likewise remain reserved until the epoch ends; transcript bodies need not remain (RFC §10).

A previously committed canonical message key remains a duplicate even across transport epochs. The Host's durable message identity and deduplication record enforce that boundary. A fresh open for an already committed key returns `conflict`, rather than creating another message. This does not require old provisional state to survive a reconnect.

## 5. Shared lease envelope and replacement updates

### 5.1 Envelope

Each post-open method carries every field in this envelope:

```json
{
	"streamId": "utterance-17",
	"transportEpoch": "host-connection-8",
	"leaseId": "host-lease-31",
	"channelId": "portal:room-4",
	"senderId": "speaker-7",
	"contentType": "text/plain",
	"startedAt": 1790917200000,
	"expiresAt": 1790917230000,
	"revision": 1
}
```

Except for `revision`, each value MUST equal the accepted lease value. This redundancy makes mismatched subject or stale transport state legible. The Host also revalidates the receiving connection, actual registration generation, authenticated sender binding, current grant, scope, and expiry on every call, including retries. Equality of the Server-supplied fields alone does not authorize a call.

`messageId`, optional `threadId`, and display name come from the Host-bound lease; a later payload cannot replace them. `update` and `complete` add exactly one field, `text`. `abort` adds exactly one field, `reason`.

### 5.2 Update semantics

`channels/input/update` carries the complete current hypothesis, not an append operation. Replacing `"turn left"` with `"turn right"` leaves only `"turn right"` as the current snapshot. A Host MUST NOT join the revisions into one utterance or interpret them as committed edits.

After authorization and envelope validation, the Host applies these rules:

1. Validate text scalar values and `maxChars`, including for a stale or duplicate call.
2. If the revision is lower than the current revision, ignore the text and return `stale`.
3. If the revision equals the current revision, return `duplicate` if the text is identical; otherwise reject with `conflict`.
4. If the revision is higher, enforce the update cadence. On acceptance, replace the snapshot and advance the current revision.

The first update has no cadence delay. For later advancing updates, Host acceptance times measured on a monotonic clock MUST be at least `1000 / maxUpdateHz` milliseconds apart. Duplicate and stale updates do not consume an application update slot. Independent transport abuse controls may still bound request traffic.

A successful update result is:

```json
{"accepted": true, "status": "updated", "revision": 1}
```

`status` is `updated`, `duplicate`, or `stale`. `revision` always reports the Host's current accepted revision. For `duplicate` and `stale`, `accepted:true` acknowledges handling the Request, not accepting a new snapshot. Those outcomes change no provisional state and cause no new preparation or wake.

### 5.3 Latest-state backpressure

The producer coalesces replacement hypotheses before transmission. It SHOULD keep at most one in-flight update and one replaceable pending snapshot per stream. A newer hypothesis replaces the pending snapshot; it does not join an unbounded queue of old hypotheses.

`rate_limited` rejects the attempted advance without changing the current revision, text, or last acceptance time. A producer sends the newest complete snapshot at its next permitted slot. It does not replay every intermediate vendor result.

Complete and abort bypass this update cadence. An utterance ending immediately after an update must be able to terminate immediately. Those methods still enforce authorization, envelope, size where applicable, and expiry.

## 6. Completion and canonical ingestion

### 6.1 A full final snapshot

`channels/input/complete` carries the shared envelope and the full final `text`. It may be the first text-bearing call, using any valid positive revision. An empty final string is valid, subject to the ordinary incoming-message policy.

A final revision below the current revision returns `stale_revision`. A final revision equal to the current revision is allowed only if the text is identical. A higher final revision replaces the last provisional hypothesis. The Host does not require a matching update first and does not apply the update cadence to complete.

The Host validates the final under the current ordinary incoming-message authorization, moderation, and routing rules. If that path refuses the final, complete returns `final_rejected` and leaves the stream open until abort, expiry, or a permitted retry. A Server cannot evade those rules by choosing streaming.

For an accepted final, the Host constructs exactly one ordinary incoming message:

| Ordinary incoming field | Source |
|---|---|
| `channelId` | Bound channel ID. |
| `messageId` | Bound final message ID. |
| `threadId` | Bound optional thread ID; omitted when absent. |
| `author` | Bound `sender`, with Host-validated identity and optional display metadata. |
| `timestamp` | `startedAt` converted to UTC RFC 3339; it describes utterance start, not commit time. |
| `content` | One block: `{"type":"text","text":<accepted final>}`. |

No provisional revision becomes a separate ordinary message. The Host may attach local provenance and stream-to-message reconciliation metadata outside the speaker's text. Publication time, recognition time, and playback progress remain distinct facts.

### 6.2 One logical commit and replay receipt

On acceptance, the Host clears the provisional snapshot, reconciles any volatile presentation to the canonical message identity, and consumes matching preparation or discards it under RFC §9. The following are one logical commit, serialized against policy changes, channel changes, and other terminal calls:

- the canonical message under the reserved canonical key;
- the ordinary ingestion/routing outcome and any durable scheduling identity;
- the terminal stream state;
- the completion replay identity and result.

The Host MUST commit these together or use equivalent transactional deduplication. A failure before commit leaves no accepted final; a failure after commit cannot cause a retry to ingest a second message. If routing uses an asynchronous queue, its transactional outbox or equivalent must preserve the same logical message and wake identity. This requirement is about one logical ingestion and scheduling decision, not exactly-once network packet delivery. Ordinary Host policy may decide that the one final needs no wake.

The result is:

```json
{
	"accepted": true,
	"status": "completed",
	"messageId": "utterance-17-final",
	"revision": 2,
	"contentDigest": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
```

This digest example is for an empty final string. `conversationId` is optional and, when present, comes from ordinary ingestion. Every other field shown is required.

While the lease remains valid and authorized, an exact retry of complete returns the original result unchanged. Equality is over the parsed envelope, revision, and exact text; the JSON-RPC request ID may differ. It causes neither another row nor another wake. A changed final on a completed stream returns `conflict`. Update or abort after completion returns `terminal`.

Hosts may retain the final request identity as a digest rather than a second copy of text, using the exact digest encoding in RFC §3. The canonical final is already subject to ordinary message retention. Duplicate detection MUST use the stable canonical key as well as content identity; equal text on two different utterances is not a duplicate.

## 7. Abort and terminal ordering

`channels/input/abort` carries the shared envelope and `reason`, one of `cancelled`, `no_speech`, `source_error`, or `superseded`. A free-text reason is outside this profile. Its revision MUST be at least the current revision and positive; abort before any update may use revision 1. A lower revision returns `stale_revision`.

On acceptance, the Host clears the provisional snapshot and revision-bound preparation, ends any volatile presentation, marks the stream aborted, and returns:

```json
{"accepted": true, "status": "aborted"}
```

Abort MUST NOT convert the last partial into a canonical message, authored testimony, or a normal inference trigger. UI may show a cancellation boundary, but must distinguish it from completed speech.

While the lease remains valid and authorized, an exact retry returns the original abort result. A changed abort on the same aborted stream returns `conflict`. Complete or update after abort returns `terminal`.

The Host serializes complete, abort, and invalidation. The first accepted terminal transition wins. A concurrent losing terminal call observes the terminal state; it does not undo a committed final or promote an aborted partial.

## 8. Revocation, disconnect, and expiry

Open streams abort on disconnect, transport-epoch change, lost sender authority, channel removal or replacement, or revocation of either required grant. A grant reduction takes effect before its policy Request is sent, as SPEC §6.7 requires. The Host clears volatile state and preparation at that boundary. A later regrant does not revive the old lease.

A stream expires when Host time reaches its effective deadline. Equality with the deadline is expired. The Host MUST arrange deadline cleanup even if the producer sends no further calls. Cleanup is not deferred until a late update happens to arrive. Clock movement must not lengthen the accepted duration.

All late calls on an expired lease return `expired`. A call claiming a different epoch, lease ID, or bound envelope returns `lease_mismatch`; an identifier unknown in the current epoch returns `unknown_stream`. A mismatched packet does not itself revoke a legitimate live lease. Independently detected policy or transport invalidation does.

Expiry also ends the replay-receipt window, including for completed streams. Retained minimal epoch identifiers prevent a late open from recreating the stream. Epoch closure may release those provisional tombstones, but not the canonical message's deduplication identity.

After reconnect, both peers renegotiate policy. An old stream cannot resume, and an old partial cannot silently become authored speech. A producer with an uncertain pre-disconnect final must reconcile its stable message identity with the Host's canonical message state; it MUST NOT manufacture a new message ID and blindly resubmit. This RFC does not add a cross-epoch message lookup or resumption method.

## 9. Host treatment and preparation

The Host chooses one of these `mode` values at open. Each states a permitted upper bound, not an obligation to consume every update:

| Mode | Permitted provisional treatment |
|---|---|
| `final-only` | Validate lifecycle and retain only enough state for correctness; no provisional consumer. |
| `volatile` | Volatile UI and provisional floor/addressing evidence, without ordinary ingestion. |
| `prepare` | The `volatile` treatments plus local preparation or prefetch. |
| `incremental` | The `prepare` treatments plus explicitly opted-in incremental inference on a separate provisional path. |

Default treatment is `volatile` where useful, otherwise `final-only`. The producer cannot request a more permissive mode through payload content. The mode is fixed for the lease. A Host may consume less than it permits; a policy change requiring stricter permission invalidates the lease instead of silently leaving a wider receipt standing.

By default, provisional text enters neither Chronicle nor another durable conversation log, autobiographical compression, ordinary model context, or ordinary wake rules. Incremental mode requires a separate explicit Host policy opt-in for the recipient. Its results remain provisional and must not authorize ordinary speech or external action. The protocol grant alone does not supply that opt-in.

Preparation artifacts MUST be bound to `streamId + revision + contentDigest` and to the lease's authenticated subject: epoch, channel identity, sender, final message ID, and optional thread. At complete, an artifact may be reused only if all bindings still match the accepted final and current policy. A final with a newer revision invalidates older preparation even when its text happens to match. Otherwise the Host discards or recomputes the artifact. Abort, expiry, and invalidation always discard it.

Floor and addressing evidence may change provisionally. An ordinary speech grant waits for an accepted final utterance or authenticated utterance-end/VAD-end evidence under Host policy, unless the room contract explicitly permits interruption. Provisional text, guessed mentions, or producer tags cannot mint that authority. A Host must distinguish preparation from publishing a response.

## 10. Privacy and resource bounds

Partial transcripts may contain words a speaker did not intend to say. Process logs retain metadata only by default: stream identifier, revision or update count, duration, character/byte counts, and complete/abort disposition. They exclude text, display names, and content digests by default. Digests of short speech can disclose text through guessing.

The Host clears superseded bodies, volatile UI state, and preparation when they cease to be useful. Terminal and expiry cleanup retain only what replay protection needs, plus the ordinary canonical final when one exists. No provisional body becomes a durable transcript merely to diagnose or replay the protocol.

Admission budgets cover simultaneous streams, retained epoch tombstones, total bytes, and per-principal request traffic. Size and rate limits are enforced on every relevant lifecycle step; a high revision number does not buy an exception. The Host may close an abusive or exhausted connection under transport policy, which aborts its open streams. A conforming producer drops intermediate hypotheses rather than accumulating unbounded work.

## 11. Errors and validation order

Existing JSON-RPC and channel errors keep their meanings:

| Code | Meaning |
|---|---|
| `-32602` | Invalid params: wrong type, unknown member, invalid scalar string, invalid revision or timestamp, or unsupported content type. |
| `-32002` | Capability denied; `data.capability` identifies a required path absent from the effective grant. |
| `-32017` | Channel or sender not permitted by current scope or authenticated binding. |
| `-32023` | Channel is unknown or not registered. |
| `-32025` | Input stream rejected; `data.reason` is one value from the table below. |

This RFC proposes `-32025` for the experimental lifecycle; it is not added to SPEC Appendix A until adoption.

| `data.reason` | Meaning |
|---|---|
| `not_ready` | Required policy negotiation is incomplete. |
| `unknown_stream` | No such stream is known in this epoch. |
| `lease_mismatch` | Epoch, lease, or bound envelope differs from the receiving connection's lease. |
| `expired` | The effective deadline has passed or was reached. |
| `terminal` | The stream ended and this is not its exact terminal retry. |
| `conflict` | Stream/message identity is reused, or a same-revision or terminal retry changes content or parameters. |
| `stale_revision` | Complete or abort is older than the accepted revision. |
| `rate_limited` | An advancing update arrived before its next permitted slot. |
| `size_limit` | Text exceeds `maxChars`. |
| `resource_limit` | A Host admission or retained-state budget is exhausted. |
| `final_rejected` | Ordinary incoming-message policy refused the final. |

Implementations first apply bounded parsing, ready-state and current authority checks, and actual channel/sender validation. For an existing stream they then validate the lease envelope and expiry, payload shape and size, terminal/revision semantics, and advancing-update cadence. A final commit rechecks the current authorization atomically with ingestion. Authorization precedes any transcript consumer or preparation. Replays do not bypass authorization.

A malformed Request receives an error. A forbidden Notification cannot receive a JSON-RPC response; the Host ignores it, emits a metadata-only diagnostic, and changes no stream state. Notifications are not a supported alternate form of these methods.

An error changes no admitted state, except independently required expiry or authorization/transport invalidation cleanup. Errors must not echo transcript text. A producer uses `data.reason`, not the human-readable error message, for lifecycle handling.

## 12. Conformance and acceptance

The executable artifacts for this RFC belong under `conformance/`. They exercise the wire contract and a non-normative reference Host treatment model. The model is not the Agent Framework Host, a database transaction implementation, or Portal STT evidence.

The in-memory Host traces cover the following protocol outcomes. Their canonical-message and preparation assertions are observations of the reference model, not evidence about a deployed Host's storage, logs, scheduler, or transport:

1. Legacy `incoming:true`, outgoing `streaming:true`, and ancestor booleans do not opt into input streaming. New advertisement without both grants cannot open a stream.
2. Open returns explicit limits and Host-bound identity. Pre-open updates fail. Identical open retries reuse the lease; changed or competing identities conflict.
3. Replacement text removes superseded words. Duplicate and out-of-order updates leave state unchanged. Conflicting same revisions fail.
4. Completion works without updates, confirms identical current text, or supplies a newer full final. An older or conflicting final fails.
5. Exact completion replay leaves one canonical message and unchanged canonical state. Changed retries, late updates, and abort-after-complete produce no additional canonical messages.
6. Abort, expiry, disconnect, epoch change, grant reduction, sender revocation, and channel re-registration clear provisional state without promoting it. Terminal retries respect authorization and expiry.
7. Every envelope binding is checked. Claimed identity does not replace authenticated registration/sender facts.
8. Cadence, size, admission limits, Unicode scalar counting, digest bytes, and terminal bypass of update cadence match the contract.
9. Provisional updates produce no canonical messages. Preparation reuse requires an exact accepted-final binding; superseding or aborting discards it.
10. Downstream final rejection leaves no successful receipt or canonical message. Completion retries preserve the same one-final state.

Acceptance additionally requires an experimental Portal STT producer and a real Host implementation to run the profile together. The exercise must include revised words, completion, cancel, timeout, reconnect, grant reduction, and a Host with no provisional consumer. It must show producer-side latest-state coalescing, completion-only delivery to an older Host, one canonical final and one ordinary ingestion path, and the absence of partials from durable authored history, process logs, ordinary context, and wakes. Real-Host tests must also race ordinary incoming against streamed completion for the same canonical key and establish that both paths share one reservation and deduplication boundary. Host transaction/fault-injection tests must establish the logical commit boundary; an in-memory conformance model alone cannot establish crash recovery.

The generic vocabulary remains unaccepted until that interoperability evidence exists, as requested in issue #3. These RFC and conformance artifacts are protocol-design evidence, not a claim that [agent-framework#102](https://github.com/anima-research/agent-framework/issues/102) or [eidoverse-worlds#33](https://github.com/anima-research/eidoverse-worlds/issues/33) is implemented.
