# MCPL RFC-002: Capability Grants and Negotiated Policy

**Status:** Accepted — not yet applied to SPEC.md
**Targets:** MCPL Protocol Specification ≥ 0.5
**Authors:** Claude Code and Sol, with antra and imago
**Date:** 2026-08-02
**Companion:** AUDIT-001 (spec vs. implementations) — every empirical claim here is anchored there.

**Review history.** Reviewed end-to-end by Sol across three passes. Blockers raised and
resolved: `§5.1` unimplementable for a Notification-only `channels/changed`; undefined
precedence between `effectiveCapabilities` and `deniedCapabilities`; missing terminal-phase
invariant on `inference/lifecycle`; an incorrect claim that dog_mcp would need no context
hook; an ungrounded `channels.observe` grant; and an overclaim that fail-closed derivation
would be self-diagnosing at negotiation time. Positions reversed during review, in each case
by evidence from AUDIT-001 rather than argument: `afterInference.transform` went from
"preserve behind a conspicuous grant" to removed, and `afterInference.observe` from "keep for
side effects" to replaced by a metadata-only signal.

---

## 1. Summary

MCPL today has no way for a host to tell a server what it is allowed to do, and no way
for a server to say what happens when it is denied. Feature sets (§6) look like an
access-control layer but are **self-attested by the server** on every path where it
matters, and the spec's enforcement mechanism (§6.6) has **zero live implementations on
either side**.

This RFC replaces that with:

1. A **connection capability grant** — a hierarchical, host-computed set of capability
   paths, splitting *observation* from *authority to alter*, which is the real security
   boundary.
2. **Negotiated policy** — `featureSets/update` promoted to a dual-mode
   Notification-or-Request, whose response is a **degradation receipt** rather than an
   acknowledgement.
3. **Two layers, not three** — the connection grant and feature-set selection. `scope/elevate`
   and §7 are removed (§7.1 explains why, and what a replacement must look like).
4. **Removals justified by evidence, not taste** — response rewriting (`modifiedResponse`,
   blocking `afterInference`) and content-bearing `afterInference` observation are struck —
   zero users, one deliberate abandonment, replaced by metadata-only `inference/lifecycle`
   (§3.5, §7.2); and a normative rule closes a repeated double-delivery bug class
   (§7.4).

It also fixes the spec bugs and unimplementable shapes that AUDIT-001 turned up.

---

## 2. Motivation

### 2.1 Feature sets are not a security boundary

Two independent reasons, both load-bearing:

**Self-attestation.** Per §6.5, context hooks are the one direction where `featureSet` is
supplied *by the server, in its response*; the host sends none inbound. §6.6 only checks
that the claimed name is enabled. A malicious server names an enabled feature set on its
injection and is authorized. `namespace` (§10.4) is likewise "Server-defined". On a hook
response, the only trustworthy inputs are **which connection it arrived on** and the
typed `position` field.

**Process granularity.** Feature sets are not a confidentiality boundary *inside one
server process*. Once any enabled feature causes the host to send that process a hook
payload, all code in it can read the payload regardless of which feature-set name it
later claims.

### 2.2 The enforcement mechanism is fiction

AUDIT-001 §2.1: the host rejects a disabled-feature-set `push/event` with a JSON-RPC
*result* `{accepted:false, reason}`, not the `-32001` error §6.6 specifies. The
`featureSetNotEnabled` / `unknownFeatureSet` factories exist and are never invoked; all
three §14.6 channel codes are defined and never thrown. Meanwhile discord-mcpl and
portal-mcpl send `push/event` fire-and-forget and never read the response.

§6.6 is not a fallback that negotiation supplements. There is nothing there to supplement.

### 2.3 Observation and authority are bundled

`contextHooks.beforeInference` grants both *reading* `userMessage` and *writing*
`contextInjections` — including at `"position": "system"`. `contextHooks.afterInference`
grants both receiving the response and, in blocking form, replacing it via
`modifiedResponse`. §13.1's own risk table names the doubled risk
("Read context, inject content") and offers "Review descriptions" as mitigation. §13.4's
only control — *"Servers MUST NOT inject content that attempts to override system
instructions"* — is a MUST NOT aimed at the untrusted party.

For an untrusted server, **write access to the system position is a larger hazard than
read access to output.**

### 2.4 Policy delivery already fails silently

