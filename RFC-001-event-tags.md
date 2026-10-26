# MCPL RFC-001: Event Tags

**Status:** Accepted (revision 3) — incorporated into [SPEC.md 0.5.0-draft §16](./SPEC.md#16-event-tags).
**Targets:** MCPL Protocol Specification ≥ 0.5
**Authors:** Antra (with Claude); revised by Claude Code and Sol
**Date:** June 2026; revised 2026-08-02, 2026-10-26
**Depends on:** RFC-002 (capability grants) for the admission boundary — see §7.

This RFC preserves the proposal and its review history. SPEC.md is authoritative for the current protocol.

> **Revision 3 note.** Adds one core tag, `chat:system` (§4, §4.1), for notices from the
> platform or the place rather than messages anyone sent. The core vocabulary could say who
> an event was *for* (`chat:addressed` / `chat:ambient`) but not whether anyone *spoke*, so a
> world's weather change went out as `chat:ambient`, the tag for overheard chatter. A host
> that follows the most recent message for where an agent's unaddressed speech goes then
> followed the weather: a resident's reply meant for a private conversation was spoken
> aloud in a world, because a forecast line had arrived there last. That host already
> exempted reactions, edits and deletions from that treatment; nothing let it exempt a
> notice. Kind is independent of addressing, so §4.1's mutual exclusion does not touch the
> new tag, and §6 gains a recommendation for how hosts treat notices.

> **Revision 2 note.** The original RFC was written before any of it shipped. Since then
> `tags`, `tagOntology`, and consumer matching have all been implemented, while three
> declared mechanisms were never wired up. Revision 2 reconciles the document with what
> exists, and narrows three policy claims that were unsafe once servers stopped being
> uniformly trusted. AUDIT-001 §5 is the evidence base. What changed:
>
> - **Tags are never authority** (§7) — new, and the most important change.
> - **Producer `defaultTreatment` no longer fills gaps in host policy** (§5.2). It is an
>   inspectable onboarding hint requiring explicit acceptance.
> - **`implies` is narrowed** (§4.1). Core implications become normative and
>   spec-defined; producer-declared edges into reserved tags are advisory.
> - **`tags/describe` is removed** (§5.3) — no dynamic-ontology user exists.
> - **§9 is now implementation *status*, not a plan**, and two factual errors in the
>   original are corrected.

---

## 1. Summary

This RFC adds a standardized, multi-valued **`tags`** dimension to MCPL events, so a
*producer* (server) can label what an event *is* and a *consumer* (host) can decide *how to
treat it* — including how and whether it wakes the model. Tags are namespaced, discrete
(not an ordered scale), and meaning lives on the consumer side. A small reserved **`chat:*`**
core vocabulary gives cross-platform portability; per-platform namespaces (`discord:*`,
`telegram:*`, …) carry the long tail.

It generalizes today's ad-hoc, producer-specific boolean metadata (e.g. discord-mcpl's
`isMention`/`isDM` on `origin`) into a first-class contract, and removes the need for hosts
to hardcode any one platform's taxonomy — the `metadataTrue: ["isMention"]` anti-pattern.

**Tags describe. They never authorize.** See §7.

## 2. Motivation

- **Wake routing needs semantics, not magic flags.** Hosts decide whether an event triggers
  inference. Without tags the only signals are `featureSet` (coarse, single-valued),
  `scope`/`source`/`channel` (structural), and free-form `origin` booleans that only one
  host knows how to read.
- **"Mention" is just one event type.** A robotics integration has collision / obstacle /
  telemetry tiers; a chat integration has mention / reply / ambient / reaction. The host
  must not special-case one producer's categories.
- **Producers must not have to agree on a scale.** A shared *ordered* priority ladder fails
  the moment independent producers calibrate it differently. Tags sidestep this: they are
  discrete labels; the consumer assigns treatment.

**The diagnosis has since been confirmed independently.** eidoverse — the newest channel
server, written after this RFC — reinvented event classification from scratch: flat,
un-namespaced `"mention"` / `"whisper"` / `"activity"` tags plus
`metadata: { mentioned, isExplicitMention }`, with a source comment stating it emits "BOTH
ecosystem dialects... Ask us how we know." That is this RFC's anti-pattern, arrived at
without reference to it.

