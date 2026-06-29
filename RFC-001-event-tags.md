# MCPL RFC-001: Event Tags

**Status:** Draft
**Targets:** MCPL Protocol Specification ≥ 0.5
**Authors:** Antra (with Claude)
**Date:** June 2026

---

## 1. Summary

This RFC adds a standardized, multi-valued **`tags`** dimension to MCPL events,
so a *producer* (server) can label what an event *is* and a *consumer* (host)
can decide *how to treat it* — including how/whether it wakes the model. Tags are
namespaced, discrete (not an ordered scale), and meaning lives on the consumer
side. A small reserved **`chat:*`** core vocabulary gives cross-platform
portability; per-platform namespaces (`discord:*`, `telegram:*`, …) carry the
long tail.

It generalizes today's ad-hoc, producer-specific boolean metadata (e.g.
discord-mcpl's `isMention`/`isDM` on `origin`) into a first-class contract, and
removes the need for hosts to hardcode any one platform's taxonomy (the
"`metadataTrue: ["isMention"]`" anti-pattern).

## 2. Motivation

- **Wake routing needs semantics, not magic flags.** Hosts decide whether an
  event triggers inference. Today the only signals are `featureSet` (coarse,
  single-valued, capability-oriented), `scope`/`source`/`channel` (structural),
  and free-form `origin` booleans that only one host knows how to read.
- **"Mention" is just one event type.** A robotics integration has collision /
  obstacle / telemetry tiers; a chat integration has mention / reply / ambient /
  reaction. The host must not special-case one producer's categories.
- **Producers must not have to agree on a scale.** A shared *ordered* priority
  ladder fails the moment independent producers calibrate it differently. Tags
  sidestep this: they are discrete labels; the consumer assigns treatment.

### Design principles

1. **Producer describes, consumer decides.** Producers emit labels and *suggest*
   defaults; the consumer's policy is authoritative.
2. **Namespaced.** `namespace:value`. A reserved `chat:` core; per-producer
   namespaces otherwise. No cross-producer coordination required.
3. **Discrete facets, never an ordered scale.** Shared *vocabulary* is fine
   (`chat:mention` means the same thing everywhere); shared *ordering* is not.
4. **Structure stays first-class.** Identifiers (guild/channel/sender ids) remain
   on `source`/`channel`/`origin` — they are not tags. Tags are the *semantic*
   layer only.
5. **Additive & backward-compatible.** Existing `featureSet`, `origin`, and
   host-specific metadata keep working.

## 3. The `tags` field

A new OPTIONAL field `tags: string[]` is added to events the host may route on:

- `push/event` params (alongside `featureSet`, `origin`, `payload`).
- `channels/incoming` messages (alongside `metadata`).

```jsonc
{
  "method": "push/event",
  "params": {
    "featureSet": "discord.messaging",
    "eventId": "evt_abc",
    "timestamp": "2026-06-28T10:30:00Z",
    "tags": ["chat:mention", "chat:from-human", "chat:has-image", "discord:role-mention"],
    "origin": { "server": "discord", "channelId": "123", "messageId": "456" },
    "payload": { "content": [ { "type": "text", "text": "…" } ] }
  }
}
```

### 3.1 Syntax

- A tag is a non-empty string of the form `namespace:value`, optionally
  `namespace:key=value` for faceted tags (e.g. `urgency:high` where a consumer
  *chooses* to treat the value-space as ordered — opt-in, never required).
- Namespaces: the reserved `chat:` core (§4) and `mcpl:` (reserved for future
  spec use); all others are producer-defined and SHOULD match the producer's
  declared name (e.g. `discord:`, `telegram:`, `portal:`, `robotics:`).
- Tags are a **set** (unordered, deduplicated). An event carries as many as
  apply.

### 3.2 Relationship to existing fields

- `featureSet` remains the coarse top axis (capability gating + routing key).
  Tags are the fine-grained per-event layer beneath it.
- `origin` remains free-form provenance. Producers MAY continue to emit legacy
  booleans there for back-compat; new consumers SHOULD prefer `tags`.

## 4. Reserved core vocabulary: `chat:*`

Any messaging-style producer SHOULD emit the applicable core tags so consumers
can write portable rules. The set is intentionally small and stable; resist
growth — push the long tail into platform namespaces.

| Facet | Tag | Meaning |
|---|---|---|
| Addressing | `chat:addressed` | Umbrella: the event is directed at the agent (any of dm/mention/reply). |
| | `chat:mention` | The agent was explicitly named/@-mentioned. |
| | `chat:reply` | A reply to the agent's own message. |
| | `chat:dm` | A direct/private 1:1 message to the agent. |
| | `chat:ambient` | Overheard in a followed channel; not addressed. |
| | `chat:broadcast` | Channel-wide ping (`@everyone`/`@here`/channel post). |
| | `chat:to-self` | The event acts on the agent's own content (reaction-to-mine, reply-to-mine). |
| Sender | `chat:from-human` | Authored by a human. |
| | `chat:from-bot` | Authored by a bot/automation. |
| | `chat:from-self` | The agent's own message, echoed back. |
| | `chat:from-agent` | Another known persona/agent. |
| Lifecycle | *(create)* | Plain message creation — the implicit default, no tag. |
| | `chat:edited` | An edit of an existing message. |
| | `chat:deleted` | A deletion. |
| | `chat:reaction` | An emoji reaction was added. |
| | `chat:reaction-remove` | A reaction was removed. |
| Content | `chat:has-image` / `chat:has-audio` / `chat:has-file` / `chat:has-link` | Attachment/content modality. |
| | `chat:command` | A slash/bot command invocation. |
| Locus | `chat:private` / `chat:group` / `chat:thread` | Conversation shape. |

