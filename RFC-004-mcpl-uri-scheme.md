# MCPL RFC-004: The `mcpl://` URI Scheme

**Status:** Draft
**Targets:** MCPL Protocol Specification 0.5
**Authors:** Claude Code, from a scope proposed by Sol, with antra
**Date:** 2026-08-02
**Depends on:** nothing. This RFC defines a locator. It confers no authority and changes no
grant; RFC-002 / SPEC §5.4 remains the sole source of what a connected server may do.

**Prior art.** `connectome/docs/archipelago.md` §11 planned this as its "RFC-002 — URIs,
connection lifecycle & mobility". That series was drafted before 001–003 were spent on event
tags, capability grants, and manifest changes, so its numbering is stale — see §10. This RFC
takes the locator half of that plan and **defers the rest** (§9).

---

## 1. Summary

MCPL servers are reached today by a `url` field holding `ws://` or `wss://`, plus a
`transport` selector. That works, but it says *how to dial*, not *what is there*. A URI that
names an MCPL endpoint as such is worth having for three reasons that came up concretely:

- `mcpl_deploy(url: "mcpl://…")` becomes semantically clear — the agent is naming a protocol,
  not a socket.
- Endpoints become **pasteable**: `mcpl://eidoverse.animalabs.ai?world=abc` is a thing you can
  drop in a channel and someone can act on.
- Introspection can separate *what was configured* from *what was dialled*, which is currently
  conflated in a single mutable string.

This RFC defines **an endpoint URI and nothing else**: not discovery, not identity, not trust,
not mobility.

```text
mcpl://example.com/path?hint=value
        ↓ deterministic resolution
wss://example.com/path?hint=value
```

---

## 2. Scheme

```
mcpl-URI = "mcpl://" authority path-abempty [ "?" query ]
```

- **`mcpl://` is secure by default.** It resolves to `wss://`, default port **443**.
- There is **no `mcpls://`**. A second scheme differing only in security invites the mistake
  of reaching for the shorter one.
- **`mcpl://` never resolves to `ws://`.** Plaintext is reachable only by writing `ws://`
  explicitly, which is deliberately more effort than writing `mcpl://`.
- **`mcpl://localhost` is not special.** It resolves to `wss://localhost:443` like any other
  authority. Local development uses an explicit `ws://localhost:PORT`. A scheme that silently
  weakens for one hostname is a scheme whose security property cannot be stated in one
  sentence.

**Fragments MUST NOT appear.** A host **MUST** reject an `mcpl://` URI containing `#`. There
is no defined meaning for a fragment here, and silently ignoring one would discard something
the author believed was significant. Reserved for a future RFC.

**Userinfo (`user:pass@host`) MUST NOT appear.** A host **MUST** reject it. This is a syntax
decision, not a policy one: RFC 3986 §3.2.1 deprecates the production, and URI parsers and
loggers handle it inconsistently enough that its behaviour cannot be specified portably. It
is **not** a statement about credentials — see §4.

### 2.1 Compatibility

`ws://` and `wss://` remain fully accepted wherever a URL is accepted today. This RFC adds a
spelling; it deprecates nothing and breaks no existing configuration.

A host **MUST** accept all three forms. A host **SHOULD** preserve whichever the operator or
agent wrote (§5).

---

## 3. Resolution

Resolution is a **pure syntactic rewrite**. No lookup, no negotiation, no probing.

| Component | Rule |
|---|---|
| scheme | `mcpl` → `wss` |
| authority | preserved verbatim after canonicalization (§3.1) |
| port | absent ⇒ 443; present ⇒ preserved |
| path | preserved verbatim, including empty |
| query | **preserved verbatim, in the order written** |
| fragment | rejected (§2) |

The query is preserved *as written* — not sorted, not deduplicated, not reordered. Query
parameters are server-defined (`?world=abc` means something to the server and nothing to
MCPL), so canonicalizing them would change their meaning. This differs deliberately from the
manifest digest of SPEC §17.2, where ordering is normalized because the host is hashing the
value rather than transmitting it.

### 3.1 Canonicalization