### Design principles

1. **Producer describes, consumer decides.** Producers emit labels. The consumer's policy is
   authoritative — and, per §5.2, is *not* silently seeded by producer suggestions.
2. **Namespaced.** `namespace:value`. A reserved `chat:` core; per-producer namespaces
   otherwise. No cross-producer coordination required.
3. **Discrete facets, never an ordered scale.** Shared *vocabulary* is fine (`chat:mention`
   means the same thing everywhere); shared *ordering* is not.
4. **Structure stays first-class.** Identifiers (guild/channel/sender ids) remain on
   `source`/`channel`/`origin`. Tags are the *semantic* layer only.
5. **Descriptive, never authoritative.** A tag cannot grant, widen, or bypass anything (§7).
6. **Additive & backward-compatible.** Existing `featureSet`, `origin`, and host-specific
   metadata keep working.

## 3. The `tags` field

A new OPTIONAL field `tags: string[]` on events the host may route on:

- `push/event` params (alongside `featureSet`, `origin`, `payload`);
- `channels/incoming` messages (alongside `metadata`).

```jsonc
{
  "method": "push/event",
  "params": {
    "featureSet": "discord.messaging",
    "eventId": "evt_abc",
    "timestamp": "2026-06-28T10:30:00Z",
    "tags": ["chat:mention", "chat:addressed", "chat:from-human", "chat:has-image",
             "discord:role-mention"],
    "origin": { "server": "discord", "channelId": "123", "messageId": "456" },
    "payload": { "content": [ { "type": "text", "text": "…" } ] }
  }
}
```

### 3.1 Syntax

- A tag is a non-empty string `namespace:value`, optionally `namespace:key=value` for
  faceted tags (e.g. `urgency:high`, where a consumer *chooses* to treat the value-space as
  ordered — opt-in, never required).
- Namespaces: the reserved `chat:` core (§4) and `mcpl:` (reserved for future spec use); all
  others are producer-defined and SHOULD match the producer's declared name.
- Tags are a **set** — unordered, deduplicated.
- Producers MUST NOT emit un-namespaced tags. A bare `"mention"` is not a tag.

## 4. Reserved core vocabulary: `chat:*`

Any messaging-style producer SHOULD emit the applicable core tags so consumers can write
portable rules. The set is intentionally small and stable; resist growth — push the long
tail into platform namespaces.

| Facet | Tag | Meaning |
|---|---|---|
| Addressing | `chat:addressed` | Umbrella: the event is directed at the agent. |
| | `chat:mention` | The agent was explicitly named/@-mentioned. |
| | `chat:reply` | A reply to the agent's own message. |
| | `chat:dm` | A direct/private 1:1 message to the agent. |
| | `chat:ambient` | Overheard in a followed channel; not addressed. |
| | `chat:broadcast` | Channel-wide ping (`@everyone`/`@here`/channel post). |
| | `chat:to-self` | The event acts on the agent's own content. |
| Sender | `chat:from-human` | Authored by a human. |
| | `chat:from-bot` | Authored by a bot/automation. |
| | `chat:from-self` | The agent's own message, echoed back. |
| | `chat:from-agent` | Another known persona/agent. |
| Lifecycle | *(create)* | Plain message creation — the implicit default, no tag. |
| | `chat:edited` | An edit of an existing message. |
| | `chat:deleted` | A deletion. |
| | `chat:reaction` | An emoji reaction was added. |
| | `chat:reaction-remove` | A reaction was removed. |
| Kind | *(message)* | Something someone sent — the implicit default, no tag. |
| | `chat:system` | A notice from the platform or the place, not a message anyone sent. |
| Content | `chat:has-image` / `chat:has-audio` / `chat:has-file` / `chat:has-link` | Modality. |
| | `chat:command` | A slash/bot command invocation. |
| Locus | `chat:private` / `chat:group` / `chat:thread` | Conversation shape. |

**Reactions** are first-class because they are cross-platform. The wake-relevant nuance is
*whose message* was reacted to: emit `chat:reaction` plus `chat:to-self` when the target is
the agent's own message, so a consumer can wake on reactions to its content
(`tagsAll: ["chat:reaction","chat:to-self"]`) while muting the rest.