**Reactions** are first-class core because they are cross-platform (Discord
native, Telegram message reactions, portal pseudo-reactions). The wake-relevant
nuance is *whose message* was reacted to: emit `chat:reaction` plus `chat:to-self`
when the target is the agent's own message, so a consumer can wake on reactions
to its content (`tagsAll: ["chat:reaction","chat:to-self"]`) while muting the
rest (`tagsAny: ["chat:reaction"] → skip`).

## 5. Producer declaration: the tag ontology

Producers SHOULD advertise the tags they emit as a **lightweight, open-world
ontology** in their feature-set declaration, so the vocabulary is discoverable, a
zero-config host behaves sanely, and the agent itself can reason about how it
wants to be woken. It is a **hint catalog, not a closed schema**: it need not be
exhaustive, and hosts MUST tolerate tags that aren't described (falling through to
default — §7). It is OPTIONAL; a server that declares nothing still works.

Reference the spec-defined `chat:*` core by listing which core tags you emit
(their descriptions are inherited from §4 — do not redescribe them); describe only
your own namespace(s).

```jsonc
{
  "featureSets": [{
    "name": "discord.messaging",
    "description": "…",
    "tagOntology": {
      "coreTags": ["chat:addressed","chat:mention","chat:reply","chat:dm",
                   "chat:ambient","chat:broadcast","chat:reaction","chat:to-self",
                   "chat:from-human","chat:from-bot","chat:from-agent","chat:deleted"],
      "tags": {
        "discord:role-mention": {
          "desc": "A role the agent holds was pinged — not the agent directly",
          "facet": "addressing", "implies": ["chat:ambient"], "defaultTreatment": "throttle"
        },
        "discord:everyone": { "desc": "@everyone/@here", "facet": "addressing", "implies": ["chat:broadcast"] },
        "discord:slash":     { "desc": "Slash-command invocation", "facet": "content", "implies": ["chat:command"] },
        "discord:voice":     { "desc": "Voice channel state change", "facet": "lifecycle", "stability": "experimental" }
      },
      "keyed": {
        "urgency": { "desc": "Producer urgency hint", "values": ["low","normal","high"], "ordered": true }
      },
      "defaultTreatment": [
        { "tagsAny": ["chat:addressed"], "behavior": "immediate" },
        { "tagsAny": ["chat:deleted"],   "behavior": "mute" },
        { "tagsAny": ["chat:ambient","chat:from-bot"], "behavior": "throttle" }
      ],
      "open": true
    }
  }]
}
```

### 5.1 Descriptor fields (all optional)

| Field | Meaning |
|---|---|
| `coreTags` | Which reserved `chat:*` tags this server emits; descriptions inherited from §4. |
| `tags.<tag>.desc` | Human/agent-readable description — the core of discoverability. |
| `tags.<tag>.facet` | Group: `addressing` / `sender` / `content` / `lifecycle` / `locus` — for UI grouping + alternative-vs-combinable hints. |
| `tags.<tag>.implies` | Subsumption: tags this one entails (e.g. `discord:everyone ⊑ chat:broadcast`). Drives expansion — see §6.1. |
| `tags.<tag>.defaultTreatment` | Per-tag suggested behavior (shorthand for a one-tag rule). |
| `tags.<tag>.stability` | `stable` (default) / `experimental` / `deprecated`. |
| `keyed.<key>` | A `key=value` tag family with a suggested `values` set and optional local `ordered` flag. Ordering is a hint **within this namespace only** — never a cross-server scale (§2). |
| `defaultTreatment` | Ordered suggested rules (§6) the host seeds **below** the consumer's own. |
| `open` | `true` ⇒ the server may emit further tags in its namespace(s) beyond those described. |

### 5.2 Discovery

The ontology is declared **at init** (in the feature-set declaration) for the
common case — available before any events flow. Servers with very large or
runtime-dynamic vocabularies (e.g. a robotics integration with hundreds of sensor
tags) MAY instead/also support a **`tags/describe` request** (Host → Server)
returning the same structure on demand, keeping init lean. Static declaration is
the baseline; the method is the escape hatch.

## 6. Consumer treatment (recommended; host-defined behavior)

The MCPL spec standardizes the *contract* (tags + declaration). The *wake
behavior* is host territory, but for consistency hosts SHOULD evaluate treatment
with the spec's existing idioms:

- An **ordered rule list, first-match-wins** (as Feature Sets §6 and Scope
  whitelist/blacklist §7.6 already do). No behavior merging.
- Match operators over tags: **`tagsAny` / `tagsAll` / `tagsNone`** (glob
  allowed, e.g. `robotics:*`), composable with `source`/`scope`/`channel`.
- **Implication expansion (§6.1).** Before matching, the host expands the event's
  tag set with the `implies` closure declared in producer ontologies — so a rule
  on an umbrella tag matches an event that carried only a specific one.
- **Precedence:** consumer rules → producer `defaultTreatment` → host global
  default. So the consumer always overrides; the producer fills gaps.
- Recommended behavior vocabulary (host-implemented): `immediate`, `mute`,
  `{ debounce: ms }`, `{ throttle: { perMs } }`, `{ sample: { every } }`.

```jsonc
// consumer policy (portable across platforms)
[
  { "tagsAny": ["chat:addressed"], "behavior": "immediate" },
  { "tagsAll": ["chat:ambient"], "tagsNone": ["chat:from-self"], "behavior": { "debounce": 180000 } },
  { "tagsAny": ["chat:deleted","chat:from-bot"], "behavior": "skip" }
]
```

### 6.1 Implication expansion

When producer ontologies declare `implies`, the host SHOULD compute the transitive
closure of an event's tags before evaluating rules. This lets producers emit only
the most specific tag while consumer rules target umbrellas: an event tagged
`chat:mention` (which `implies` `chat:addressed`) matches both
`tagsAny:["chat:mention"]` and `tagsAny:["chat:addressed"]`. Expansion is purely
additive — it never removes tags — and cycles are ignored. Hosts MAY cache the
closure per (server, featureSet) since ontologies are stable within a session.

## 7. Backward compatibility

- `tags` is OPTIONAL; producers adopt incrementally. Absent tags → hosts route as
  today (featureSet/scope/origin).
- Legacy `origin` booleans and host-specific `metadataTrue` matching continue to
  work; tags are the recommended path forward.
- No change to `featureSet` semantics, `eventId` idempotency, or response shapes.

## 8. Appendix A (informative): platform emission

**discord** — core: `chat:mention|reply|dm|ambient|broadcast|reaction|to-self|
from-human|from-bot|from-agent|edited|deleted|has-*|thread`. Extensions:
`discord:everyone`, `discord:here`, `discord:role-mention` (a role you hold, ≠
you), `discord:forum`, `discord:slash`, `discord:voice`, `discord:pin`,
`discord:sticker`, `discord:nsfw`.

**portal** (webhook personas over the relay) — maps `AddressInfo.reasons` to
core: role/name mention → `chat:mention`, reply → `chat:reply`, subscription →
`chat:ambient`; persona author → `chat:from-agent`. No DMs (omits `chat:dm`).
Extensions: `portal:role-mention`, `portal:name-mention`, `portal:subscription`,
`portal:persona`.

**telegram** — chat types map to core: private → `chat:dm`+`chat:private`,
group/supergroup → `chat:group`, channel → `chat:broadcast`. Extensions:
`telegram:supergroup`, `telegram:channel-post`, `telegram:bot-command`,
`telegram:forwarded`, `telegram:via-bot`, `telegram:inline-query`,
`telegram:callback`, `telegram:join`/`telegram:leave`, `telegram:poll`,
`telegram:location`, `telegram:sticker`.

## 9. Implementation plan (informative)

1. **Spec:** land §3–§5 normatively in SPEC.md (≥ 0.5); §6 as recommended;
   reserve the `chat:*` core (§4).
2. **Types (`mcpl-core-ts` / `@animalabs/mcpl-core`):**
   - add `tags?: string[]` to `PushEventParams` and `IncomingChannelMessage`;
   - add `TagOntology` + `TagDescriptor` + `TreatmentRule` types and extend
     `FeatureSetDeclaration` with `tagOntology?: TagOntology`;
   - optionally export the reserved `chat:*` vocabulary as constants;
   - bump 0.1.0 → 0.2.0 (additive). **Refresh portal-mcpl's *copied* dep**
     (re-symlink or reinstall) — symlinked consumers (discord/x/heartbeat) get it
     on rebuild; the Rust `mcpl-core` mirrors the fields later for parity.
3. **Host (agent-framework EventGate):** add `tagsAny/tagsAll/tagsNone` match, the
   `implies`-closure expansion (§6.1), and the consumer→producer-default→global
   precedence chain; behaviors `debounce`, `rate_limit`/`throttle`,
   `passive_sample` already exist.
4. **Producers:** discord-mcpl and portal-mcpl emit `chat:*` (+ their namespaces)
   from signals they already compute (`AddressInfo`, mention/DM flags); declare a
   `tagOntology` (referencing `coreTags`) with `defaultTreatment`.
5. **Migration:** keep `origin` booleans during transition; flip the channel-wake
   tool to operate on `(source, channel, tags)` bands.