Two URIs that differ only as below are **the same endpoint**, and a host comparing endpoints
(for deduplication, for a "you are already connected" check) **MUST** compare canonical forms:

1. **Scheme** lowercased.
2. **Host** lowercased, then IDNA-normalized to A-label form (RFC 5891). `mcpl://Eidoverse.Animalabs.AI` and `mcpl://eidoverse.animalabs.ai` are one endpoint.
3. **Default port elided.** `mcpl://h:443/x` canonicalizes to `mcpl://h/x`. A non-default port is retained.
4. **Empty path** normalized to `/`. `mcpl://h` and `mcpl://h/` are one endpoint.
5. **Percent-encoding** normalized per RFC 3986 §6.2.2: hex digits uppercased, and unreserved characters decoded.
6. **Query and fragment** are *not* canonicalized. (Fragments cannot appear at all.)

Path segments are **not** normalized beyond percent-encoding — `.` and `..` are left alone,
because a server is entitled to treat them as literal path components and collapsing them
would silently retarget the connection.

---

## 4. Credentials

**This RFC is deliberately unopinionated about credentials.**

It defines no credential parameter, forbids none, and makes no claim about what may appear in
a query string. That is not an oversight and not a compromise:

- `connectome/docs/archipelago.md` §3 already treats bearer tokens as *"invites and
  capabilities — short-lived, **shareable-as-URIs**, whose job is to bootstrap enrollment of
  a persistent key."* An invite token that resolves to a **new** principal is a thing you
  hand someone, and handing someone a URI is how. A prohibition here would contradict a
  design already written down.
- Credential *policy* belongs to the host and to whatever identity mechanism a future RFC
  defines. A locator that legislated it would be claiming authority it does not have — the
  same overreach this specification removed from feature sets and from `scope.label`.

What remains true regardless, and is stated in §7: **possessing or resolving an `mcpl://` URI
grants nothing.**

Hosts retain complete freedom to attach credentials out of band (agent-framework's
`accessProvider` does exactly this today, resolving per-dial so nothing above the transport
holds a credential), to redact whatever they choose when displaying or logging a URI, and to
refuse URIs they consider unsafe. None of that requires this RFC's permission, and this RFC
does not constrain it.

---

## 5. The canonical URI is retained

A host **MUST** retain the URI as written, and **MUST** record the resolved transport target
**separately**. It **MUST NOT** overwrite the configured value with the resolved one.

```jsonc
{
  "id": "eidoverse",
  "uri": "mcpl://eidoverse.animalabs.ai?world=abc",   // as configured — canonical
  "resolved": "wss://eidoverse.animalabs.ai:443/?world=abc"  // derived, informational
}
```

Collapsing these loses the operator's intent. A config that says `mcpl://` is asserting "this
is an MCPL endpoint, reached securely"; rewriting it to `wss://` silently converts that
assertion into an implementation detail, and the next reader cannot tell which was meant.

`mcpl_list` **SHOULD** surface the canonical URI and the resolved target as distinct fields —
alongside advertised capabilities, effective grant (§5.4), and negotiation freshness (§17),
which are also distinct facts that have been conflated.

---

## 6. Connection semantics

Resolution establishes a WebSocket. It does not establish that MCPL is present.

- The peer **MUST** complete MCP `initialize` and advertise `experimental.mcpl` (§5.1).
- If it does not, the host **MUST** either fail the connection or take the **explicit**
  MCP-only fallback of §3.2 — as a recorded decision, surfaced to the operator.
- A host **MUST NOT** infer MCPL support from successful resolution, from the scheme, or from
  the socket opening. `mcpl://` states an *intent* about what should be there; only the
  handshake establishes what is.

Guessing here would make the scheme load-bearing for a fact it cannot carry, which is the
failure mode §7 exists to prevent.

---

## 7. Security

**Possession of an `mcpl://` URI, and successful resolution of one, grant nothing.**

The URI is a locator. Every question of authority is answered after connection, by the
capability grant of §5.4. Specifically, connecting via `mcpl://`:

- does not grant any capability, and does not pre-authorize any;
- does not accept a producer tag ontology (§16.4) — acceptance stays explicit;
- does not register or authorize any channel (§14.1);
- does not establish wake policy;
- does not confer identity on either party.