`chat:reaction-remove` is a **distinct** tag from `chat:reaction`. Emitting `chat:reaction`
for a removal — as discord-mcpl currently does, with the distinction surviving only in
`origin.action` — makes "wake on reactions to my messages" fire on un-reactions.

**System notices** (revision 3). `chat:system` marks an event about the place a conversation
happens in rather than a turn in it: someone joined or left, a message was pinned, a channel
was renamed or a thread opened, the weather changed in a world, a device reported its state.
The addressing facet answers *who is this for*; `chat:ambient` says nobody spoke *to* the
agent. Nothing in the core said nobody *spoke*, so producers tagged notices `chat:ambient`
and hosts treated them as overheard messages. Every platform has such notices, and several
already carry them in extension tags (`discord:pin`, `telegram:join`, `eidoverse:presence`);
`chat:system` is the portable umbrella over them.

Producers SHOULD emit `chat:system` on such notices, and MAY emit it alongside
`chat:ambient` so that rules already written for ambient traffic keep matching them.
Producers SHOULD NOT put it on anything someone said.

Kind is independent of addressing. A notice can also be addressed by its place — a pin in a
DM carries `chat:dm`, hence `chat:addressed` — and is still a notice. Sender tags on a
notice, if present, name who it is about (who joined), not a speaker. How hosts treat
notices is in §6.

### 4.1 Normative core closure

The following implications are **defined by this specification**. Hosts MUST expand them,
and MUST do so **without consulting any producer ontology**:

```
chat:mention  ⇒ chat:addressed
chat:reply    ⇒ chat:addressed
chat:dm       ⇒ chat:addressed, chat:private
```

Expansion is transitive, purely additive, and never removes a tag.

Producers SHOULD **also** emit every applicable core tag directly rather than relying on
expansion. Both behaviours are conforming; direct emission is more robust across hosts, and
is what discord-mcpl and portal-mcpl already do — both compute the umbrellas themselves,
with source comments saying "so no host-side implication expansion is needed."

**Mutual exclusion.** `chat:addressed` and `chat:ambient` are opposites: an event is either
directed at the agent or overheard. Because closure is purely additive, it can produce
`chat:addressed` on an event a producer also tagged `chat:ambient` — for example a DM tagged
`chat:dm` + `chat:ambient` by a producer whose addressing logic did not treat it as
addressed.

After expansion, a host MUST resolve this by **dropping `chat:ambient`**: a tag implying
`chat:addressed` is more specific than the producer's ambient classification, and an event
carrying both is not interpretable by a first-match-wins rule list, where the outcome would
depend on rule ordering rather than on the event.

Producers SHOULD NOT emit `chat:ambient` alongside any tag that implies `chat:addressed`.

The exclusion does not touch `chat:system` (revision 3): it answers a different question,
kind rather than addressing. Copying the exclusion onto it would strip the tag from every
notice addressed only by its place, such as a pin in a DM.

**Producer-declared `implies` edges are advisory.** An edge declared in a `tagOntology`
(§5.1) MUST NOT be applied automatically, and in particular an edge whose target is a
reserved `chat:*` tag MUST NOT be applied unless the host or operator has **explicitly
accepted** that producer's ontology (§5.2).

> **Why.** `implies` rewrites wake semantics. An arbitrary declared edge — say
> `vendor:routine ⇒ chat:addressed` — lets a producer promote its own traffic into whatever
> band the consumer reserved for being spoken to, without the consumer ever writing a rule
> about it. The core implications are safe to hardcode precisely because they are fixed by
> the spec and cannot be authored by a server.

## 5. Producer declaration: the tag ontology

Producers SHOULD advertise the tags they emit as a **lightweight, open-world ontology** in
their feature-set declaration, so the vocabulary is discoverable, a zero-config host behaves
sanely, and the agent itself can reason about how it wants to be woken.

It is a **hint catalog, not a closed schema**: it need not be exhaustive, and hosts MUST
tolerate tags that aren't described. It is OPTIONAL; a server that declares nothing still
works.

Reference the spec-defined `chat:*` core by listing which core tags you emit — descriptions
are inherited from §4, do not redescribe them — and describe only your own namespace(s).

