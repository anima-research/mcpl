# MCPL RFC-003: Server Manifest Changes

**Status:** Draft
**Targets:** MCPL Protocol Specification ≥ 0.6
**Authors:** Sol and Claude Code, with antra
**Date:** 2026-08-02
**Depends on:** RFC-002 / SPEC §5.4, §6.7 — every consequence here routes through the existing grant and receipt machinery.

---

## 1. Summary

A server's initialized manifest — its capabilities, feature sets, and tag ontology — became
**consequential** in 0.5.0. Capabilities determine the grant, `uses` determines degradation,
and ontology acceptance is bound to a snapshot. Nothing in the protocol lets a server say
that any of it changed.

This RFC adds two methods:

- **`mcpl/manifestChanged`** (Server → Host, Notification) — an opaque revision plus the set
  of changed domains. A hint, nothing more.
- **`mcpl/manifest`** (Host → Server, Request) — fetch the canonical current manifest.

The host validates and **diffs** the fetched manifest, applies SPEC §6.7's existing
consequences, and emits **one** normalized change receipt to the resident or operator using
a closed, host-derived impact vocabulary.

---

## 2. Motivation

### 2.1 Reconnect-only discovery is now insufficient

Before 0.5.0, a stale manifest was cosmetic. After it, a stale manifest means the host is
enforcing a grant computed against capabilities the server no longer has, deriving feature
degradation from `uses` that no longer describes the server, and honouring an ontology
acceptance for tags that may no longer be emitted.

SPEC §6.7 currently states that `featureSets/changed` was removed and "folded into reconnect
semantics." That rationale was reasonable when nothing consumed a manifest; it is wrong now.
See §9.

### 2.2 The 0.5.0 rollout is the first user

Twelve issues filed against the fleet change agent-facing surface across **exactly** the
three domains this RFC names:

| Domain | Changes in flight |
|---|---|
| `capabilities` | `channels` boolean → object in both core libraries; capability paths replacing the `uses` enum |
| `featureSets` | `uses` corrections in dog_mcp, discord-mcpl, portal-mcpl, heartbeat-mcpl, xgate; *new* feature sets for eidoverse and tavern, which declare none today |
| `tagOntology` | eidoverse's migration off un-namespaced tags; discord-mcpl's `chat:reaction-remove` |

The domain enum is therefore validated against a real work queue rather than chosen by
taste. If this RFC lands after that rollout, the largest surface-change wave the fleet has
had is the one nobody is told about.

### 2.3 There is no re-fetch path today

Verified in `agent-framework`: a manifest appears only in `initialize`, and nothing re-reads
capabilities afterwards. `mcpl/manifestChanged` without `mcpl/manifest` would be a
notification the host cannot act on.

---

## 3. Manifest and revision

The **manifest** is the `experimental.mcpl` capability block a server presents at
`initialize`: `capabilities`, `featureSets` (with `uses` and any `tagOntology`).

A server that supports this RFC includes an opaque `revision: string` in that block.

- The revision is **server-authored and untrusted**. It MUST change whenever any domain
  changes; a host MUST NOT treat an unchanged revision as proof that nothing changed.
- Hosts MUST NOT parse or order revisions. Equality is the only defined operation.
- The host's **diff of the fetched manifest is authoritative** for every decision. The
  revision exists to make the common case cheap, not to be believed.

## 4. `mcpl/manifestChanged` (Server → Host, Notification)

```jsonc
{
  "jsonrpc": "2.0",
  "method": "mcpl/manifestChanged",
  "params": {
    "revision": "r7",
    "domains": ["capabilities", "featureSets"]
  }
}
```

`domains` is a subset of `capabilities | featureSets | tagOntology`. It carries **no
payload** — no diff, no list of what was added or removed, no policy conclusion. Everything
a server might assert about the change is something the host would have to re-derive anyway,
and asserting it invites the self-attestation defect this protocol has now removed twice
(SPEC §5.4, §7).

A host MAY ignore the notification entirely. A host that acts on it MUST fetch (§5) before
changing anything.

**No capability path gates this.** That is deliberate and is an exception worth stating:
announcing conveys no authority, and gating it would perversely silence exactly the servers
whose grants had just been narrowed. The cost of the announcement is the host's re-fetch,
which §7 bounds.

## 5. `mcpl/manifest` (Host → Server, Request)

```jsonc
{ "jsonrpc": "2.0", "id": 21, "method": "mcpl/manifest", "params": {} }
```

Returns the server's **current, complete** manifest in the same shape it would present at
`initialize`:

```jsonc
{
  "jsonrpc": "2.0", "id": 21,
  "result": {
    "revision": "r7",
    "capabilities": { "…": "…" },
    "featureSets": { "…": "…" }
  }
}
```

- Complete, never a delta. Deltas would require the host to trust the server's account of
  its own previous state.
- A server that does not implement it MUST return an error, not silence (SPEC §6.6).
- Hosts MAY call it at any time, not only after a notification — for example on a schedule,
  or before a security-sensitive operation.

## 6. Host processing

On a fetched manifest the host MUST:

1. **Validate** it exactly as at `initialize`, including `uses` (SPEC §6.4). Invalid
   declarations fail closed with `invalid_uses`; a malformed manifest is rejected and the
   previous manifest stands.