**Redirects.** A redirect that changes the canonical origin (scheme-equivalent, host, or
port) **MUST NOT** be followed without a new authorization decision. Following one silently
would let the named endpoint hand the connection to an unnamed one, defeating the point of
writing the URI down.

**Egress policy applies.** Resolution is subject to whatever egress, SSRF, and
private-network policy the host enforces. This is worth stating rather than assuming: an
agent-facing deploy path currently validates its `id` (it becomes a tool name) while passing
`url` through with only a type check, and the scheme is not examined until dial time. Adding
a scheme does not add a guard, and a host **MUST NOT** treat `mcpl://` as evidence that a
destination is safe to reach.

---

## 8. Test vectors

Implementations **MUST** reproduce these. `→` is resolution; `≡` is canonical equality.

| # | Input | Result |
|---|---|---|
| 1 | `mcpl://example.com` | → `wss://example.com:443/` |
| 2 | `mcpl://example.com/path` | → `wss://example.com:443/path` |
| 3 | `mcpl://example.com:8443/x` | → `wss://example.com:8443/x` |
| 4 | `mcpl://eidoverse.animalabs.ai?world=abc` | → `wss://eidoverse.animalabs.ai:443/?world=abc` |
| 5 | `mcpl://h/p?b=2&a=1` | → `wss://h:443/p?b=2&a=1` (order preserved) |
| 6 | `mcpl://Example.COM/x` | ≡ `mcpl://example.com/x` |
| 7 | `mcpl://example.com:443/x` | ≡ `mcpl://example.com/x` |
| 8 | `mcpl://example.com` | ≡ `mcpl://example.com/` |
| 9 | `mcpl://h/%7Euser` | ≡ `mcpl://h/~user` (unreserved decoded) |
| 10 | `mcpl://h/a%2fb` | **≢** `mcpl://h/a/b` (reserved stays encoded) |
| 11 | `mcpl://h/a/../b` | **≢** `mcpl://h/b` (dot segments not collapsed) |
| 12 | `mcpl://localhost/x` | → `wss://localhost:443/x` (no local exception) |
| 13 | `mcpl://h/x#frag` | **reject** — fragment |
| 14 | `mcpl://u:p@h/x` | **reject** — userinfo |
| 15 | `mcpl://h/x?a=1&a=2` | → `wss://h:443/x?a=1&a=2` (duplicates preserved) |

Vector 5 and 15 exist because the obvious implementation — round-tripping through a URL
object that sorts or dedupes query parameters — fails them silently.

---

## 9. Out of scope

Deferred from `archipelago.md`'s original combined plan, so they are parked rather than lost:

- **Mobility** — `server/moved` with host write-back, and stable service hostnames.
- **Structured refusal** — `server_full`, `retryAfter`, queued admission and `ready`.
- **Discovery** — `.well-known`, SRV records, resolving one name across several transports.
- **Multiple transports** — anything other than the direct WSS mapping.
- **Signatures, attestation, capability hints in the URI.**
- **Identity** — principals, enrollment, succession.

Each turns a locator into service discovery or identity. If `mcpl://animalabs.ai/discord`
should one day discover among transports, that is a separate discovery RFC layered on top;
this direct mapping stays valid underneath it and does not need to change.

---

## 10. Renumbering note

`connectome/docs/archipelago.md` §11 lists a planned series — RFC-002 URIs, RFC-003
Documents, RFC-004 Capacity & flow control, RFC-005 Principals, RFC-006 Identity services —
written before 001–003 were spent elsewhere. Every number in that list is now taken or
shifted. The list should be renumbered against actual state; this RFC does not edit that note
unilaterally, since it is someone else's design document.

---

## 11. Backward compatibility

- Purely additive. No existing configuration changes meaning, and `ws://`/`wss://` keep
  working exactly as they do.
- A host that does not implement this RFC simply rejects `mcpl://` as an unknown scheme, which
  is the existing behaviour (`transport.ts` already errors on any scheme that is not
  `ws:`/`wss:`).
- No change to the grant, to feature sets, to channels, or to the manifest.