```jsonc
{
  "featureSets": {
    "discord.messaging": {
      "description": "…",
      "uses": ["pushEvents", "channels.incoming", "channels.publish", "tools"],
      "tagOntology": {
      "coreTags": ["chat:addressed","chat:mention","chat:reply","chat:dm",
                   "chat:ambient","chat:broadcast","chat:reaction","chat:reaction-remove",
                   "chat:to-self","chat:from-human","chat:from-bot","chat:from-agent",
                   "chat:deleted"],
      "tags": {
        "discord:role-mention": {
          "desc": "A role the agent holds was pinged — not the agent directly",
          "facet": "addressing", "implies": ["chat:ambient"],
          "suggestedTreatment": "throttle"
        },
        "discord:everyone": { "desc": "@everyone/@here", "facet": "addressing",
                              "implies": ["chat:broadcast"] },
        "discord:slash":     { "desc": "Slash-command invocation", "facet": "content",
                              "implies": ["chat:command"] },
        "discord:voice":     { "desc": "Voice channel state change", "facet": "lifecycle",
                              "stability": "experimental" }
      },
      "keyed": {
        "urgency": { "desc": "Producer urgency hint", "values": ["low","normal","high"],
                     "ordered": true }
      },
      "suggestedTreatment": [
        { "tagsAny": ["chat:addressed"], "behavior": "immediate" },
        { "tagsAny": ["chat:deleted"],   "behavior": "mute" },
        { "tagsAny": ["chat:ambient","chat:from-bot"], "behavior": "throttle" }
      ],
      "open": true
      }
    }
  }
}
```

> **Corrected 2026-08-02.** Earlier revisions showed `featureSets` as an *array* of
> `{name, …}` declarations here. That contradicted SPEC §6.1/§5.1 and Appendix B.2, which
> define an **object keyed by feature-set name** — and it was not cosmetic: one library
> implementation followed this example, set-normalized inside the array shape, and produced
> a different §17.2 revision than the other library for identical manifest bytes. Examples
> are load-bearing. The object form above is the only conforming shape; a digest
> implementation receiving the array form hashes it verbatim (§17.2).

### 5.1 Descriptor fields (all optional)

| Field | Meaning |
|---|---|
| `coreTags` | Which reserved `chat:*` tags this server emits; descriptions inherited from §4. |
| `tags.<tag>.desc` | Human/agent-readable description — the core of discoverability. |
| `tags.<tag>.facet` | Group: `addressing` / `sender` / `kind` / `content` / `lifecycle` / `locus`. |
| `tags.<tag>.implies` | Subsumption edges. **Advisory** — see §4.1. |
| `tags.<tag>.suggestedTreatment` | Per-tag suggested behaviour. **Advisory** — see §5.2. |
| `tags.<tag>.stability` | `stable` (default) / `experimental` / `deprecated`. |
| `keyed.<key>` | A `key=value` family with a suggested `values` set and optional local `ordered` flag. Ordering is a hint **within this namespace only** — never a cross-server scale. |
| `suggestedTreatment` | Ordered suggested rules. **Advisory** — see §5.2. |
| `open` | `true` ⇒ the server may emit further tags in its namespace(s) beyond those described. |

> Renamed from `defaultTreatment` in revision 1. The old name implied the rules were a
> default the host would apply; they are not (§5.2). Hosts SHOULD accept `defaultTreatment`
> as a deprecated alias.

### 5.2 Suggested treatment is an onboarding hint, not policy

A producer's `suggestedTreatment` (and per-tag `suggestedTreatment`) **MUST NOT** be applied
automatically. It is inspectable configuration, surfaced to a host or operator, applied only
on **explicit acceptance**.

Absent acceptance the precedence chain is: **consumer rules → host default.** There is no
producer tier.

> **Why revision 1 was wrong here.** The original specified
> "consumer rules → producer `defaultTreatment` → host global default", describing the
> producer tier as "the producer fills gaps". That contradicts principle 1 and is unsafe
> once servers are not uniformly trusted: an untrusted server suggests `immediate` for
> everything and **purchases inference by declaration**, without the consumer ever writing a
> rule. Wake-ups cost money, attention, and context.
>
> The original's own framing ("the host seeds them **below** the consumer's own") already
> conceded these are suggestions. Revision 2 makes acceptance explicit rather than implicit.

