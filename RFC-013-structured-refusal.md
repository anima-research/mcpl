# MCPL RFC-013: Structured Refusal for Forwarded Events

**Status:** Draft (revision 2)
**Targets:** MCPL Protocol Specification 0.5
**Authors:** Claude Code, from a scope proposed by antra
**Date:** 2026-10-22 (revisions 1, 2)
**Depends on:** nothing for authority. This RFC adds no `uses` path and changes no grant;
RFC-002 / SPEC §5.4 remains the sole source of what a connected server may do. It gives a
host's refusal a machine-readable meaning. Amends SPEC §9.3 (`push/event` result), §9.4
(idempotency, by cross-reference), §14.3 (`channels/incoming` per-message result), §14.6
and Appendix A (two error codes), Appendix B (schema), and §5.2's host advertisement (one
new member). Interacts with §5.3 (initial policy), §6.6 (rejection), RFC-006 §3.1 (identity
and retry window) and §13 (`coalesce_invalid`), and §19 (bulk content references).

Section references (§) are to the SPEC; references to this document are written "RFC §".

> **Revision 2 note.** After review. `-32003` (an undeclared feature set) maps to `invalid`,
> not `not_permitted`. The `unknown_channel` resend is an explicit exception to the
> retryable rules. An error answering a whole `channels/incoming` request applies to each
> of its messages. "Same occurrence" is RFC-006 §3.1's identity (`eventId`, else
> `messageId`), and a refusal that invites a resend leaves no identity behind to collide
> with. `duplicate` is for uncoalesced events only. Retries are bounded in every case, with
> a floor when `retryAfterMs` is 0, and `retryAfterMs` covers any further send of the event.
> A refusal answered before the initial policy exchange completed (§5.3) is not a verdict
> on authority. Authority denials on `push/event` stay §6.6 error objects. Host rule 2 binds
> only hosts that advertise `eventAdmission`. B.5 is JSON Schema with `refusal` an open
> string. Citations corrected (§5.2, §5.3); vectors 13–20 added, vector 10 tests the
> boundary.

---

## 1. Summary

A server that forwards an event (`push/event`, or a message in `channels/incoming`) and is
refused can do one of four things: send the same occurrence again, send something
different, fix its own state and send again, or stop. Which one is right depends on why it
was refused, and today the protocol does not say why. `reason` is free text (§9.3), a
`channels/incoming` result defines only `accepted` (§14.3), and the only standard
machine-readable refusals are the authority codes of Appendix A and RFC-006's
"malformed" answer (`-32602` / `coalesce_invalid`).

This RFC adds four optional fields to every refusal of a forwarded event, on both lanes and
in both forms (a result with `accepted: false`, or the `data` of a JSON-RPC error):

```jsonc
{ "accepted": false,
  "reason": "host is restarting",        // unchanged: human-readable diagnostics
  "refusal": "unavailable",             // NEW: what kind of refusal (RFC §4)
  "retryable": true,                    // NEW: may the same occurrence be sent again?
  "retryAfterMs": 2000 }                // NEW, optional: not before this
// and "limitBytes", with refusal "too_large" only
```

It also lets a host advertise, at initialize, that it gives these fields on every refusal,
and the content size it admits, so a producer can stop guessing and fit content up front.

## 2. Motivation

A producer that cannot read a refusal either loses the event or acts on a guess. All three
of these were met by one producer (discord-mcpl) against hosts that conform to the current
text:

- **Transient failures in English.** An agent-framework host answers a storage failure
  during admission, and its own shutdown, with JSON-RPC `-32000` and a sentence ("host
  could not persist the acceptance; retry", "host is stopping"), and on `channels/incoming`
  with the same sentences as a per-message `reason`. The first asks for the same
  occurrence again; the second means "not now". A producer can only tell them apart, and
  from a permanent refusal, by matching that host's sentences
  (anima-research/discord-mcpl#111). `-32000` cannot carry the meaning on its own: JSON-RPC
  leaves -32000..-32099 to the implementation, and client libraries use it for their own
  request timeouts, so the same code arrives for "the host asked for a retry" and "no
  answer came".
- **No reason at all.** A Claude Code bridge host refuses a `channels/incoming` message
  with `{ "messageId": …, "accepted": false }` and nothing else, both when the channel is
  not registered and when its own admission policy declines the channel. The first is
  fixed by registering the channel; the second by nothing the producer can do. The
  producer cannot tell them apart.
- **"Malformed" used for "too large".** Older releases of an agent-framework host refused
  coalesced content over a byte budget with `-32602` / `coalesce_invalid`
  (anima-research/agent-framework#266, fixed in #267). RFC-006 reserves those answers for
  malformed requests and says coalescing capacity is never a reason to refuse, so a
  producer had to guess that "malformed" meant "too large" to recover by resending
  without inline media (anima-research/discord-mcpl#105).

Each producer that guesses guesses differently, and each guess is tied to one host's
wording. SPEC §18.8 already parks the same idea for connection admission ("structured
refusal — `server_full`, `retryAfter`"). This RFC does it for forwarded events, where it is
needed now.

## 3. Where the fields go

The fields are the same in every place a forwarded event can be refused:

1. **`push/event` result** with `accepted: false` (§9.3): members of `result`. Authority
   denials on `push/event` (feature set, capability, channel permission) stay JSON-RPC
   error objects with their documented codes, as §6.6 requires; the result form carries
   `not_permitted` only for a host's own admission policy (RFC §4).
2. **`channels/incoming` per-message result** with `accepted: false` (§14.3): members of
   that message's entry in `results`. This is the only way to refuse one message of a batch
   and not the others; a per-message result has no JSON-RPC code.
3. **JSON-RPC error answering `push/event`, or a whole `channels/incoming` request**:
   members of `error.data`. A `data` that is not an object (or absent) carries none of
   them. An error answering a whole `channels/incoming` request refuses every message in
   it, and its fields apply to each message; a producer acting on them treats each message
   by its own identity.

| Field | Type | Meaning |
|---|---|---|
| `refusal` | `string` | One value of the registry (RFC §4), or a value a later revision adds |
| `retryable` | `boolean` | Whether the **same occurrence** may be admitted if sent again unchanged. Absent: the registry default (RFC §4) |
| `retryAfterMs` | `integer` ≥ 0 | Optional. The earliest time, measured from receiving the refusal, at which the producer may send this event to the host again in any form: the same occurrence, the resend after registering a channel, or a reduced new occurrence after `too_large`. It has no use with `invalid` or `duplicate` |
| `limitBytes` | `integer` ≥ 0 | Optional, with `refusal: "too_large"` only. The content limit that was exceeded, measured as RFC §6 measures it |

`reason` keeps its §9.3 meaning: text for people, never parsed. A host MAY put the same
words there as before.

Field names avoid `code`, which JSON-RPC uses for the numeric error code next to `data`.

**Occurrence identity.** "The same occurrence" is the identity RFC-006 §3.1 deduplicates
by, the `eventId`, or on a `channels/incoming` message without one its `messageId`, sent
with the same content and the same `coalesce` member. A **new occurrence** carries a fresh
`eventId`. A producer that sends a new occurrence for a `channels/incoming` message that
had no `eventId` adds one (RFC-006 §3.1 allows it on any message).

## 4. The registry

| `refusal` | Meaning | `retryable` default | What the producer does (RFC §5) |
|---|---|---|---|
| `invalid` | The request or this occurrence is malformed, or names a feature set the server never declared. Includes RFC-006's `coalesce_invalid` | `false` | Never resend as-is. A producer defect to log |
| `not_permitted` | Authority (§5.4): feature set not enabled, capability denied, channel not permitted; or the host's own admission policy (an allowlist beyond the grant) | `false` | Stop. Do not resend this occurrence |
| `unknown_channel` | The channel this occurrence names is not registered | `false` as-is | Register the channel (§14.3), then send the same occurrence once more (rule 5) |
| `unavailable` | Transient: the host is stopping or restarting, could not record the occurrence, or is overloaded | `true` | Send the same occurrence again, not before `retryAfterMs` |
| `too_large` | The occurrence's content exceeds a size the host admits | `false` | Do not resend as-is. Send smaller content as a **new** occurrence, or stop |
| `duplicate` | This **uncoalesced** event's identity was already admitted (§9.4). Never for a coalesced occurrence: RFC-006 §3.1 answers a retried one with its original result | — | Nothing: the event was delivered |

**Mapping existing codes.** A host answering `push/event`, or a whole `channels/incoming`
request, with one of these codes MAY omit `refusal` from `data`; a producer reads it from
the code:

| Code | `refusal` |
|---|---|
| `-32602` Invalid params, `-32003` Unknown feature set | `invalid` |
| `-32001` Feature set not enabled, `-32002` Capability denied, `-32017` Channel not permitted | `not_permitted` |
| `-32023` Unknown channel | `unknown_channel` |
| `-32030` Temporarily unavailable (new, RFC §7) | `unavailable` |
| `-32031` Content too large (new, RFC §7) | `too_large` |

Likewise RFC-006's per-message `reason: "coalesce_invalid"` reads as `refusal: "invalid"`
when `refusal` is absent.

**`retryable` overrides the default.** The registry says what kind of refusal it is;
`retryable` says whether the same occurrence can still get in unchanged. They differ when a
refusal is temporary for a reason the registry files under a permanent kind, for example a
`not_permitted` from an admission policy the host is reloading, answered with
`retryable: true, retryAfterMs: …`.

**Unknown values.** A producer that does not know a `refusal` value treats it by
`retryable`, and as not retryable when `retryable` is absent. Hosts MUST NOT use values
outside this registry except under a later revision of it.

## 5. Producer rules

These rules apply when a refusal carries `refusal` or `retryable` (or a code mapped in
RFC §4). A refusal with neither leaves the producer to its own judgement, as today, except
under rule 8.

1. **Same occurrence only when retryable.** A producer MAY send the same occurrence
   (RFC §3) again only when `retryable` is `true` (explicitly or by default), or as rules 5
   and 6 allow.
2. **Wait, and bound.** Before any further send of the event (RFC §3, `retryAfterMs`), the
   producer waits at least `retryAfterMs` when given, and in every case at least its own
   backoff (for example 1 s, doubling per attempt): a `retryAfterMs` of 0 lifts the host's
   wait, not the producer's floor. The producer MUST bound the number of attempts per
   occurrence, and SHOULD bound the total time it holds one. For an uncoalesced event,
   which has no RFC-006 window, a bound of one hour from the first send is RECOMMENDED.
3. **Window.** For a coalesced occurrence, every resend is bounded by RFC-006 §3.1's retry
   window, measured from the **first** send attempt; `retryAfterMs` does not extend it. A
   `retryAfterMs` that ends after the window is an instruction to stop.
4. **Not retryable.** With `retryable: false` the producer MUST NOT send the same
   occurrence unchanged, except as rules 5 and 6 allow. By kind:
   - `invalid`: stop; this is the producer's defect.
   - `not_permitted`: stop. If authority later changes (§6.7), the producer MAY deliver the
     same underlying content as a new occurrence; this occurrence is not revived.
   - `too_large`: the producer MAY send reduced content (a bulk content reference, §19; a
     shrunken or omitted attachment; truncated text) as a **new** occurrence (RFC §3) with
     the same `coalesce` member. Nothing was admitted, so an `initial` claim stays true.
     When `limitBytes` is given, the new content SHOULD fit under it.
   - `duplicate`: the event was delivered; record it so and send nothing.
5. **`unknown_channel`: register, then once.** An exception to rules 1 and 4: the producer
   MAY register the channel (§14.3) and, once the registration is accepted, send the same
   occurrence once more (after any `retryAfterMs`). The occurrence was not admitted, so
   reusing its identity cannot duplicate it. A second `unknown_channel` for it ends it.
6. **Before the initial policy.** Until the initial policy exchange completes, a host MUST
   reject privileged methods (§5.3), so a refusal the producer receives before it has
   received the host's initial `featureSets/update` is not a verdict on authority. An
   exception to rules 1 and 4: the producer MAY send the same occurrence once more after
   that exchange completes, whatever the refusal's kind, `invalid` excepted.
7. **No answer is not a refusal.** A request with no response (timeout, closed transport)
   has an unknown outcome. It stays governed by RFC-006 §3.1 for coalesced occurrences and
   by §9.4 otherwise; this RFC changes nothing there.
8. **A declaring host's silence.** When the host advertises `eventAdmission` with
   `structuredRefusals` (RFC §6), a refusal without `refusal` and without a mapped code is
   non-conforming; the producer treats it as `retryable: false` and SHOULD log it.

## 6. Host rules and advertisement

1. **Classify.** A host refusing a forwarded event SHOULD include `refusal`, and SHOULD
   include `retryable` whenever it differs from the registry default.
2. **No meaning in prose alone.** A host that advertises `eventAdmission` with
   `structuredRefusals` MUST NOT signal a registry condition only through `reason` text or
   only through a `-32000`/`-32603` error: transient unavailability is
   `refusal: "unavailable"` (as a result, in `data`, or as `-32030`), and a size refusal is
   `too_large` (or `-32031`), never `invalid` / `-32602` / `coalesce_invalid`. Other hosts
   SHOULD do the same.
3. **`retryable: true` is a promise about effects.** A host MUST NOT answer
   `retryable: true` for an occurrence whose effects took place unless it will recognize the
   resend under RFC-006 §3.1 (or §9.4 for an uncoalesced event) and not repeat them. A host
   that applied an occurrence but failed to record it either answers as accepted or makes
   the resend safe; it does not leave the producer to duplicate the event.
4. **A refusal that invites a resend leaves no identity behind.** A host that answers
   `retryable: true`, `unknown_channel` or `too_large` MUST NOT have kept the refused
   occurrence's `eventId` or `messageId` for deduplication or edit detection, so that the
   resend, or the new occurrence, is read as the event's first arrival and not as a
   duplicate or an edit.
5. **`duplicate` is for uncoalesced events.** A coalesced occurrence retried within its
   window gets RFC-006 §3.1's original result, never `duplicate`.
6. **Authority denials keep their codes.** On `push/event`, a denial by the grant (feature
   set, capability, channel permission) is a §6.6 error object with its documented code;
   `data` MAY add `retryable` and `retryAfterMs`. A per-message `channels/incoming` result
   says `not_permitted` for any of them.
7. **`retryAfterMs`** SHOULD be given when the host knows when it can admit again (a
   planned restart, a rate limit).

**Advertisement** (amends §5.2). A new top-level member of the host's
`capabilities.experimental.mcpl`:

```jsonc
"eventAdmission": true
// or:
"eventAdmission": { "structuredRefusals": true, "maxContentBytes": 4194304 }
```

- `structuredRefusals: true` (and the boolean shorthand) states that every refusal of a
  forwarded event on either lane carries `refusal`, or is one of the codes mapped in
  RFC §4. It lets a producer drop its heuristics for this host, and binds the host to host
  rule 2.
- `maxContentBytes` (integer ≥ 1) is the largest content the host admits for one
  occurrence: the UTF-8 byte length of the JCS serialization (RFC 8785, as in §17.2) of
  `payload.content` on `push/event`, or of one message's `content` on
  `channels/incoming`. A host that advertises it MUST NOT refuse content within it,
  `maxContentBytes` included, for its size, and SHOULD answer content over it with
  `too_large` and `limitBytes`. A producer SHOULD fit content under it before sending (§19
  references for bulk payloads).
- Omitted, the host makes neither statement. A host without a declared limit that refuses
  for size still SHOULD answer `too_large` (rule 2).

Like RFC-006's `eventCoalescing`, this is a top-level member and not a leaf under
`pushEvents` or `channels`: §5.1's boolean shorthand would otherwise make every existing
host advertising `"pushEvents": true` claim it. It is host information, not a server
capability: there is no `uses` path and nothing for RFC-002 to gate. `maxContentBytes` is a
bound on one occurrence's content, not coalescing capacity, which RFC-006 still never lets
a host refuse on.

## 7. Schema and errors (amends §5.2, §9.3, §14.3, §14.6, Appendix A, Appendix B)

**§9.3 `push/event` result**, add:

| Field | Type | Description |
|---|---|---|
| `refusal` | `string` | With `accepted: false`. RFC-013 registry value (open; B.4) |
| `retryable` | `boolean` | With `accepted: false`. Whether the same occurrence may be sent again unchanged |
| `retryAfterMs` | `integer` | Optional. Earliest further send of the event, in ms after the refusal |
| `limitBytes` | `integer` | Optional, with `refusal: "too_large"` |

**§14.3 `channels/incoming` per-message result**, add the same four fields, with the same
conditions. An error answering the whole request carries them in `error.data`, for every
message in it.

**§9.4**, add: "A refusal's `retryable` (RFC-013) says whether a resend of the same
occurrence can be admitted."

**Appendix A**, add:

| Code | Message | Description |
|---|---|---|
| `-32030` | Temporarily unavailable | The host cannot admit the request now; `data: { refusal: "unavailable", retryable: true, retryAfterMs? }` |
| `-32031` | Content too large | The content exceeds a size the host admits; `data: { refusal: "too_large", retryable: false, limitBytes? }` |

They exist because `-32000` cannot mean "retry" (RFC §2) and `-32602` must not mean "too
large" (RFC-006 §13). A host MAY instead answer either condition as a result with
`accepted: false`.

**Appendix B**, add:

```jsonc
// B.5 Refusal: members of a refused push/event result, of a refused channels/incoming
// per-message result, or of the error.data of an error answering either method.
{
  "type": "object",
  "properties": {
    "refusal": { "type": "string", "minLength": 1 },
    "retryable": { "type": "boolean" },
    "retryAfterMs": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
    "limitBytes": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 }
  }
}
```

```jsonc
// B.6 capabilities.experimental.mcpl.eventAdmission
{
  "oneOf": [
    { "const": true },
    {
      "type": "object",
      "properties": {
        "structuredRefusals": { "type": "boolean" },
        "maxContentBytes": { "type": "integer", "minimum": 1, "maximum": 9007199254740991 }
      }
    }
  ]
}
```

**B.4 Enums**, add **RefusalKind** (known values; the set is open, RFC-013 §4, and a
validator MUST NOT reject a value it doesn't list): `"invalid" | "not_permitted" |
"unknown_channel" | "unavailable" | "too_large" | "duplicate"`.

**Changelog:** record the fields, the registry, the two codes and `eventAdmission`.

## 8. Backward compatibility

- Every field is optional and every new member is ignorable: an older producer reads
  `accepted` and `reason` as before, and an older host sends neither.
- A host that does not advertise `eventAdmission` takes on no MUST from this RFC except
  where it chooses to give the fields: host rules 3 and 4 bind what a `retryable: true`,
  `unknown_channel` or `too_large` it gives promises. Everything else is a SHOULD.
- A producer facing a host without `eventAdmission` keeps whatever it does today, and
  SHOULD still act on the fields when a refusal happens to carry them.
- Hosts that answer today with `-32602`, `-32001`, `-32002`, `-32003`, `-32017` or
  `-32023` are already classified by RFC §4's mapping.
- The new codes are only used by hosts that adopt this RFC; a producer that does not know
  them sees an unrecognized error and treats it as a failure, as today.

## 9. Conformance vectors

1. **Unavailable, error form.** `push/event` E1 answered `-32030`, `data: { refusal:
   "unavailable", retryable: true, retryAfterMs: 500 }`. Producer resends E1 (same
   `eventId`, content, `coalesce`) no sooner than 500 ms after the refusal; host admits it
   once.
2. **Unavailable, result form, window.** Coalesced E1 refused `{ accepted: false, refusal:
   "unavailable", retryAfterMs: 4000000 }` with a 3,600,000 ms window. Producer does not
   resend (the wait ends after the window).
3. **Not permitted.** `push/event` answered `-32001` after the initial policy exchange.
   Producer does not resend E1.
4. **Before the initial policy.** `push/event` E1 answered `-32002` before the producer has
   received the host's initial `featureSets/update`. Once it has, the producer resends E1
   once; host admits it. A second refusal ends it.
5. **Unknown channel.** `channels/incoming` message M1 (`eventId` E1) answered `{ accepted:
   false, refusal: "unknown_channel" }`. Producer registers the channel, then resends M1
   with E1 once; host admits it. A second `unknown_channel` ends it.
6. **Too large, with limit.** Coalesced E1 (`initial: true`) refused `-32031`, `data: {
   refusal: "too_large", retryable: false, limitBytes: 1048576 }`. Producer sends E2 (fresh
   `eventId`, same `coalesce` key, `initial: true`) with content whose JCS serialization is
   at most 1,048,576 bytes; host admits it as the subject's first occurrence.
7. **Per-message mix.** A `channels/incoming` batch [M1, M2, M3] answered [accepted,
   `{ accepted: false, refusal: "unavailable" }`, `{ accepted: false, refusal: "invalid" }`].
   Producer resends M2 alone, with its identity; never M3.
8. **Unknown value.** Refused `{ accepted: false, refusal: "quota_exhausted" }`: producer does
   not resend. Refused `{ accepted: false, refusal: "quota_exhausted", retryable: true }`:
   producer resends the same occurrence.
9. **Duplicate.** Uncoalesced E1 refused `{ accepted: false, refusal: "duplicate" }`:
   producer records E1 as delivered and sends nothing.
10. **Advertised limit honoured.** Host advertises `eventAdmission: { maxContentBytes:
    2000000 }`. Content of 1,999,999 and of exactly 2,000,000 JCS bytes is not refused for
    size; 2,000,001 bytes is refused `too_large` with `limitBytes: 2000000`.
11. **Silence from a declaring host.** Host advertises `eventAdmission: true` and answers
    `{ accepted: false }` with no `refusal`. Non-conforming; producer treats it as not
    retryable.
12. **No answer.** E1 times out. RFC-006 §3.1 governs the resend; nothing in this RFC
    applies.
13. **Undeclared feature set.** `push/event` answered `-32003`. Read as `invalid`; producer
    does not resend and logs a defect.
14. **Unknown channel by code.** A channel-scoped `push/event` E1 answered `-32023` with no
    `data`. Read as `unknown_channel`; producer registers the channel and resends E1 once.
15. **Code without data.** `push/event` E1 answered `-32030` with no `data`. Read as
    `unavailable`, retryable; producer resends E1 after its backoff floor.
16. **Legacy per-message reason.** A `channels/incoming` result `{ accepted: false, reason:
    "coalesce_invalid" }` with no `refusal`. Read as `invalid`; no resend.
17. **Too large, message without an `eventId`.** Uncoalesced `channels/incoming` M1 (no
    `eventId`) refused `{ accepted: false, refusal: "too_large" }`. Producer sends reduced
    M1 with a fresh `eventId`; host admits it as M1's first occurrence, not as an edit.
18. **Whole-batch error.** A `channels/incoming` batch [M1, M2] answered `-32030`. Both are
    refused as `unavailable`; producer resends each with its own identity.
19. **Zero wait, bounded.** Every send of E1 is refused `{ refusal: "unavailable",
    retryAfterMs: 0 }`. Producer waits at least its backoff floor between attempts and stops
    after its attempt bound.
20. **Coalesced retry after admission.** Coalesced E1 admitted; the response is lost; the
    producer resends E1 within the window. Host returns E1's original result (RFC-006
    §3.1), never `duplicate`.

**Acceptance criterion:** before Draft→Accepted, these vectors freeze as executable vectors
under `conformance/` (the RFC-003 §3.1 precedent) and run against at least one host and one
producer implementation.

## 10. Alternatives considered

- **More JSON-RPC codes only.** Covers errors, but not a result with `accepted: false` and
  not a single message of a `channels/incoming` batch, whose per-message results have no
  code. The registry is shared by all of them; the two new codes are the error-lane
  spelling of two of its values.
- **A retry hint alone** (`retryable` without a kind). Tells the producer whether to resend
  the same thing, but not whether to register a channel, send something smaller, or treat
  the event as delivered.
- **Standard `reason` sentences.** `reason` is for people, varies by host and language, and
  is already free text everywhere; giving it a grammar would break existing hosts.
- **Always resend, relying on idempotency.** RFC-006 §3.1 makes resending a coalesced
  occurrence safe, but resending into a permanent refusal is wasted traffic and log noise,
  hosts without coalescing promise only §9.4's SHOULD, and idempotency cannot say "send
  smaller".
- **Make the limit advertisement the only size mechanism.** Hosts' limits can change and
  can come from layers that do not advertise (a proxy, a store); `too_large` with
  `limitBytes` covers the refusal the advertisement did not prevent.

## 11. Decisions and open questions

Decided (revision 2):

1. **`duplicate` and RFC-006.** A coalesced retry keeps RFC-006 §3.1's original result;
   `duplicate` is only for uncoalesced events (RFC §4, host rule 5).
2. **Retries are always bounded.** A producer bounds attempts whatever `retryAfterMs` says,
   with its own floor when it is 0 (rule 2).
3. **Before the initial policy.** A refusal answered before §5.3's exchange completes is
   resent once after it, whatever its kind but `invalid` (rule 6). Hosts need not mark such
   refusals retryable.

Open:

1. **Is `retryable` worth a field, or should the kind imply it?** This draft keeps both,
   for a temporary `not_permitted` and for values a producer does not know.
2. **Should an uncoalesced duplicate be `accepted: true`** (with a marker) rather than a
   refusal? §9.4 hosts answer it `accepted: false` today.
3. **Does `too_large` belong in the registry,** or should a host with a limit only advertise
   it and treat excess as `invalid`? This draft keeps it, so that a limit a host does not
   advertise is still reported as size.
4. **What does `maxContentBytes` measure?** JCS bytes of the content array (this draft)
   counts base64 inline media as encoded; decoded media bytes or the whole JSON-RPC frame
   are the alternatives.
5. **Should the RFC fix the numbers** (attempt bound, backoff floor) rather than leave them
   to producers?