2. **Diff** it against the manifest currently in force.
3. **Apply SPEC §6.7 consequences**, unchanged — this RFC adds no new policy machinery:
   - **Removals and narrowing** revoke **host-first**, then the Request and receipt.
   - **Additions never auto-grant.** A newly advertised capability is an input to the host's
     grant computation, nothing more. If policy widens the grant, that follows
     tell → receipt → activate.
   - **Changed or now-invalid `uses`** revalidates fail-closed.
   - **A changed `tagOntology` invalidates prior acceptance** (SPEC §16.5) rather than
     inheriting standing. Accepted suggestions and `implies` edges do not carry over a
     revision they were not accepted against.
4. **Emit one receipt** (§7). One per manifest change, not one per affected item.

In-flight requests need no new rule: SPEC §5.4 already authorizes response contributions
against the grant **current at response-receipt**, so a hook dispatched before a narrowing
returns into the narrowed grant.

## 7. The change receipt

The host emits a single normalized, privacy-minimal receipt to the resident or operator.
Impacts use a **closed, host-derived vocabulary** — never a server-authored flag such as
`requiresReview`:

| Impact | Meaning |
|---|---|
| `capability-revoked` | A capability in force is no longer granted |
| `capability-expansion-pending` | Newly advertised; awaiting a policy decision |
| `feature-degraded` | A feature set was disabled by derivation |
| `feature-restored` | A previously degraded feature set is available again |
| `ontology-acceptance-invalidated` | Accepted tag ontology no longer applies (§16.5) |
| `wake-rule-reference-unresolved` | A consumer gate rule references a tag the server no longer declares |
| `surface-changed` | Tools, resources, prompts or channels changed (§8) |

Each impact carries a disposition: `applied` | `decision-needed` | `informational`.

Whether a receipt **wakes** the resident is ordinary RFC-001 policy (SPEC §16) evaluated
against tags the host attaches — not a property of the change and not the server's to
decide.

`wake-rule-reference-unresolved` deserves emphasis: a resident's gate rules can silently
stop matching when a producer drops a tag. Today that failure is invisible.

## 8. Relationship to existing change notifications

MCP's `notifications/tools/list_changed` (and the resources/prompts equivalents) and MCPL's
`channels/changed` **remain unchanged**. They are specialized, they carry no manifest
authority, and they already work.

The host SHOULD coalesce them into the same resident-facing changelog surface, so a resident
sees one account of "what changed about this server" rather than four unrelated ones.

> Two notes from the audit. The host already implements collapse logic for
> `tools/list_changed`, which is the coalescing pattern §7's "one receipt" needs — this is
> not new machinery. And **no server in the fleet emits any `list_changed` at all**, so the
> producer side is greenfield everywhere; that is a reason to specify carefully now, not a
> reason to assume disinterest.

## 9. Amendment to SPEC 0.5.0

SPEC §6.7 states that `featureSets/changed` is removed and "folded into reconnect
semantics", and the 0.5.0 changelog repeats it. **The removal stands; the rationale does
not.**

`featureSets/changed` should stay removed — it carried a server-authored payload of what
changed, which is the defect §4 avoids. But "reconnect is sufficient" is falsified by §2.1.
§6.7 and the changelog should be amended to say the method is **superseded by this RFC's
manifest mechanism**, not that the need was illusory.

This is a correction of reasoning I got wrong: the method had zero implementations because
it did nothing consequential, which is AUDIT-001 §4.1's "zero because unbuilt" category —
written in that same audit, and then walked into.

## 10. What this is not

**This is cooperative-only. It is not a security mechanism.**

A server that changes silently and never announces is undetectable between fetches. RFC-003
buys *freshness* from well-behaved servers. What protects against the others is the grant
(SPEC §5.4), which is enforced continuously and does not depend on any announcement.

Stated plainly so that a stale revision is never later mistaken for a safety property. This
is the same posture as feature sets: ergonomics, not a boundary.

Hosts that want assurance rather than freshness should re-fetch on their own schedule (§5),
which needs no cooperation at all.

## 11. Rate limiting

`mcpl/manifestChanged` is cheap to send and causes a fetch. Unbounded, that is an
amplification vector.

**The limiter is the host's.** A server SHOULD coalesce rapid changes into one notification,
but a host MUST NOT depend on it. Hosts MUST bound the fetch rate per connection, and MAY
coalesce multiple notifications into a single fetch. Exceeding the host's limit is a
**conformance defect**, not a negotiation: the host drops the excess and SHOULD surface the
defect, rather than fetching or renegotiating anything.

## 12. Out of scope

- **Mid-run capability elevation.** A server *asking* for a capability it lacks is a
  different mechanism with a coercion profile of its own. `manifestChanged` announces what a
  server *is*, not what it *wants*.
- **State and branches.** Still open; tracked at mcpl-editor#4. Note SPEC §6.2 has no
  capability path for state or branches, so they sit outside the two-layer model regardless.
- **Signed or attested manifests.** Would move this from freshness to assurance, and needs
  an identity story MCPL does not have.

## 13. Backward compatibility

- Both methods are optional. A server that implements neither behaves exactly as today:
  its manifest is fixed at `initialize`.
- A server MAY implement `mcpl/manifest` without `mcpl/manifestChanged`, which lets a host
  poll. The reverse is useless and hosts SHOULD warn on it.
- `revision` is an added field; hosts that ignore it lose only the cheap-path optimization.
- No change to the grant, the receipt, or any §6.7 ordering rule. This RFC is a **trigger**
  for existing machinery, which is the reason it can be this small.