AUDIT-001 §2.6: four servers discard notifications before method dispatch and never
receive `featureSets/update` at all; portal-mcpl receives it and explicitly no-ops;
the host only sends it when `enabled`/`disabled` is non-empty, so a server defaulted to
fully-disabled is never told. Every one of these failures is invisible to both parties.

---

## 3. The capability grant (layer 1)

### 3.1 Capability paths

A capability path is a dot-separated identifier naming one authority. The vocabulary
replaces the flat `uses` enum of §6.2 / App. B.2:

```
pushEvents
tools
modelInfo
inferenceRequest
inferenceRequest.streaming
inferenceLifecycle

contextHooks.beforeInference.observe
contextHooks.beforeInference.inject.system
contextHooks.beforeInference.inject.beforeUser
contextHooks.beforeInference.inject.afterUser

channels.register
channels.lifecycle
channels.publish
channels.incoming
channels.streaming
channels.acknowledge
channels.typing
```

The `inject.*` leaves are exactly the values of the existing `Position` enum (App. B.3),
which is already a REQUIRED field on every injection (§10.4). **No new wire field is
needed to enforce them.**

There is deliberately **no `contextHooks.afterInference.*`**. The hook is replaced entirely
by `inference/lifecycle` (§3.5); response rewriting is removed (§7.2).

**`channels/incoming` gets its own path, and `channels.observe` is gone.**
`channels/incoming` is server→host *content injection* plus wake/attention authority — a
write, and one of the most consequential a server has. Naming its grant `observe` would
understate it and rebundle exactly the read/write split this RFC exists to make.

Once it is named `channels.incoming` and outgoing streams are gated on
`channels.streaming`, **no wire method maps to `channels.observe` at all**. A grant with no
method is decorative, and decorative authorization layers are the specific failure this RFC
was written to remove (§2.1, §5). It is therefore struck rather than reserved. If a
host→server channel-visibility surface is introduced later — a snapshot, a context view —
it should arrive with a named method and a grant defined against it.

### 3.2 Grant computation and matching

- The server advertises what it **can** do in `initialize` (unchanged).
- The host computes the **effective grant** per connection: what this server **may**
  do or receive. Advertisement is an input, never an authorization.
- Matching is over full paths with `*` wildcards. Implementations MUST perform a
  **generic recursive walk**. A hardcoded set of nestable keys is non-conforming: the
  vocabulary above is depth 3, and depth will grow.

> **Implementation note.** PR #75's mask uses `NESTED_KEYS = {contextHooks, channels}` and
> walks exactly two levels. `inferenceRequest.streaming` is unmaskable under it, because
> the object is never decomposed, and `contextHooks.afterInference` becomes an atomic leaf
> once it passes the flag check.

### 3.3 A denied capability behaves as if never advertised

The host MUST NOT deliver a message requiring a denied capability, MUST reject an inbound
method requiring one, and MUST NOT accept a response contribution requiring one.

### 3.4 Enforcement is evaluated at response-receipt

For any host-initiated request whose response carries a contribution — after §7.2 this is
`beforeInference` injections, and any contribution-bearing response added later — the host
MUST authorize **each contribution** against the grant **current when the response is
received**, not when the request was sent.

This is a single rule doing two jobs:

- It makes per-injection `position` checks well-defined when one response carries a mixed
  array under a single claimed feature set.
- It closes the in-flight window on revocation for free. §10.6 recommends 5s/10s hook
  timeouts, so a hook dispatched before a revocation can return after it; evaluating at
  receipt means the revocation applies without any additional machinery.

Authorization MUST NOT use the `featureSet` or `namespace` in the response (§2.1).

### 3.5 `inference/lifecycle` replaces `context/afterInference`

`context/afterInference` is removed and replaced by a **metadata-only** signal.

```jsonc
{
  "jsonrpc": "2.0",
  "method": "inference/lifecycle",          // Host → Server, Notification
  "params": {
    "inferenceId": "inf_xyz",
    "conversationId": "conv_123",
    "turnIndex": 7,
    "phase": "started",                      // started | completed | aborted | failed
    "model": { "…": "…" },                  // OPTIONAL, only if `modelInfo` granted
    "usage": { "inputTokens": 1250, "outputTokens": 340 }   // OPTIONAL, completed only
  }
}
```

**It MUST NOT carry message content** — no `userMessage`, no `assistantMessage`, no
injected context, no tool arguments or results. Not "SHOULD moderate": the content fields
do not exist.

