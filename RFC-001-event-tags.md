# MCPL RFC-001: Event Tags

**Status:** Accepted (revision 4) — incorporated into [SPEC.md 0.5.0-draft §16](./SPEC.md#16-event-tags).
**Targets:** MCPL Protocol Specification ≥ 0.5
**Authors:** Antra (with Claude); revised by Claude Code and Sol
**Date:** June 2026; revised 2026-08-02, 2026-10-26, 2026-10-30
**Depends on:** RFC-002 (capability grants) for the admission boundary — see §7.

This RFC preserves the proposal and its review history. SPEC.md is authoritative for the current protocol.

> **Revision 4 note.** Says who decides on a server's suggested treatment, and what a host
> does before anyone has. §5.2 said suggestions are "surfaced to a host or operator" and gave
> the decision no shape, so in practice nobody was asked: a host that connected a new server
> treated its events by whatever rules it already had. Two agents stalled in a game of Go
> because the server's `surface:turn` events ("waiting on you") fell to a catch-all rule
> copied from a template written for a chat platform, and were skipped; the server had
> declared a suggested rule for them, and nobody was asked about it. An audit of twelve
> agents' policies against the servers they connect to found 31 of 39 agent/server pairs
> where a `surface:turn` event is silently skipped, and 28 where a `chat:addressed` one is.
> What changed:
>
> - **The agent can accept** (§5.2), alongside the host and the operator, unless the host's
>   configuration does not let it edit its treatment rules. Hosts present suggestions as the
>   claims of a server that may not be trusted, and tell the agent so.
> - **Accepted rules take effect** (§5.2). Each is scoped to the server that suggested it,
>   and placed ahead of any consumer rule that would take that server's events without
>   deciding about them; the consumer's rules that do decide them keep precedence.
> - **Decisions are keyed to the tag ontology** (§5.2), and named by the manifest revision
>   (SPEC §17.1, §17.2). The same revision is not asked again; a changed ontology is a new
>   question, and a revision that changed only other domains is not. SPEC §17.5 step 3,
>   which read as if any revision change ended acceptance, is edited to say the same.
> - **Suggested rules carry a `rationale`** (§5.1): what the rule is for and what declining
>   costs, written for whoever decides.
> - **Undecided attention events are not discarded unasked** (§6). The attention tags are
>   `chat:addressed`, `surface:turn` and `surface:alert`. A rule that names no source,
>   channel, tag or namespace decides nothing, whether it is written bare or as
>   `tagsAny: ["*"]`. Putting the question is not accepting a suggestion, and how often a
>   server can cause it is bounded, so tagging everything `surface:alert` cannot purchase
>   inference.

> **Revision 3 note.** Adds one core tag, `chat:system` (§4, §4.1), for notices from the
> platform or the place rather than messages anyone sent. The core vocabulary could say who
> an event was *for* (`chat:addressed` / `chat:ambient`) but not whether anyone *spoke*, so a
> world's weather change went out as `chat:ambient`, the tag for overheard chatter. A host
> that follows the most recent message for where an agent's unaddressed speech goes then
> followed the weather: a resident's reply meant for a private conversation was spoken
> aloud in a world, because a forecast line had arrived there last. That host already
> exempted reactions, edits and deletions from that treatment; nothing let it exempt a
> notice. Kind is independent of addressing, so §4.1's mutual exclusion does not touch the
> new tag. The tag says what an event is; what a host does with that, including whether it
> directs speech at all, stays the host's (§6).

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
notice, if present, name who it is about (who joined), not a speaker. What a consumer does
with a notice is its own call, as for every tag (§6): a host may not direct speech at all.

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
          "suggestedTreatment": "throttle",
          "rationale": "A role you hold was pinged, usually along with many others; declining leaves these to your rules for ambient traffic."
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
        { "tagsAny": ["chat:addressed"], "behavior": "immediate",
          "rationale": "Someone is speaking to you: a mention, a reply or a DM. Declining leaves them waiting until you look." },
        { "tagsAny": ["chat:deleted"],   "behavior": "mute",
          "rationale": "A deletion rarely needs an answer; declining leaves deletions to your other rules." },
        { "tagsAny": ["chat:ambient","chat:from-bot"], "behavior": "throttle",
          "rationale": "Overheard chatter and bot traffic, at a bounded rate; declining leaves them to your other rules." }
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
| `tags.<tag>.rationale` | Why the per-tag `suggestedTreatment` is suggested (revision 4) — see below. |
| `tags.<tag>.stability` | `stable` (default) / `experimental` / `deprecated`. |
| `keyed.<key>` | A `key=value` family with a suggested `values` set and optional local `ordered` flag. Ordering is a hint **within this namespace only** — never a cross-server scale. |
| `suggestedTreatment` | Ordered suggested rules. **Advisory** — see §5.2. Each rule MAY carry a `rationale` (revision 4) — see below. |
| `open` | `true` ⇒ the server may emit further tags in its namespace(s) beyond those described. |

> Renamed from `defaultTreatment` in revision 1. The old name implied the rules were a
> default the host would apply; they are not (§5.2). Hosts SHOULD accept `defaultTreatment`
> as a deprecated alias.

**`rationale`** (revision 4). An optional string on a suggested rule, or beside a per-tag
`suggestedTreatment`, saying what the rule is for and what declining it costs. It is written
for whoever decides (§5.2), which may be the agent itself, so it should say what happens to
that reader's events rather than describe the server. A games server's rule for turns
(`surface:turn` is RFC-014 §7's):

```jsonc
{ "tagsAny": ["surface:turn"], "behavior": "immediate",
  "rationale": "An opponent or job is waiting on you; declining leaves games stalled until you look." }
```

A rationale is the server's words and confers nothing (§7). A host presents it as §5.2 says,
and MAY truncate it. Like `desc`, it is free text, not an identifier position (SPEC §17.2).
It is part of the `tagOntology`, so rewording it is a new question under §5.2: the acceptor
read the old text.

### 5.2 Suggested treatment is an onboarding hint, not policy

A producer's `suggestedTreatment` (and per-tag `suggestedTreatment`) **MUST NOT** be applied
automatically. It is inspectable configuration, surfaced to an acceptor (below), applied only
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
rules should be able to show which rules came from where, and revoke them. Revision 4 ties
this to the decision record below.

**Acceptors** (revision 4). The host, an operator, or the **agent** (the model the host
serves) may accept or decline a server's suggestions. The agent is free to accept unless the
host's configuration does not let it edit its treatment rules. A host MAY restrict further
what the agent may accept, for example by requiring an operator's approval for `immediate`
on tags that are not attention tags (§6); that is a host's choice, not a default. Acceptance
of producer `implies` edges (§4.1) is unchanged by this revision: it stays with the host or
operator.

**Presenting suggestions** (revision 4). Suggestions and their rationales are claims made by
a server that may not be trusted. A host SHOULD present them as such: attributed to the
server and quoted, never as the host's or the operator's instructions. A host that puts them
to the agent SHOULD tell it so: it should use reasonable caution in accepting, and when in
doubt ask a human (an operator) or another agent for advice.

**Decisions** (revision 4). A decision on a feature set's suggestions is **accepted** (all of
them, or a subset the acceptor names) or **declined**. A suggestion is named by its position
in the `suggestedTreatment` list, counting from 1, or, for a per-tag suggestion, by its tag.
The host records, per server and feature set, the decision, the suggestions it took, who
decided, and the **manifest revision** in force when it was made. That revision is the
`revision` member of SPEC §17.1, the canonical digest defined in SPEC §17.2 (RFC-003). For a
server that sends no `revision`, the host computes the same digest over the manifest it
holds, as §17.2 already permits.

- **Keyed to the tag ontology, named by the revision.** A host SHOULD NOT put the question
  again for a revision it holds a decision for. A host MAY also key the decision by its own
  digest of the feature set's `tagOntology`, which changes exactly when the question does.
- **A changed ontology is a new question.** When the host's diff of a fetched manifest
  (SPEC §17.5) shows the feature set's `tagOntology` changed, a prior decision no longer
  stands: acceptance is invalidated (SPEC §17.5) and a decline lapses with it. A revision
  that changed only in other domains does not reopen it, and SPEC §17.5 step 3 now says so.
  The revision names the question; it never proves the ontology unchanged, which is the
  diff's job (SPEC §17.1).
- **Reporting.** An invalidated acceptance is SPEC §17.6's `ontology-acceptance-invalidated`.
  A lapsed decline is no change-receipt impact of its own, since nothing in force changed.
  Either way, the reopened question reaches an acceptor as §6 describes, and a
  host MAY deliver it with the receipt.
- An acceptor may revisit its decision at any time; a decline does not prevent a later
  acceptance.

**Accepted rules take effect** (revision 4). An accepted suggestion becomes a rule in the
consumer's list (§6): a list rule as written, a per-tag suggestion for tag `T` as
`{ "tagsAny": ["T"], "behavior": … }`, in the server's order (list rules first, then per-tag
ones sorted by tag). Each is **scoped to the server that suggested it**: it matches only that
server's events, whatever its tag matchers say, so acceptance never reaches another server's
events. Accepted rules **MUST** take effect for the events they match. A host places them
ahead of any consumer rule that would take those events without deciding about them (§6),
such as a catch-all; the consumer's own rules that decide those events, by that server, its
channels or its tags, keep precedence. Each accepted rule stays attributable to
the decision that took it and revocable through it, without touching the consumer's own
rules.

