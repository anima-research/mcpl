# MCPL AUDIT-001: Specification vs. Implementations

**Status:** Findings
**Spec audited:** SPEC.md v0.4.1-draft (+ uncommitted `channels/outgoing/*` diff), RFC-001-event-tags.md
**Date:** 2026-08-02
**Author:** Claude Code, at antra's request, in #architecture with Sol

---

## 1. Scope and method

Every local MCPL tree was read against the spec's wire-method inventory. Findings carry
`file:line` anchors in the per-tree source audits; this document is the rollup.

**Trees audited (15):**

| Role | Trees |
|---|---|
| Host | `agent-framework/src/mcpl`, `mcpl-harness` (dev harness, not production) |
| Libraries | `mcpl-core` (Rust 0.1.0), `mcpl-core-ts` (`@animalabs/mcpl-core` 0.2.2) |
| Servers | `discord-mcpl`, `portal-stack/portal-mcpl`, `eidoverse-worlds/mcpl`, `tavern-mcpl`, `heartbeat-mcpl`, `x-mcpl`, `xgate/mcpl`, `zulip_mcp/src/mcpl`, `mcpl-editor`, `dog_mcp` |
| Excluded | `robot-sim-mcpl` — not a git repo, no references anywhere in the workspace, no host wiring. Despite the name it is a `tools/call` latency harness for "present while acting", not a robotics integration. Contributes no `YES` to any row, so excluding it changes no count. |

**Weighting note:** antra confirmed all trees are real, with `tavern-mcpl` "a bit forlorn"
(3 commits, self-described disposable reference). Tavern is treated as corroborating
evidence only, never as sole evidence that a surface is used.