Gated on `inferenceLifecycle`. Notification only; there is nothing to answer.

**Pairing invariant (normative).** For every `started` the host emits, it MUST emit
**exactly one** terminal phase — `completed`, `aborted`, or `failed` — for the same
`inferenceId`, on **every** exit path, including host crash-recovery paths where the host
regains control.

- A terminal phase for an `inferenceId` that had no `started`, or a second terminal phase
  for one that already terminated, is a **conformance defect** and SHOULD be logged as
  such by the receiving server.
- Servers MAY treat the invariant as reliable: exactly-once termination is what makes a
  busy/idle state machine sound.

Without this, an observer can only *hope* a turn ended, which is why dog_mcp carries a
15-minute `BUSY_SAFETY_TIMEOUT` today. The invariant is the entire reason that hack can be
deleted rather than merely re-tuned.

**Why this is strictly better than what it replaces.**

`context/afterInference` (§10.5) hands every subscribing server `userMessage` plus the
joined `assistantMessage` — including prose destined for *other* servers' surfaces and
text the host's routing withheld. That is the broadest content-exfiltration surface in
MCPL, and it is broader than the per-channel, moderated view a server already gets from
`channels/outgoing/complete`.

The only genuine consumer in the fleet is dog_mcp, which uses the hook as a **busy/idle
edge** for its attention loop — it needs the turn boundary, not the turn's text. Every
other implementation is a no-op, a retired stub, or declares the capability off (§7.2).

Two further gains:

- **`phase: "started"` removes pure observers from the critical path.** A server that only
  wants turn boundaries no longer has to sit in `context/beforeInference`, a blocking
  Request with a 5s recommended timeout (§10.6). dog_mcp currently does exactly that.

  It does **not** follow that dog_mcp stops using the hook: its `beforeInference` handler
  also injects a body-status line at `position: "beforeUser"`. After this change it needs
  no context hook **for lifecycle**, and no observation grant — but it still needs
  `contextHooks.beforeInference.inject.beforeUser` unless body-state injection is
  redesigned.

  That server is a clean demonstration of why §3.1 splits the hook: dog_mcp **writes
  without reading**. It never touches `userMessage`. Under the old bundled capability it
  had to be handed the user's text in order to append a line about battery level.
- **`aborted` / `failed` are explicit.** Today a server inferring idle-state from
  `afterInference` never learns about a turn that died, which is why dog_mcp carries a
  15-minute `BUSY_SAFETY_TIMEOUT` to unwedge itself.

A server that genuinely needs the *content* of a turn is asking for channel content, and
should take it per-channel and moderated via `channels/outgoing/complete`
(`channels.streaming`) — which is scoped to the surface that server owns, rather than the
whole turn.

### 3.6 Feature sets derive from the grant

A denied capability disables every declared feature set whose `uses` requires it. This is
ergonomics — it prevents wasted work and lets a server report honestly — and it
**supplements, never replaces**, the grant.

The derivation MUST fail closed, under three deterministic rules:

1. **Absent, empty, or unrecognized `uses` ⇒ the declaration is invalid.** The feature set
   is disabled with reason `invalid_uses`. The host does not guess what it meant.
2. **Valid but incomplete `uses` ⇒ the connection grant still protects.** The host cannot
   detect the omission at declaration time. When the server later exercises a capability
   its feature set did not declare, the host rejects that use and emits a
   **declaration-mismatch** diagnostic. Security never depended on the declaration.
3. **A server MAY report further needs in its receipt** (§4.2), from its own knowledge of
   its implementation. That is server testimony (§4.3) — useful, but not something host
   derivation can produce or guarantee.

> **Why fail-closed.** `uses` is already wrong in production. dog_mcp declares
> `uses: ["tools"]` while using `pushEvents` and both context hooks; discord-mcpl and
> portal-mcpl omit `pushEvents` from `uses` while tagging every push event with that
> feature set. Neither core library types `uses` as a closed enum despite App. B.2
> declaring one. A trusting derivation would leave those feature sets enabled after
> denying the capabilities underneath them.

`uses` values MUST be capability paths from §3.1, and implementations SHOULD validate
them at declaration time.

**Decision (antra): fail-closed stands — "better to let stuff break."** Accepted
deliberately, not discovered. Two things make that safe rather than reckless:

**The breakage is loud — but only rule 1 is diagnosable at negotiation time.** An earlier
draft of this section claimed the host would tell a server "exactly which capability it
failed to declare". That was wrong, and wrong precisely for the servers that motivate
fail-closed: if dog_mcp declares `uses:["tools"]`, nothing in the protocol reveals that it
also needs `pushEvents` and the context hooks. **The host cannot name what was never
declared.**

What is actually guaranteed:

- **Rule 1 failures are diagnosed at negotiation**, with reason `invalid_uses` — the host
  can tell a declaration is malformed without knowing what it meant.
- **Rule 2 failures are diagnosed at first use**, as a declaration-mismatch rejection
  naming the capability actually exercised and the feature set that failed to declare it.
  Later than negotiation, but precise and attributable.
- **Anything beyond that is server testimony** in the receipt (§4.2), not host derivation.

"Break loudly" is defensible. "Break self-diagnosing at negotiation time" is not
achievable for incomplete declarations, and this RFC must not promise it.

**The blast radius is known in advance.** AUDIT-001 enumerated the inaccurate
declarations, so adoption does not require discovery:

| Feature set | Declares today | Correct `uses` under §3.1 |
|---|---|---|
| `dog_mcp` (single set) | `["tools"]` | `pushEvents`, `inferenceLifecycle`, `contextHooks.beforeInference.inject.beforeUser` (+ `tools` if it exposes any) — note **no** `.observe`: it injects without reading |
| `discord.messaging` | `["tools","channels.publish"]` | + `pushEvents`, `channels.incoming`, `channels.register`, `channels.lifecycle` |
| `portal.messaging` | `["tools","channels.publish"]` | + `pushEvents`, `channels.incoming`, `channels.register`, `channels.lifecycle` |
| `heartbeat` | `["tools"]` | + `pushEvents` |
| eidoverse, tavern | *(no feature sets at all)* | channels throughout |

Fixing these is a one-line change per feature set and should land **before** the
derivation does. Implementations SHOULD emit a declaration-time warning when a server
exercises a capability absent from the exercising feature set's `uses`, so the remaining
cases surface as warnings before they surface as outages.

---

## 4. Negotiated policy

### 4.1 `featureSets/update` becomes dual-mode

