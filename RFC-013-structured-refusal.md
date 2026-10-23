# MCPL RFC-013: Structured Refusal for Forwarded Events

**Status:** Draft (revision 4)
**Targets:** MCPL Protocol Specification 0.5
**Authors:** Claude Code, from a scope proposed by antra
**Date:** 2026-10-22 (revisions 1, 2); 2026-10-23 (revisions 3, 4)
**Depends on:** nothing for authority. This RFC adds no `uses` path and changes no grant;
RFC-002 / SPEC §5.4 remains the sole source of what a connected server may do. It gives a
host's refusal a machine-readable meaning. Amends SPEC §9.3 (`push/event` result), §9.4
(idempotency, by cross-reference), §14.3 (`channels/incoming` per-message result),
Appendix A (two error codes), Appendix B (schema), and §5.2's host advertisement (one new
member). Interacts with §5.3 (initial policy), §6.6 (rejection), RFC-006 §3.1 (identity
and retry window) and §13 (`coalesce_invalid`), and §19 (bulk content references).

Section references (§) are to the SPEC; references to this document are written "RFC §".

> **Revision 4 note.** After a third review. One trigger, the **declaring host** (RFC §6),
> binds host rules 2 and 4 and producer rule 8. Rule 4's MUST NOT binds a kind a host
> states; a kind inferred from a mapped code from a host that does not declare is advice,
> so today's recoveries stay open (§8). The before-policy recovery keys on when the request
> was sent. A refusal of a resend after no answer says nothing about the earlier attempt,
> so no new occurrence follows it (rule 7). An uncoalesced "effects applied" promise holds
> for an hour across restarts. `limitBytes` ≥ 1. Vectors 24–27 added.
>
> **Revision 3 note.** After a second review. Host rules 3 and 4 are one rule (host rule 3):
> a host that admitted nothing keeps none of the identity the refused occurrence itself
> introduced, while a `messageId` known from an admitted occurrence stays, so a resent edit
> is still an edit; a host that applied the occurrence's effects promises a deduplicated
> resend. The before-policy resend (producer rule 6) is recovery for a send §5.3 forbids,
> and covers only `not_permitted`; a §5.3 rejection records no identity (host rule 4), so
> its resend cannot meet a `duplicate`. One definition of a **classified** refusal (RFC §4)
> serves the advertisement, host rule 2 and producer rule 8, and includes RFC-006's
> `coalesce_invalid` reason and JSON-RPC's `-32600`/`-32700`. B.6 accepts
> `eventAdmission: false`. Vector 10 separates the MUST from the SHOULD; vectors 21–23
> added. §14.6 is no longer listed as amended.
>
> **Revision 2 note.** After review: `-32003` maps to `invalid`; the `unknown_channel`
> resend is an explicit exception; whole-batch errors; occurrence identity per RFC-006
> §3.1; `duplicate` for uncoalesced events only; retries always bounded; authority denials
> stay §6.6 errors; host rule 2 binds advertisers only; JSON Schema with an open `refusal`.

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
| `limitBytes` | `integer` ≥ 1 | Optional, with `refusal: "too_large"` only. The content limit that was exceeded, measured as RFC §6 measures it |

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
| `-32602` Invalid params, `-32600` Invalid Request, `-32700` Parse error, `-32003` Unknown feature set | `invalid` |
| `-32001` Feature set not enabled, `-32002` Capability denied, `-32017` Channel not permitted | `not_permitted` |
| `-32023` Unknown channel | `unknown_channel` |
| `-32030` Temporarily unavailable (new, RFC §7) | `unavailable` |
| `-32031` Content too large (new, RFC §7) | `too_large` |

Likewise RFC-006's per-message `reason: "coalesce_invalid"` reads as `refusal: "invalid"`
when `refusal` is absent.

**Classified refusal.** A refusal is **classified** when it carries `refusal`, or is an error
with a code in the table above, or is a per-message result with `reason:
"coalesce_invalid"`. Every other refusal is unclassified: a `-32000` or `-32603` error, an
error with another code, or a result with only `accepted: false` and perhaps free-text
`reason`. The advertisement (RFC §6), host rule 2 and producer rule 8 use this one
definition.