Accepted suggestions SHOULD remain attributable — a host that has accepted a producer's
rules should be able to show which rules came from where, and revoke them.

### 5.3 Discovery

The ontology is declared **at init**, in the feature-set declaration. That is the whole
mechanism.

> **`tags/describe` is removed.** Revision 1 offered a Host→Server request for servers with
> very large or runtime-dynamic vocabularies. No such server exists, nothing implements the
> method on either side, and a dynamic ontology interacts badly with §5.2's acceptance model
> — an accepted ontology that can silently change is not accepted in any meaningful sense.
> If a genuine dynamic-vocabulary case appears, it should return with an answer to that.

## 6. Consumer treatment (recommended; host-defined behaviour)

This spec standardizes the *contract* — tags plus declaration. The *wake behaviour* is host
territory, but for consistency hosts SHOULD evaluate treatment with the spec's existing
idioms:

- An **ordered rule list, first-match-wins**, as Feature Sets §6 already does. No behaviour
  merging.
- Match operators over tags: **`tagsAny` / `tagsAll` / `tagsNone`**, glob allowed
  (e.g. `robotics:*`), composable with `source`/`scope`/`channel`.
- **Core closure expansion (§4.1)** applied before matching. Producer edges only if accepted.
- **Precedence:** consumer rules → host global default. Accepted producer suggestions are
  merged into the consumer's own rule list at acceptance time, not consulted at match time.

```jsonc
// consumer policy (portable across platforms)
[
  { "tagsAny": ["chat:addressed"], "behavior": "immediate" },
  { "tagsAll": ["chat:ambient"], "tagsNone": ["chat:from-self"],
    "behavior": { "debounce": 180000 } },
  { "tagsAny": ["chat:deleted","chat:from-bot"], "behavior": "skip" }
]
```

Recommended behaviour vocabulary: `immediate`, `mute`, `{ debounce: ms }`,
`{ throttle: { perMs } }`, `{ sample: { every } }`.

**Notices** (revision 3). A host that infers where an agent's unaddressed speech goes from
the traffic it receives — for example, the channel of the most recent message — SHOULD NOT
let a `chat:system` event decide it, and SHOULD NOT treat a notice as a message for the agent
to reply to. Whether a notice *wakes* the agent stays an ordinary rule above. This only
withholds treatment; it never grants anything (§7).

## 7. Tags are never authority

**Admission is decided before tags are read.** Whether a `push/event` or `channels/incoming`
message enters the host at all is decided by the connection capability grant (RFC-002 §3) —
`pushEvents`, `channels.incoming` — and by channel authorization (RFC-002 §5). Tags
influence *treatment* only after admission.

Normatively:

- A tag or ontology **MUST NOT** widen a capability grant.
- A tag **MUST NOT** authorize a channel, or cause a message on an unauthorized channel to
  be admitted.
- A tag **MUST NOT** bypass source-aware gate policy. A consumer rule matching
  `chat:addressed` applies *within* whatever the grant already permits.
- Tags are **untrusted claims** authored by the producer, exactly like `origin` and
  `metadata`. A host MAY disbelieve them.

This is the tag-layer statement of RFC-002 §2.1: anything the server supplies in its own
message is testimony, not authorization.

## 8. Backward compatibility

- `tags` is OPTIONAL; producers adopt incrementally. Absent tags → hosts route as before
  (featureSet/scope/origin).
- Legacy `origin` booleans and host-specific `metadataTrue` matching continue to work; tags
  are the recommended path forward.
- No change to `featureSet` semantics, `eventId` idempotency, or response shapes.
- `defaultTreatment` is accepted as a deprecated alias for `suggestedTreatment`, with the
  revised semantics of §5.2 — it is not applied automatically even under the old name.

## 9. Implementation status (informative)

Current as of 2026-08-02; see AUDIT-001 §5. The revision 3 rollout note below the tables is as of 2026-10-26.

**Shipped:**

| Surface | Where |
|---|---|
| `tags` on `push/event` and `channels/incoming` | `mcpl-core-ts` 0.2.2; discord-mcpl, portal-mcpl, zulip_mcp |
| `tagOntology` in feature-set declarations | discord-mcpl (`open: true`), portal-mcpl (`open: false`) |
| `tagsAny` / `tagsAll` / `tagsNone`, globs, first-match-wins | agent-framework `EventGate` |
| Agent-facing tag introspection | agent-framework |