> **Why the agent, and why a record.** Revision 2 made acceptance explicit and named nobody
> to do the accepting. Hosts implemented the refusal half (suggestions are never applied)
> and not the asking half, so a new server's events met rules written before it existed,
> often a catch-all that skipped them (§6). The agent is the party whose attention the rules
> spend, and is often the one connecting the server, with no operator present. A rationale
> can be written to persuade, so what persuasion can buy is bounded by scope: an accepted
> rule treats only the suggesting server's own events, can be traced to the decision that
> took it, and can be revoked. That is no more than the agent could grant by writing a rule
> for that server itself, where its host lets it. Keying the decision to the declaration
> keeps asking cheap: once per ontology rather than on every connect, and a server that
> changes what it suggests is asked again instead of inheriting a yes given to something
> else.
>
> A placement rule is needed because the failure being fixed is a catch-all. Appended below
> the catch-all, an accepted rule never matches, and the acceptance changes nothing.

**Not yet: vetted servers.** Certifying or attesting servers, so that a host could extend
trust to a vetted server's suggestions, is future work. It needs an identity story MCPL does
not yet have (SPEC §17.9).

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
  merged into the consumer's own rule list at acceptance time, not consulted at match time,
  at the place §5.2 gives them (revision 4).

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

**Undecided attention events** (revision 4). A rule **decides** the events it takes when it
names their source or channel (a `source` or `channel` predicate), or names a tag or a
namespace in a `tagsAny` or `tagsAll` pattern: `surface:turn`, or `surface:*`, whose author
chose that namespace. A pattern that matches every tag, such as a bare `*` or `*:*`, names
nothing, and nor does a source or channel of `*`; `tagsNone` names only what a rule leaves
out. An event is **undecided** when its treatment came only from the host default, or from a
rule that decides nothing.