`featureSets/update` (Host → Server) MAY be sent as a Notification or as a Request. This
reuses the idiom §14.3 already establishes for `channels/publish` ("If an ACK is desired,
send as a Request"). No new method name is introduced.

Hosts **MUST** send it as a Request for **any change to the effective grant** — initial
policy, reduction, *and expansion*.

Notifications remain valid only for purely descriptive feature metadata that does not
alter the grant, and a Notification **cannot establish a ready state**.

> Expansion needs acknowledgement as much as reduction does. A host that widens a grant by
> Notification cannot know when — or whether — the server began honouring it, so it does
> not know when the newly granted path became safe to exercise. See §4.6 for the ordering,
> which is deliberately the mirror image of revocation.

Params gain the effective grant:

```jsonc
{
  "jsonrpc": "2.0", "id": 7,
  "method": "featureSets/update",
  "params": {
    "effectiveCapabilities": ["tools", "channels.publish", "contextHooks.beforeInference.observe"],
    "deniedCapabilities": ["contextHooks.beforeInference.inject.system"],
    "enabled": ["memory.retrieval"],
    "disabled": ["memory.extraction"]
  }
}
```

Capability paths and feature-set names are distinct vocabularies and MUST NOT be merged;
the server derives *why* a feature set died from its own declared `uses`.

**`effectiveCapabilities` is the sole normative allowlist.** It is the intersection of the
server's advertisement *as the host understands it* and host policy. **Every path not
present is denied** — absence is the denial, and there is no "unspecified" state.

`deniedCapabilities` is **derived diagnostic data only**, optionally carrying reasons. It
exists so a server can explain itself to an operator; it MUST NOT participate in any
authorization decision, and a host MAY omit it entirely.

If the two ever conflict — a path appearing in both — the receiving side MUST **fail
closed**: treat the path as denied, and reject the policy message as malformed. Leaving
this to implementations guarantees they invent precedence rules, and they will not invent
the same one.

### 4.2 The response is a degradation receipt

```jsonc
{
  "jsonrpc": "2.0", "id": 7,
  "result": {
    "accepted": true,
    "mode": "degraded",
    "unavailableFeatures": [
      { "featureSet": "memory.extraction",
        "missingCapabilities": ["inferenceLifecycle"],
        "effect": "disabled" }
    ],
    "notes": []
  }
}
```

Or a refusal:

```jsonc
{
  "accepted": false,
  "fallback": "mcp-only",
  "missingCapabilities": ["contextHooks.beforeInference.inject.system"],
  "reason": "…"
}
```

### 4.3 Consequence testimony is not policy authority

The receipt reports what the server *will do*. It does not assert what the server is
*entitled to*.

- The host **MUST NOT** widen any grant in response to a receipt. A refusal may surface to
  a human for a new decision; it MUST NOT reach the policy engine as an input. Otherwise
  refusal becomes a coercion lever — *"I won't start unless you grant `inject.system`"* —
  and a host that widens to satisfy a refusal has inverted the trust direction.
- `required: true` on a feature set is **not** reintroduced. MCPL 0.2.0 removed it
  deliberately ("servers should not dictate host policy") and that decision stands.
  Declaring a consequence and dictating a policy are different acts.

### 4.4 `accepted: false` does not mean close the transport

MCPL is an experimental capability extension (§3.1); §2's first design goal is graceful
degradation, and §3.2 states that an MCPL server in a plain MCP host runs as a normal MCP
server. A failed *MCPL* negotiation therefore has a weaker correct outcome: **disable
MCPL, retain tools/resources/prompts.**

The server names which applies via `fallback: "mcp-only" | "close"`. A memory server whose
tools are meaningless without `beforeInference` genuinely wants closing; a chat connector
usually does not. This remains testimony — the host MAY close regardless — but the host
should not have to guess.

### 4.5 Ordering, and the state before policy

- The host **MUST** send initial policy as a Request before the first hook fan-out and
  before accepting any inbound privileged method.
- Until the initial policy exchange completes, a server **MUST** treat every
  capability-dependent behavior as unavailable, and a host **MUST** reject inbound
  privileged methods.
- The host **MUST** send initial policy even when nothing is enabled or disabled. A server
  defaulted to fully-disabled has to be told.

This closes a gap in §5.3, which says only that hosts *SHOULD* send `featureSets/update`
"after initialization", with no ordering guarantee against first fan-out. "Default before
policy" is currently undefined rather than chosen — and every audited server resolves it
fail-open.

### 4.6 Revocation and expansion have mirrored orderings

**Revocation — apply first, then tell.**

1. The reduction takes effect **atomically**, host-side.
2. The host sends the Request carrying the new grant.
3. The server acknowledges degraded operation, or refuses; if it cannot operate honestly,
   the host drains and closes.

Security cannot wait on consent. An old grant is never kept alive because the peer dislikes
losing it — and a well-behaved peer is never required to continue after losing something
it needs.

**Expansion — tell first, then apply.**

1. The host sends the Request carrying the proposed wider grant.
2. The server returns its receipt.
3. **Only then** does the host begin fan-out on newly granted hooks, or begin accepting
   newly granted inbound methods.

The asymmetry is deliberate and follows from which direction is dangerous. Reducing early
is safe; reducing late leaves a window of over-permission. Expanding early means the host
may send on a path the server has not yet acknowledged — a message arriving under a grant
the recipient does not yet believe it has.

If a server never answers an expansion Request, the grant simply does not activate. That
is the correct failure: the connection continues at the narrower grant.

---

## 5. Channel authorization

The spec's channel gating model is not merely unimplemented — it is unspecified. No
`channels/*` method carries a `featureSet`, so §14.1's `channels.publish` /
`channels.observe` feature sets have nothing to bind to. This is why `ChannelRegistry`
holds a `featureSetManager` reference and never calls it.

Under this RFC, channel methods authorize against the **connection grant**, keyed on
method and channel id:

| Method | Required capability |
|---|---|
| `channels/register`, `channels/changed` | `channels.register` |
| `channels/list` (Host → Server) | `channels.register` |
| `channels/list` (Server → Host) | `channels.register` |
| `channels/open`, `channels/close` | `channels.lifecycle` |
| `channels/publish` | `channels.publish` |
| `channels/incoming` | `channels.incoming` |
| `channels/outgoing/chunk`, `channels/outgoing/complete` | `channels.streaming` |
| `channels/acknowledge` | `channels.acknowledge` |
| `channels/typing` | `channels.typing` |

Per-channel narrowing (patterns like `discord:acme/*`) attaches to the grant entry, not to
a separate scope layer.

### 5.1 Authorization is per descriptor, never per request

`channels/register` and `channels/changed` carry **arrays** of descriptors, not a single
trusted `channelId`. The host MUST authorize **each descriptor independently** against the
grant.

A server MUST NOT be able to widen its registration by bundling one permitted descriptor
with nine forbidden ones. Whole-request authorization on an array is the same defect as
authorizing a hook response by its claimed `featureSet` (§2.1) — a single attacker-chosen
token standing in for many independent decisions.

**`channels/changed` becomes dual-mode.** As a Notification it cannot carry a result, so
neither whole-rejection nor itemized reporting is expressible — the host's only options
would be to drop the whole batch or filter silently, and silent filtering leaves the two
sides disagreeing about which channels exist. Following the §14.3 idiom already used for
`channels/publish`:

- A host whose policy can reject descriptors **MUST** require the Request form; a server
  MUST use it when the host has signalled this.
- The Request form returns an **itemized** result, one entry per submitted descriptor.
- The Notification form remains valid only where no descriptor can be rejected. A host
  receiving a Notification it must partially reject MUST filter itemwise **and** emit a
  diagnostic — never silently.

```jsonc
{ "results": [
    { "id": "discord:#general", "accepted": true },
    { "id": "discord:#admin",   "accepted": false, "reason": "capability_denied" }
] }
```

The same itemized shape applies to `channels/register`, which is already a Request.

### 5.2 Inbound channel content is validated at receipt

`channels/incoming` MUST be validated at receipt against **the current grant** and the
**actually registered** channel — not against the channel id the message claims, and not
against the grant as it stood when the channel was registered.

This is §3.4's rule applied to the channel surface: a channel registered under a grant that
has since narrowed does not keep its old authority, and a `channelId` that was never
successfully registered confers none.

---

## 6. Error semantics

§6.6's reactive model is retained only as diagnostics. It is not an authorization
mechanism and MUST NOT be the only signal a server receives — that is what §4 is for.

Where a host does reject, it MUST use a JSON-RPC **error object**, not a result carrying a
failure flag, and MUST populate the documented codes. Today the host returns
`{accepted:false, reason}` as a *result* for `push/event`, and no channel error code is
ever thrown.

**A method that is never going to be answered MUST return an error.** `model/info` and
inbound `channels/list` currently receive no response of any kind — no
`METHOD_TO_EVENT` entry, no result, no error — so a caller hangs. Beyond the bug, this
poisons the evidence: a surface that never answers cannot accumulate usage, and its
apparent disuse is a measurement artifact.

New code: `-32002 Capability denied`, carrying `data: { capability }`.

---

## 7. Removals

### 7.1 `scope/elevate` and §7 (Scoped Access)

**Removed.** Layer 3 disappears; the model is two layers.

Zero servers implement `scope/elevate`; zero feature sets anywhere declare `scoped: true`;
the host receives `scopes` in config and never puts them on the wire; discord-mcpl
receives `scopes` and ignores them. Nothing depends on it.

More importantly, **its current shape is unsafe under the threat model this RFC exists to
address.** The server supplies both `scope.label` and an arbitrary `scope.payload`, and
§7.6 instructs the host to match the *server-supplied label* against its whitelist. A
malicious server can label an `/etc/hosts` action as `/project/**`, or make label and
payload disagree. This is §2.1's self-attestation defect one layer down. §7.7's
"Hosts MAY cache approvals for the session or persist them" compounds it with no expiry,
provenance, or revocation.

Removing an unsafe mechanism is better than carrying it unused until someone implements it
as written.

**What a replacement must do.** Mid-run elevation is a real need for cooperative servers.
When it returns, it must be a **host-issued bounded grant**, not a trusted request:

- the request names the desired action, target, and reason;
- the host canonicalizes the scope from trusted method/tool arguments or a host-owned
  adapter — never from the server's label;
- approval returns an **opaque grant id** bound to server, capability, normalized target,
  expiry, and one-shot/lease semantics;
- execution is checked against that bound grant;
- the server's label survives only as display testimony.

That belongs in its own RFC, with rate-limiting, provenance, revocation, and
resident-visible scope treated as first-class.

### 7.2 `context/afterInference` in its entirety

**Removed**, and replaced by the metadata-only `inference/lifecycle` (§3.5). Both halves
go — the rewriting authority *and* the content-bearing observation.

`modifiedResponse` appears in **zero** server trees — verified by grep across discord,
portal, eidoverse, tavern, heartbeat, x, xgate, zulip, mcpl-editor and dog_mcp. The core
libraries define the field and the host implements applying it; no server has ever
produced one.

Stronger than disuse: **discord-mcpl adopted the surrounding capability and deliberately
retired it.** `server.ts:764` — *"we intentionally no longer declare
`contextHooks.afterInference`"* — with the handler kept only so a stray request from an
older host is a harmless no-op. zulip registers `() => ({})` and declares
`afterInference: false`. dog_mcp uses the hook as a busy/idle signal: pure observation.

§10.5's **blocking** mode exists solely to carry `modifiedResponse`, so it goes with it.
The remaining justification — a server needing to complete a side effect before the turn
ends — was discord's retired sticky-reply, retired for the reason in §7.4.

**The observation half goes too, because the replacement is strictly better.** Keeping
`afterInference.observe` would preserve the broadest content-exfiltration surface in MCPL
(§3.5) in order to serve one consumer that only wants a turn boundary. `inference/lifecycle`
serves that consumer with no content at all, adds explicit `aborted`/`failed` phases, and
takes pure observers out of the blocking critical path. There is nothing left for
`afterInference` to do.

`contextHooks.beforeInference.inject.*` is **not** affected. Context injection is live,
useful, and independently gated.

> **Note.** This reverses two positions taken earlier in the design discussion: first that
> `afterInference.transform` should be preserved behind a conspicuous separate grant for
> redaction-style uses, then that `afterInference.observe` should be kept for servers
> completing side effects. The audit dissolved both — the capability has zero users, one
> deliberate abandonment, and the surviving need turned out to be for metadata rather than
> content. If output rewriting is wanted later it should return through its own RFC with
> the host-issued bounded-grant discipline of §7.1, not as grandfathered surface.

### 7.3 `featureSets/changed`

**Folded into reconnect semantics.** Zero implementations; servers that change their
declared sets do so by reconnecting and re-declaring. This is the only surface whose
disuse reflects an answer rather than a gap.

### 7.4 Delivery is never a side effect of a lifecycle event

**Normative rule.** A server MUST NOT deliver content to its surface in response to a
host lifecycle notification or hook. Delivery occurs only via `channels/publish`.

This is a bug *class*, not an instance. discord-mcpl has now produced it twice:

- **Sticky auto-reply on `afterInference`** — retired, because *"the old sticky auto-post
  that lived here would double-post against the host router and races the moment a second
  surface (e.g. Telegram) exists"* (`server.ts:764`).
- **`channels/outgoing/complete` calling `discord.sendMessage()`** — live today, dormant
  only because the boolean `channels` capability makes streaming unreachable (§10.1).

Same shape both times: a host lifecycle event interpreted as permission to deliver,
racing the host's authoritative publish. The first was diagnosed and removed; the second
was written afterwards on a different surface.

Hosts SHOULD treat any server-side send triggered by `afterInference`,
`channels/outgoing/chunk`, or `channels/outgoing/complete` as a conformance defect.

### 7.5 What is *not* removed

`inference/request` and `model/info` stay (antra). Both are at zero implementations, but
for reasons that are not evidence against them: every server in the fleet is a chat
connector, and `model/info` acquires a concrete job as soon as hosts expose non-text
models such as image generation. `model/info`'s zero is additionally unfalsifiable — see
§6.

---

## 8. Promotions

`channels/acknowledge` and `channels/typing` are promoted into the spec (agreed).
`acknowledge` has four independent adopters (discord, portal, zulip, host) plus
mcpl-core-ts; `typing` has three. Both were invented independently because the spec left
the need unaddressed.

---

## 9. Companion spec fixes

Not design decisions — defects to land alongside.

1. **Delete §6.4.** It says feature-set selection happens during initialization and the
   host returns it in the initialize response — a 0.2.0 leftover contradicting §5.3/§6.7,
   which the 0.3.0 changelog says moved to post-initialize `featureSets/update`.
2. **Replace the `uses` enum** (§6.2, App. B.2) with §3.1's capability paths. The current
   7 values omit `channels.register`, `channels.lifecycle`, `channels.streaming`,
   `modelInfo`, and anything for state.
3. **Fix `channels` capability shape in both core libraries.** §14.1 defines an object;
   `mcpl-core` and `mcpl-core-ts` both flatten it to a boolean, making `channels.streaming`
   undeclarable and the streaming surface unreachable.
4. **Make `description` required in `FeatureSetDeclaration`** — both libraries make it
   optional though App. B.2 requires it. (`scoped` needs no restoration: it is removed
   along with §7.)
5. **Move the §14.4 `channels` context field to `beforeInference`.** Both libraries attach
   it to `afterInference`. Identical in Rust and TS — copied, not derived.
6. **`model/info` and inbound `channels/list` must answer.** See §6. `channels/list` is
   defined in both directions and appears in the §5 authorization table; today the host
   has no `METHOD_TO_EVENT` entry for the inbound form and never replies, and its outbound
   sender has zero call sites.
7. **Host must advertise its own capabilities accurately** — it currently omits
   `inferenceRequest` and `channels` although both are fully implemented.

---

## 10. Sequencing

Some of this is order-dependent. In particular:

1. **Fix discord-mcpl's `channels/outgoing/complete` handler first.** It calls
   `discord.sendMessage()` directly, treating the stream terminator as authoritative
   delivery. This is dormant *only* because the boolean `channels` capability makes
   streaming unreachable. Fixing the capability shape (§9.3) before fixing the handler
   activates a double-post in production: the host would send `outgoing/complete` and then
   the authoritative `channels/publish`, and Discord would post both. The handler must
   finalize a draft, not deliver.
2. Land §9.1 (delete §6.4) — free, independent of everything.
3. Land §9.3 (capability shape) and the uncommitted streaming diff.
4. Land the capability vocabulary (§3.1) and recursive masking (§3.2).
5. **Correct the inaccurate `uses` declarations listed in §3.6** — one line per feature
   set, and cheaper before the fail-closed derivation lands than after.
6. Land negotiated policy (§4).
7. Remove §7 (§7.1), replace `context/afterInference` with `inference/lifecycle` (§3.5,
   §7.2), fold
   `featureSets/changed` (§7.3), and land the no-delivery-on-lifecycle rule (§7.4).
8. Promote `channels/acknowledge` / `channels/typing` (§8).

---

## 11. Out of scope

- **`state/rollback` and §8 (State Management).** An open question. The host can never
  trigger a rollback today — `sendStateRollback` and `rollbackTo` both have zero call
  sites — while `state/update` and `branches/*` ship in production via mcpl-editor
  (advertising `version: "0.5"`) and mcpl-core-ts's `feature/mcpl-v05-state-branches`.
  §8 as written is not what anyone built. Resolving it needs the authors of that work, and
  folding it in would block security changes behind an unrelated design debate.
- **Server-initiated capability-grant requests.** A degraded server asking for a capability
  it lacks, with reason, duration, and a host-issued lease, is a coherent idea. But every
  other change here *constrains* existing surface, while this *adds* a request type with
  zero implementations and an obvious coercion profile. Ship the receipt first — a degraded
  server is already visible as degraded. If it should later be able to ask, design it with
  the grant-id discipline of §7.1, in its own RFC.
- **General prompt-injection hardening.** Explicitly deferred (antra).
- **RFC-001 (event tags).** Orthogonal and independently tracked. Note its `implies`
  closure and `defaultTreatment` precedence chain are both declared in types and never
  consumed, and the Rust library has none of RFC-001 at all.

---

## 12. Backward compatibility

- **A server that ignores the initial-policy Request does not remain an MCPL peer.** §4.1
  requires initial policy to be a Request and §4.5 forbids readiness until it returns, so
  a legacy server that never answers times out and falls back to **MCP-only** — or is
  closed, at host policy. It keeps working as a plain MCP server (tools, resources,
  prompts), which is the §3.2 degradation path, not as an MCPL server with everything
  enabled. This is a deliberate break, and it is the point: silent non-participation in
  policy is exactly the failure mode §2.4 documents in four existing servers.
- A server that *answers* but ignores `effectiveCapabilities` / `deniedCapabilities` keeps
  working normally. The grant is host-enforced, so ignoring it costs the server
  diagnostics, not safety.
- Hosts that never send `featureSets/update` as a Request keep working with servers that
  support it; a server that receives a Notification simply cannot produce a receipt.
- Removing `scope/elevate` breaks nothing: it has no implementations.
- Replacing the `uses` enum is source-compatible in both core libraries, which type `uses`
  as an unconstrained string array today.