**Columns** (agreed in #architecture, merging Sol's five with the cut-dead-surface goal):
advertised by whom · authorized by whom · visible to peer how · enforced where ·
default before policy · implemented-in count · deviation vs spec.

---

## 2. Headline findings

### 2.1 §6.6 enforcement has zero live implementations on either side

The spec's model for telling a server it overstepped is a JSON-RPC error `-32001`
carrying `data: { featureSet, canEnable }` (§6.6).

- **Host side:** rejects a disabled-feature-set `push/event` with a JSON-RPC *result*
  `{ accepted: false, reason }` — not an error object. The `featureSetNotEnabled` and
  `unknownFeatureSet` factories exist in `errors.ts` and are **never invoked anywhere**.
  All three §14.6 channel codes (`-32017`, `-32023`, `-32024`) are likewise defined,
  exported, and never thrown.
- **Server side:** `discord-mcpl` and `portal-mcpl` both send `push/event`
  fire-and-forget (`.catch(() => {})`); the response is never read.

Only `inference/request` produces the correct error-code contract — and no server
implements `inference/request` at all.

**Consequence for the RFC:** §6.6 is not a fallback that an up-front negotiation
handshake supplements. There is nothing there to supplement.

### 2.2 The `beforeInference` / `afterInference` enforcement asymmetry

`fanOutBeforeInference` validates the returned `featureSet` via
`featureSetManager.validateInbound` before accepting injections, per §6.5.
`fanOutAfterInference` does **not**.

A server whose feature set is disabled can still have its `modifiedResponse` applied to
the user-visible reply. This is the single most privileged surface in MCPL — the only
place a server rewrites model output — and it is the one hook path with no feature-set
check.

### 2.3 Channels are ungated end to end

`ChannelRegistry` (2115 lines) stores a `featureSetManager` reference and never calls a
single method on it. `channels/register`, `channels/publish`, `channels/incoming` — no
authorization checks anywhere. The `channels.publish` / `channels.observe` feature sets
from §14.1's own example are decorative.

Note the spec is complicit: neither `channels/register` nor `channels/publish` carries a
`featureSet` field on the wire, so there is nothing to validate against. **The channel
gating model is underspecified in SPEC.md itself**, not merely unimplemented.

### 2.4 The `channels.streaming` deadlock

- SPEC §14.1 defines `channels` as an object with `register`/`publish`/`observe`/
  `lifecycle`/`streaming`.
- **Both** core libraries flatten it to a bare `boolean`. No server can declare
  `channels.streaming`.
- The host **correctly** gates `channels/outgoing/chunk` on
  `server.capabilities?.channels?.streaming`.

Result: the streaming surface is unreachable by construction.

**This is load-bearing.** `discord-mcpl` handles `channels/outgoing/complete` by calling
`discord.sendMessage(...)` — treating the stream terminator as authoritative delivery,
in direct violation of the uncommitted diff's "advisory only / MUST NOT treat a chunk
stream as delivered content". The correct `handlePublish` path sits beside it. If both
fire for one turn, the reply posts to Discord **twice**.

The bug is dormant *only* because of the deadlock above. **Landing the uncommitted diff
without first fixing discord-mcpl activates a double-post in production.**

### 2.5 Capability advertisement is unreliable without malice

- `x-mcpl` and `xgate` declare `pushEvents: true` and never send one.
- `discord-mcpl` / `portal-mcpl` declare `discord.messaging` / `portal.messaging` with
  `uses: ['tools','channels.publish']` while tagging every `push/event` with that
  feature set — `pushEvents` is absent from `uses`.
- `dog_mcp` declares `uses: ["tools"]` while actively using `pushEvents`,
  `context/beforeInference` **and** `context/afterInference`.
- The host under-advertises itself: omits `inferenceRequest` and `channels` though both
  are fully implemented.

Nothing catches any of this: neither core library types `uses` as a closed enum, despite
App. B.2 declaring one.

**Consequence for the RFC:** a denied capability auto-disabling every feature set whose
`uses` requires it is only as good as `uses`. Today `uses` is wrong in at least three
production servers. The derivation must either enforce `uses` or fail closed on
missing/unknown entries.

### 2.6 Policy delivery already fails silently

- `heartbeat`, `tavern`, `dog_mcp`, `eidoverse` dispatch only request-type messages and
  discard notifications before method lookup. `featureSets/update` never arrives.
- `portal-mcpl` receives it and explicitly no-ops, discarding `enabled`/`disabled`/
  `scopes`. Its `isEnabled()` helper has **zero call sites**.
- `discord-mcpl` honours `enabled`/`disabled` but ignores `scopes` entirely.
- The host only sends `featureSets/update` **if** `enabled` or `disabled` is non-empty —
  so a server defaulted to fully-disabled is never told.
- The host never puts `scopes` on the wire at all; `config.scopes` configures
  `ScopeManager` locally only. Layer 3 is host-local by construction.

**Consequence for the RFC:** promoting `featureSets/update` to a Request is supported by
evidence, not just theory. Today the failure is invisible to both parties; a Request
makes a missing response diagnosable.

### 2.7 Default before policy: fail-open everywhere

`discord-mcpl` enables *every* declared feature set immediately after handshake, before
any policy arrives. `portal-mcpl` has no enforcement path at all, so pre- and post-policy
are behaviourally identical. `eidoverse` / `tavern` declare no feature sets, so the
permissive state is permanent rather than transient.

Host-side there is no exploitable race — `registerMcplServerFeatures` populates
`FeatureSetManager` before the data-plane gate opens, and `push/event` is buffered until
then. The gap is entirely on the server side, and it is a direct consequence of §5.3
being a `SHOULD` with no ordering guarantee against first fan-out.

### 2.8 PR #75's mask walks exactly two levels

```js
const UNMASKABLE_KEYS = new Set(['version', 'featureSets']);
const NESTED_KEYS     = new Set(['contextHooks', 'channels']);
```

Top-level keys, plus one flag level beneath **only** `contextHooks` and `channels`.

- `inferenceRequest.streaming` is **unmaskable** — the pattern never matches, because
  the object is never decomposed.
- `contextHooks.afterInference` becomes an atomic leaf once it passes the flag check, so
  `contextHooks.afterInference.blocking` is not addressable.

The proposed capability tree (`contextHooks.beforeInference.inject.system`) is depth 3
and needs a generic recursive flatten/mask, not a hardcoded allowlist. PR #75 is **open,
unmerged**; none of it currently gates anything.

---

## 3. The matrix

Counts are over the **10 counted servers** (robot-sim excluded; tavern counted but
weighted). "Host" is `agent-framework`.

| Wire method | Servers | Host | Enforced where | Default pre-policy | Deviation |
|---|---|---|---|---|---|
| `push/event` | **6** | impl | feature set ✓ | buffered until ready | rejects via *result*, not `-32001` |
| `featureSets/changed` | **0** | impl | n/a | n/a | — |
| `scope/elevate` | **0** | impl | **ungated** (no `validateInbound`) | unchanged | missing gate vs push/inference |
| `inference/request` | **0** | impl | feature set ✓ | buffered | streaming `usage` hardcoded to 0 |
| `model/info` | **0** | **never replies** | n/a | n/a | no `METHOD_TO_EVENT` entry → **caller hangs** |
| `channels/register` | **6** | impl | **ungated** | open | — |
| `channels/changed` | **2** | impl | **ungated** | open | — |
| `channels/incoming` | **8** | impl | ungated (no `featureSet` on wire) | open | x-mcpl/xgate send as *notification*, spec says Request |
| `channels/list` | 3 stubs | **dead both ways** | n/a | n/a | inbound request **hangs**; sender never called |
| `featureSets/update` | **5** (2 ack-only) | impl | n/a | — | `scopes` never sent; only sent if enabled/disabled non-empty |
| `context/beforeInference` | **2** | impl | feature set ✓ on response | fail-open on timeout | §14.4 `channels` field on wrong method in both libs |
| `context/afterInference` | **1** | impl | **not validated** | fail-open | enforcement asymmetry vs beforeInference |
| `state/rollback` | **2** real, 2 stubs | **dead code** | n/a | n/a | sender + `rollbackTo` have zero call sites |
| `channels/open` | **7** | impl | ungated | open | `history`/`historyTruncated` not in §14.3 |
| `channels/close` | **7** | impl | ungated | open | — |
| `channels/publish` | **6** | impl | **ungated** | open | eidoverse + tavern drop the Notification form |
| `channels/outgoing/chunk` | **2** partial | impl, gated ✓ | capability ✓ | n/a | undeclarable capability ⇒ unreachable |
| `channels/outgoing/complete` | **1**, misused | impl, gated ✓ | capability ✓ | n/a | discord treats as authoritative send |

---

## 4. Shortlists

### 4.1 Zero-implementation surfaces — four kinds of zero

*Revised after review in #architecture (imago, antra). The original framing treated
"implemented-in = 0" as a cut signal. That is wrong: absence of use is not absence of
need, and one of the zeros turned out to be a measurement artifact. The useful question
is not "is it used" but "why not".*

**Kind 1 — zero because unbuilt.** The demand depends on work not yet done.

| Surface | What it does | Why zero | Verdict |
|---|---|---|---|
| `scope/elevate` (§7.4) | Server asks the host to approve a specific action inside an already-enabled feature set; host answers against whitelist/blacklist | Every MCPL in the fleet is trusted and the ACLs don't exist yet (antra). No feature set anywhere declares `scoped: true` — layer 3 is unbuilt end to end. | **Keep.** Cutting is circular — removing the mechanism because we haven't built the thing that needs it. The capability RFC is what creates the demand. |

**Kind 2 — zero because the fleet is monocultural.** Every server here is a chat
connector; the capability serves a server shape we don't currently have.

| Surface | What it does | Why zero | Verdict |
|---|---|---|---|
| `inference/request` (§11) | Server obtains inference from the host without human-in-the-loop approval | No chat connector wants inference | **Keep** (antra). Cheap to implement, already correct host-side, and the only path that produces the §6.6 error contract properly. |
| `model/info` (§12) | Server discovers the model it is talking to | See kind 3 — the zero is not trustworthy | **Keep** (antra). Gains a concrete purpose once hosts expose non-text models: `model/info` is how a server discovers an imagegen or audio model it could use. |

**Kind 3 — zero because broken.** The measurement is invalid.

| Surface | Why the zero is unfalsifiable |
|---|---|
| `model/info` | The host has no `METHOD_TO_EVENT` entry and sends **no response at all** — not an error, not a result. Any server that tried would have hung and quietly dropped the call. Demand for a method that never answers cannot be observed. |
| `channels/list` (inbound) | Same failure mode: an inbound request with an `id` receives no response. The outbound sender exists and is never called. |

**Kind 4 — zero because superseded.** The zero reflects a real design answer.

| Surface | What it does | Why zero | Verdict |
|---|---|---|---|
| `featureSets/changed` (§6.7) | Server announces added/removed feature sets mid-session | Servers do change their declared sets — by reconnecting and re-declaring | **Fold into reconnect semantics**, not delete. The only genuine candidate, and even it is a merge rather than a cut. |

**Not zero, but still unsound:**

| Surface | Verdict |
|---|---|
| `channels/changed` | **Keep.** Only 2 implementations, but both are the highest-traffic servers. |
| `state/rollback` | **Open question** (antra). 2 real server implementations, but the host can never trigger it — `sendStateRollback` and `rollbackTo` both have zero call sites. Meanwhile `state/update` + `branches/*` ship in production (see 4.3). §8 as written is not what anyone built. |

### 4.2 Real deviations to fix

1. **discord-mcpl treats `outgoing/complete` as delivery** — double-post. *Fix before
   the uncommitted diff lands.*
2. **Both libraries flatten `channels` to `boolean`** — blocks §14.1 and the streaming
   opt-in.
3. **§14.4 `channels` context field attached to `afterInference`** in both libraries;
   spec puts it on `beforeInference`. Identical in Rust and TS — copied, not derived.
4. **`afterInference` responses not validated** against the feature-set manager.
5. **`model/info` and `channels/list` hang** rather than erroring — no response is ever
   sent for an inbound request with an `id`.
6. **`scopes` never reaches the wire** — host-local only.
7. **x-mcpl / xgate send `channels/incoming` as a notification**, losing the per-message
   `results` contract of §14.3.
8. **`uses` inaccurate** in discord, portal, dog_mcp; unenforced by both libraries.
9. **eidoverse returns `-32004`** for unknown channel instead of `-32023`.
10. **Host under-advertises** `inferenceRequest` and `channels`.

### 4.3 Extensions implementations invented that the spec never gave them

These say more about what the spec is *missing* than the dead list says about what it
should lose.

| Extension | Where | Reading |
|---|---|---|
| `channels/acknowledge` | discord, portal, zulip, host, mcpl-core-ts | Read-receipt / "seen, not opening". Four independent adopters — **the strongest promotion candidate. Agreed for promotion (antra).** |
| `channels/typing` | discord, zulip, host | Liveness signalling. Widely wanted, unspecified. **Agreed for promotion (antra).** |
| `state/update`, `state/get`, `branches/*` | mcpl-editor (live Railway deploy), mcpl-core-ts (`feature/mcpl-v05-state-branches`), mcpl-harness | **v0.5 state/branches is already in production ahead of the spec.** mcpl-editor advertises `version: "0.5"`. Whoever owns this must be in the RFC conversation before §8 is settled. |
| `ChannelDescriptor.initiallyOpen`, `.capabilities`; `channels/open` history | eidoverse, discord, portal, host, mcpl-core-ts | Backscroll-on-open. Universal among channel servers. |
| `hostState` on feature sets | mcpl-core-ts + 5 servers | Set to `false` almost everywhere; likely vestigial — v0.4.1 removed `hostState` from the spec but not from the libraries. |
| `host/command` | discord | Admin slash-commands server→host. Genuinely out of scope for MCPL. |
| `tags` + `tagOntology` (RFC-001) | discord, portal, zulip, host, mcpl-core-ts | See §5. |

---

## 5. RFC-001 status

Further along than the RFC's own implementation plan describes.

**Done:** `tags` on `push/event` and `channels/incoming` (mcpl-core-ts, discord, portal,
zulip, host); `tagOntology` declared by discord (`open: true`) and portal (`open: false`);
`tagsAny`/`tagsAll`/`tagsNone` matching with globs, first-match-wins, in `EventGate`;
agent-facing tag introspection tool.

**Absent:**
- **`implies` closure expansion (§6.1)** — the field round-trips through types and is
  never read. A rule on `chat:broadcast` will not match an event tagged only
  `discord:everyone`. This silently breaks the RFC's core ergonomic promise.
- **`defaultTreatment` precedence chain (§6)** — declared, never consumed. Only consumer
  rules are evaluated; the producer-fills-gaps half does not exist.
- **`tags/describe`** — nowhere. (Explicitly optional in the RFC.)
- **Rust `mcpl-core` has none of RFC-001.** No Rust peer can emit or read tags. Known
  TODO per RFC §9.2.

**Corrections to RFC-001:**
- **§9.2 has the dependency arrangement inverted.** portal-mcpl is *symlinked* to live
  `mcpl-core-ts` 0.2.2; **discord-mcpl** is the copied, stale one at 0.2.1.
- **`chat:reaction-remove` is never emitted.** discord tags both add and remove as
  `chat:reaction`; the distinction survives only in `origin.action`.

**Motivation confirmed, hard.** `eidoverse` independently reinvented event
classification outside the spec — flat, un-namespaced `"mention"` / `"whisper"` /
`"activity"` tags plus `metadata: { mentioned, isExplicitMention }`, with a source
comment stating it emits "BOTH ecosystem dialects... Ask us how we know." It declares no
`tagOntology` despite the library supporting one. That is RFC-001 §2's anti-pattern,
arrived at independently, in the newest channel server.

---

## 6. Spec bugs found while auditing

1. **§6.4 contradicts §5.3 / §6.7.** §6.4 still says feature-set selection happens during
   initialization and the host returns it in the initialize response — a 0.2.0 leftover
   the 0.3.0 changelog says was moved to post-initialize `featureSets/update`. Delete.
2. **`uses` enum is behind §14.** App. B.2 lists 7 values; missing `channels.register`,
   `channels.lifecycle`, `channels.streaming`, `modelInfo`, and any state/rollback value.
3. **§5.3 has no ordering guarantee.** "After initialization, hosts SHOULD send
   `featureSets/update`" — nothing requires it to precede the first hook fan-out or the
   first accepted inbound request. "Default before policy" is undefined, not chosen.
4. **§13.4 points its only control at the untrusted party** — *"Servers MUST NOT inject
   content that attempts to override system instructions"* — while §13.1's own risk table
   lists `contextHooks.beforeInference` as "Read context, inject content" with mitigation
   "Review descriptions."
5. **Channel authorization is unspecified.** No `channels/*` method carries a `featureSet`,
   so §14.1's `channels.publish` / `channels.observe` feature sets have nothing to bind to.

---

## 7. Recommended sequence

1. **Fix `discord-mcpl`'s `outgoing/complete`** — before the uncommitted streaming diff
   lands, or it activates a production double-post.
2. **Land the §6.4 deletion** — free, independent of every design decision.
3. **Fix `channels` capability shape in both libraries** — unblocks the streaming diff
   and §14.1.
4. **Make `model/info` and inbound `channels/list` answer** — even with an error. A method
   that silently never responds cannot be evaluated, and both currently poison their own
   usage evidence (§4.1 kind 3).
5. **Promote `channels/acknowledge` and `channels/typing`** into the spec (agreed).
6. **Bring the v0.5 `state`/`branches` authors into the RFC** before §8 is rewritten;
   `state/rollback` remains an open question.
7. **Then** the capability-tree / negotiation RFC, which now has empirical grounding for
   every one of its claims.

---

## 8. Decisions taken in #architecture

| Item | Decision | By |
|---|---|---|
| `inference/request` | Keep — cheap, imaginable, extensible | antra |
| `model/info` | Keep — imagegen and other non-text models can be exposed through it | antra |
| `scope/elevate` | Zero use explained by all-MCPLs-trusted + ACLs undeveloped; not evidence against | antra |
| `channels/acknowledge`, `channels/typing` | Promote into spec | antra |
| `state/rollback` | Open question | antra |
| "Dead surface" framing | Rejected as a cut signal; replaced by the four-kinds-of-zero analysis in §4.1 | imago |