**`retryable` overrides the default.** The registry says what kind of refusal it is;
`retryable` says whether the same occurrence can still get in unchanged. They differ when a
refusal is temporary for a reason the registry files under a permanent kind, for example a
`not_permitted` from an admission policy the host is reloading, answered with
`retryable: true, retryAfterMs: …`.

**Unknown values.** A producer that does not know a `refusal` value treats it by
`retryable`, and as not retryable when `retryable` is absent. Hosts MUST NOT use values
outside this registry except under a later revision of it.

## 5. Producer rules

These rules apply to a classified refusal (RFC §4), and to any refusal that carries
`retryable`. An unclassified refusal leaves the producer to its own judgement, as today,
except under rule 8.

1. **Same occurrence only when retryable.** A producer MAY send the same occurrence
   (RFC §3) again only when `retryable` is `true` (explicitly or by default), or as rules 5
   and 6 allow.
2. **Wait, and bound.** Before any further send of the event (RFC §3, `retryAfterMs`), the
   producer waits at least `retryAfterMs` when given, and in every case at least its own
   backoff (for example 1 s, doubling per attempt): a `retryAfterMs` of 0 lifts the host's
   wait, not the producer's floor. The producer MUST bound the number of attempts per
   occurrence, and SHOULD bound the total time it holds one. An uncoalesced event, which
   has no RFC-006 window, SHOULD NOT be resent more than one hour after its first send
   (the period host rule 3 holds a promise for).
3. **Window.** For a coalesced occurrence, every resend is bounded by RFC-006 §3.1's retry
   window, measured from the **first** send attempt; `retryAfterMs` does not extend it. A
   `retryAfterMs` that ends after the window is an instruction to stop.
4. **Not retryable.** With `retryable: false` the producer MUST NOT send the same
   occurrence unchanged, except as rules 5 and 6 allow, when the host stated the kind: the
   refusal carries `refusal` or `retryable`, or comes from a declaring host (RFC §6). A
   kind inferred from a mapped code or `coalesce_invalid` from any other host is advice:
   the producer SHOULD follow it, and MAY keep a recovery it already uses for that host
   (§8). By kind:
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
   occurrence once more (after any `retryAfterMs`). Reusing its identity lets the host
   recognize it if an earlier attempt was admitted (rule 7). A second `unknown_channel`
   for it ends it.
6. **Before the initial policy (recovery).** Until the initial policy exchange completes,
   a server MUST treat capability-dependent behaviour as unavailable and a host MUST reject
   privileged methods (§5.3), so a conforming producer sends no `push/event` or
   `channels/incoming` before then. This rule is recovery for one that did, for example a
   producer of an earlier revision that treated pushes as available before the exchange.
   A `not_permitted` refusal (including `-32001`, `-32002` and `-32017`) of a request the
   producer **sent** before it had received the host's initial `featureSets/update` is
   §5.3's rejection, not a verdict on authority, whenever the refusal arrives. As an exception to rules 1 and 4, the producer
   MAY send the same occurrence once more after the exchange completes. Other kinds follow
   their own rules: `unavailable` and `unknown_channel` already allow a resend, and an
   unchanged resend cannot help `invalid`, `too_large` or `duplicate`.
7. **No answer is not a refusal.** A request with no response (timeout, closed transport)
   has an unknown outcome. It stays governed by RFC-006 §3.1 for coalesced occurrences and
   by §9.4 otherwise; this RFC changes nothing there. A refusal that answers a resend of
   such an occurrence says nothing about the earlier attempt, which may have been
   admitted (current admission checks apply to a retry, RFC-006 §3.1). The producer then
   MUST NOT send the content as a new occurrence (rule 4's `not_permitted` and `too_large`
   paths), and records the event's outcome as unknown.