An **attention tag** says that something waits on the agent or needs it now:
`chat:addressed` (after closure, §4.1, so every mention, reply and DM), and RFC-014 §7's
`surface:turn` and `surface:alert`. `surface:invite` is not one. A server may still suggest
`immediate` for invites; an undecided invite just does not trigger what follows.

A host SHOULD NOT discard an undecided event that carries an attention tag (treat it so that
it never reaches the agent) unless a decision on that server's treatment has been surfaced to
an acceptor (§5.2) for its current declaration, answered or not. What is surfaced is the
server's suggested treatment with its rationales (§5.1) if it declared any, and otherwise the
fact that its events of this kind are being discarded, so that someone can write a rule.

Surfacing a decision **MUST NOT** itself amount to applying a suggestion: the event keeps the
treatment it had, and no suggested rule applies to it or to later events until an acceptor
accepts. How the question reaches the acceptor (an operator notice, the agent's next turn, a
turn of its own) is the host's choice. A host SHOULD bound how often one server can cause a
decision to be surfaced: at most once per manifest revision (§5.2), and within an overall
per-server limit, since a server can mint revisions by editing its ontology. Under that bound,
a server that tags every event `surface:alert` buys one question, not inference.

> **Example: the catch-all.** A rule that decides nothing, placed above the host default
> (say `{ "behavior": "skip" }` closing a list written for one chat platform), matches
> everything that reaches it. `{ "tagsAny": ["*"], "behavior": "skip" }` is the same rule
> spelled differently. For the servers its author knew, earlier rules caught what mattered.
> For every server connected later it is the first rule anything meets, so all of that
> server's events are undecided, attention tags included: the Go turns of the revision 4
> note met exactly this rule. Accepting that server's suggestions places its rules above the
> catch-all (§5.2). Hosts MAY warn about such a rule, in either spelling, when it is written
> or when a server connects whose attention events it would take.

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
- `rationale` (§5.1, revision 4) is optional; a host that ignores it presents suggestions
  without it.

## 9. Implementation status (informative)

Current as of 2026-08-02; see AUDIT-001 §5. The revision 3 and revision 4 rollout notes below the tables are as of 2026-10-26 and 2026-10-30.

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

**Revision 4 rollout** (2026-10-30): games-mcpl declares suggested rules with `rationale`
(anima-research/games-mcpl#5, in review). agent-framework implements the host side
(anima-research/agent-framework#957, in review), which is the missing acceptance path of the
`defaultTreatment` gap above. It offers a server's suggestions to the agent once per digest
of its declared ontologies, and writes accepted rules as `suggested:<server>:<n>`, scoped to
the server and placed ahead of the first catch-all.

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
eidoverse-worlds#280), world notices — weather, world-change, presence, the activity
digest, a departure, the catch-up header — carry `chat:system` alongside `chat:ambient`.