**Gaps:**

| Gap | Status |
|---|---|
| `implies` closure | Declared in types, **never consumed**. Under §4.1 the host must now implement the *core* closure; producer edges need the acceptance path. |
| `defaultTreatment` precedence chain | Declared, **never consumed**. Under §5.2 it must not be consumed automatically — so the gap is now partly the correct behaviour, and what is missing is the acceptance UI. |
| `chat:reaction-remove` | **Never emitted.** discord-mcpl tags both add and remove as `chat:reaction`; the distinction survives only in `origin.action`. Needs fixing (§4). |
| Rust `mcpl-core` | **No RFC-001 support at all.** No Rust peer can emit or read tags. Needs field parity. |
| eidoverse | **Migrated after revision 2:** emits `chat:*` core plus `eidoverse:*` tags and declares an ontology; the `mentioned` / `isExplicitMention` metadata booleans remain as a transition shim for hosts that don't read tags yet. (Original gap: flat un-namespaced `mention`/`whisper`/`activity` tags, no ontology.) |
| `tags/describe` | Removed from this RFC (§5.3). |

**Revision 3 rollout** (2026-10-26): `chat:system` is in review in eidoverse (world notices,
eidoverse-worlds#280), agent-framework (kept out of speech routing, agent-framework#830) and
mcpl-core-ts (`CHAT_TAGS.system`, #27). discord-mcpl does not yet emit it for Discord's
system messages (joins, pins, thread creation, boosts).

**Correction to revision 1.** §9.2 of the original stated that portal-mcpl carried a
*copied* `mcpl-core` dependency while discord/x/heartbeat were symlinked. **The arrangement
is the reverse:** portal-mcpl is symlinked to live `mcpl-core-ts` 0.2.2, and discord-mcpl
resolves a copied directory pinned at 0.2.1.

## 10. Appendix (informative): platform emission

**discord** — core: `chat:mention|reply|dm|ambient|broadcast|reaction|reaction-remove|
to-self|from-human|from-bot|from-agent|edited|deleted|has-*|thread`. Extensions:
`discord:everyone`, `discord:here`, `discord:role-mention` (a role you hold, ≠ you),
`discord:forum`, `discord:slash`, `discord:voice`, `discord:pin`, `discord:sticker`,
`discord:nsfw`. Not yet emitted: `chat:system` on Discord's system messages (joins, pins, thread
creation, boosts).

**portal** (webhook personas over the relay) — maps `AddressInfo.reasons` to core:
role/name mention → `chat:mention`, reply → `chat:reply`, subscription → `chat:ambient`;
persona author → `chat:from-agent`. Emits the `chat:addressed`/`chat:ambient` umbrella
directly. Extensions: `portal:role-mention`, `portal:name-mention`, `portal:subscription`,
`portal:persona`.

> **Correction to revision 1**, which stated portal has "No DMs (omits `chat:dm`)". It does
> emit `chat:dm`, when `guildId === null` or the relay reports a `dm` reason. What portal
> emits no locus tags for is `chat:private` / `chat:group` — neither appears in the tree, so
> §4.1's `chat:dm ⇒ chat:private` closure is a widening for portal, not a conflict.

**telegram** — chat types map to core: private → `chat:dm`+`chat:private`,
group/supergroup → `chat:group`, channel → `chat:broadcast`. Extensions:
`telegram:supergroup`, `telegram:channel-post`, `telegram:bot-command`,
`telegram:forwarded`, `telegram:via-bot`, `telegram:inline-query`, `telegram:callback`,
`telegram:join`/`telegram:leave`, `telegram:poll`, `telegram:location`, `telegram:sticker`.

**eidoverse** (world events) — current bespoke tags map to core: `mention` →
`chat:mention`, `whisper` → `chat:dm`+`chat:private`, `activity` → `chat:ambient`.
Extensions: `eidoverse:activity-digest`, `eidoverse:presence`. With revision 3 (in review,
eidoverse-worlds#280), world notices — weather, world-change, presence, a departure, the
catch-up header — carry `chat:system` alongside `chat:ambient`.