8. **A declaring host's silence.** From a declaring host (RFC §6), an unclassified
   refusal (RFC §4) is non-conforming; the
   producer treats it as `retryable: false` and SHOULD log it. A `-32000` or `-32603`
   error from such a host is the exception: it reads as no answer (rule 7), since a client
   library may raise it on its own.

## 6. Host rules and advertisement

1. **Classify.** A host refusing a forwarded event SHOULD include `refusal`, and SHOULD
   include `retryable` whenever it differs from the registry default.
2. **No meaning in prose alone.** Every refusal from a declaring host MUST be classified
   (RFC §4): transient
   unavailability is `refusal: "unavailable"` (as a result, in `data`, or as `-32030`), and
   a size refusal is `too_large` (or `-32031`), never `invalid` / `-32602` /
   `coalesce_invalid`. Other hosts SHOULD do the same.
3. **What a resend meets.** A host that answers `retryable: true`, `unknown_channel` or
   `too_large` MUST make the resend (or, after `too_large`, the new occurrence) meet what it
   would have met had the refused occurrence never arrived:
   - **Nothing admitted.** When the host applied none of the occurrence's effects, it MUST
     NOT keep any identity the refused occurrence itself introduced: its `eventId`, or a
     `messageId` first seen in it. Identity the host holds from occurrences it did admit
     stays: a refused edit of an admitted message is resent as an edit, and is read as
     one.
   - **Effects applied.** When the host applied the occurrence's effects but failed to
     record that it did, it answers `retryable: true` only if it will recognize the resend
     and return the original result without repeating them: under RFC-006 §3.1 for a
     coalesced occurrence, and for an uncoalesced event for at least one hour after the
     refusal, across restarts (producer rule 2's bound). Otherwise it answers as accepted; it never leaves the
     producer to duplicate the event.
4. **A §5.3 rejection records nothing.** A privileged method rejected because the initial
   policy exchange has not completed admitted nothing. A host SHOULD NOT keep any identity
   such an occurrence introduced, as in rule 3, so a resend after the exchange (producer
   rule 6) is not answered `duplicate`. A declaring host MUST NOT.
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

- `structuredRefusals: true` (and the boolean shorthand `true`) states that every refusal
  of a forwarded event on either lane is classified (RFC §4). A host advertising it is a
  **declaring host**: host rules 2 and 4 bind it, and producer rules 4 and 8 read its
  refusals as stated. An `eventAdmission` object without `structuredRefusals: true` (for
  example only `maxContentBytes`) does not make a declaring host.
- `maxContentBytes` (integer ≥ 1) is the largest content the host admits for one
  occurrence: the UTF-8 byte length of the JCS serialization (RFC 8785, as in §17.2) of
  `payload.content` on `push/event`, or of one message's `content` on
  `channels/incoming`. A host that advertises it MUST NOT refuse content within it,
  `maxContentBytes` included, for its size, and SHOULD answer content over it with
  `too_large` and `limitBytes`. A producer SHOULD fit content under it before sending (§19
  references for bulk payloads).
- Omitted, or `false`, the host makes neither statement. A host without a declared limit
  that refuses for size still SHOULD answer `too_large` (rule 2).

Like RFC-006's `eventCoalescing`, this is a top-level member and not a leaf under
`pushEvents` or `channels`: §5.1's boolean shorthand would otherwise make every existing
host advertising `"pushEvents": true` claim it. It is host information, not a server
capability: there is no `uses` path and nothing for RFC-002 to gate. `maxContentBytes` is a
bound on one occurrence's content, not coalescing capacity, which RFC-006 still never lets
a host refuse on.

## 7. Schema and errors (amends §5.2, §9.3, §9.4, §14.3, Appendix A, Appendix B)

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
    "limitBytes": { "type": "integer", "minimum": 1, "maximum": 9007199254740991 }
  }
}
```

```jsonc
// B.6 capabilities.experimental.mcpl.eventAdmission (false: no statement, as omitted)
{
  "oneOf": [
    { "type": "boolean" },
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
- A host that is not a declaring host (RFC §6) takes on no MUST from this RFC except where
  it chooses: host rule 3 binds what a `retryable: true`, `unknown_channel` or `too_large`
  it gives promises, and advertising `maxContentBytes` binds the limit. Everything else,
  host rules 2 and 4 included, is a SHOULD for it.
- A producer facing a host that is not a declaring host is bound only by what a refusal
  states (`refusal` or `retryable`). A kind it infers from a mapped code is advice
  (producer rule 4), so a recovery it uses today stays open, for example resending without
  inline media after an older host's `-32602` for size. It SHOULD act on the fields when a
  refusal carries them.
- Hosts that answer today with `-32602`, `-32001`, `-32002`, `-32003`, `-32017` or
  `-32023` are already classified by RFC §4's mapping, as advice to producers.
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
4. **Before the initial policy (recovery).** A producer sends `push/event` E1 before it has
   received the host's initial `featureSets/update` (a send §5.3 forbids). The host answers
   `-32002` and keeps nothing of E1 (host rule 4). Once the exchange completes, the
   producer resends E1 once; host admits it, not as a `duplicate`. A second refusal ends
   it. Had the pre-policy refusal been `too_large`, there is no such resend (rule 6).
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
10. **Advertised limit.** Host advertises `eventAdmission: { structuredRefusals: true,
    maxContentBytes: 2000000 }`. Required: content of 1,999,999 and of exactly 2,000,000
    JCS bytes is not refused for size; if content of 2,000,001 bytes is refused for size,
    the refusal is `too_large` (host rule 2). Advisory: that refusal carries
    `limitBytes: 2000000`.
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
21. **A refused edit stays an edit.** `channels/incoming` M1 (E1) admitted. An edit of M1
    (`messageId` M1, `eventId` E2) is refused `unavailable`. Producer resends it (M1, E2);
    host reads it as an edit of M1, not as a new message and not as a duplicate.
22. **Explicit false.** Host advertises `"eventAdmission": false`. Valid; the same as
    omitting it.
23. **Legacy reason from a declaring host.** Host advertises `eventAdmission: true` and
    answers a `channels/incoming` message `{ accepted: false, reason: "coalesce_invalid" }`.
    Classified (RFC §4), so conforming; producer reads `invalid` and does not resend.
24. **Override on a permanent kind.** `push/event` E1 answered `-32001` with `data: {
    retryable: true, retryAfterMs: 1000 }` after the initial policy exchange. Producer
    resends E1 no sooner than 1000 ms later, despite `not_permitted`'s default.
25. **Effects applied, not recorded.** The host applies uncoalesced E1's effects, fails to
    record it, and answers `{ accepted: false, refusal: "unavailable" }`. Producer resends
    E1 within the hour; host returns E1's original result and its effects happen once.
26. **`-32000` from a declaring host.** Host advertises `eventAdmission: true`; coalesced E1
    is answered `-32000`. Producer reads it as no answer (rule 8), not as vector 11's
    non-retryable refusal, and resends E1 under RFC-006 §3.1.
27. **Refused resend after no answer.** Coalesced E1 gets no answer; producer resends E1,
    which is refused `-32017` (authority narrowed meanwhile). Producer records E1's outcome
    as unknown and sends no new occurrence of its content (rule 7).

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

Decided:

1. **`duplicate` and RFC-006.** A coalesced retry keeps RFC-006 §3.1's original result;
   `duplicate` is only for uncoalesced events (RFC §4, host rule 5).
2. **Retries are always bounded.** A producer bounds attempts whatever `retryAfterMs` says,
   with its own floor when it is 0 (rule 2).
3. **Before the initial policy** (revision 3). A `not_permitted` refusal received before
   §5.3's exchange completes is resent once after it (rule 6), as recovery for a send §5.3
   forbids; other kinds follow their own rules. The host keeps nothing of such an
   occurrence (host rule 4), so the resend cannot meet a `duplicate`.
4. **One identity rule** (revision 3). A refused occurrence leaves behind none of the
   identity it introduced, and identity from admitted occurrences stays (host rule 3).

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
