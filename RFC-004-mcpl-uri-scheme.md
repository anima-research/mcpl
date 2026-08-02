# MCPL RFC-004: The `mcpl://` URI Scheme

**Status:** Draft rev 2 — Sol's two blockers addressed
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
- **`mcpl://localhost` is not special.** It resolves to `wss://localhost/` like any other
  authority (port 443 implied and elided, §8 vector 9). Local development uses an explicit
  `ws://localhost:PORT`. A scheme that silently
  weakens for one hostname is a scheme whose security property cannot be stated in one
  sentence.

### 2.1 Rejected forms

A host **MUST** reject each of the following, before any parsing or substitution (§3). Each
is a string-level check on the input, and each exists because the alternative is a silent
change of meaning rather than an error.

| Form | Example | Why rejected |
|---|---|---|
| Fragment | `mcpl://h/x#frag` | No defined meaning. Ignoring one discards something the author believed significant. Reserved for a future RFC. |
| Userinfo | `mcpl://u:p@h/x` | RFC 3986 §3.2.1 deprecates the production; parsers and loggers handle it inconsistently enough that behaviour cannot be specified portably. A **syntax** rule, not a credential one — see §4. |
| Empty authority | `mcpl:///x` | **Silently retargets.** See below. |
| Dot segments | `mcpl://h/a/../b`, `mcpl://h/a/%2e%2e/b` | Cannot survive resolution intact; preserving them is unimplementable and unenforceable. See §3.2. |

**Empty authority is the dangerous one.** `mcpl:///evil` looks like a path-only URI, but
under §3 the scheme is substituted and the result is parsed as `wss:///evil` — and a WHATWG
URL parser reinterprets the first path segment as the **host**, yielding `wss://evil/`. A URI
that names no host would dial one. Reject at the string level, before substitution; the
parser will not raise it for you.

### 2.2 Compatibility

`ws://` and `wss://` remain fully accepted wherever a URL is accepted today. This RFC adds a
spelling; it deprecates nothing and breaks no existing configuration.

A host **MUST** accept all three forms. A host **SHOULD** preserve whichever the operator or
agent wrote (§5).

---

## 3. Resolution and canonicalization

Resolution is a **pure syntactic rewrite**. No lookup, no negotiation, no probing.

```
1. Reject the forms in §2.1 — string-level checks on the input, before anything else.
2. Substitute the scheme: mcpl: → wss:
3. Parse the result with a WHATWG-URL-conformant parser.
   That parsed value IS the resolved transport target.
4. The canonical mcpl:// form is that same value with the scheme mapped back to mcpl:.
```

**Resolve first, then canonicalize.** This ordering is the whole design, and it is not
arbitrary — see §3.1.

Step 3 delivers, for free and identically in every conformant implementation: host
lowercasing, IDNA/punycode conversion, elision of the default port 443, empty-path
normalization to `/`, IPv6 literal lowercasing, and dot-segment removal (which cannot occur,
having been rejected in step 1).

The **query is preserved verbatim** — order kept, duplicates kept, nothing sorted. Query
parameters are server-defined (`?world=abc` means something to the server and nothing to
MCPL), so normalizing them would change their meaning. This is deliberately unlike the
manifest digest of SPEC §17.2, which normalizes because it *hashes* the value rather than
transmitting it. A WHATWG parser preserves query order and duplicates, so this needs no
special handling — but an implementation that round-trips through `URLSearchParams` and
re-serializes will break it.

### 3.1 Why not canonicalize the `mcpl://` form directly

**`mcpl:` is a non-special scheme.** WHATWG URL applies host and path normalization only to
its special schemes (`http`, `https`, `ws`, `wss`, `ftp`, `file`). Parsing an `mcpl://` URI
directly therefore performs **almost none** of the normalization this section requires:

| Input | Parsed as `mcpl:` (non-special) | Parsed as `wss:` (special) |
|---|---|---|
| `…//EIDOVERSE.Animalabs.AI:443/x` | host `EIDOVERSE.Animalabs.AI:443` — case kept, port kept | host `eidoverse.animalabs.ai` — lowercased, port elided |
| `…//ünicode.example/x` | `%C3%BCnicode.example` — percent-encoded UTF-8 | `xn--nicode-2ya.example` — IDNA A-label |
| `…///x` | host `""` — accepted | host `x` — first path segment promoted |

The middle row is the one that forces the design: the same input yields **two different
hosts** depending on which form an implementation normalizes. Not a formatting difference —
a different endpoint. An implementation that canonicalizes `mcpl://` directly and one that
resolves first would disagree about identity, deduplication, and what "already connected"
means.

So: **a host MUST NOT rely on a URL library's normalization of the `mcpl://` form.** Canonical
identity is defined by the resolved `wss:` value, which every conformant parser computes the
same way.

### 3.2 Dot segments are rejected, not preserved

An earlier draft required `.` and `..` path segments to be preserved literally, on the ground
that a server may treat them as real path components and collapsing them silently retargets
the connection. The concern is right; the remedy was unimplementable.

WHATWG URL removes dot segments even for non-special schemes: `mcpl://h/a/../b` parses to
`mcpl://h/b`, and `%2e%2e` collapses identically. Preservation would require every
implementation to hand-roll a parser, and would still not hold — HTTP and WebSocket
infrastructure between the host and the server may normalize again in transit. The spec would
be promising something it cannot deliver past the first proxy.

Rejecting instead gives the same security property — no silent retargeting — without
depending on a guarantee nothing downstream honours. `.`, `..`, and their percent-encoded
forms (`%2e`, `%2E`, in either position) **MUST** be rejected as complete path segments.
Percent-encoded separators are *not* affected: `a%2fb` is one literal segment containing a
slash and remains valid.

*(Blocker raised by Sol; the empty-authority and non-special-scheme findings above came out
of verifying it.)*

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

## 5. Three values, not one

An endpoint has **three** distinct values. A host **MUST** retain all three and **MUST NOT**
derive one by overwriting another:

| Value | What it is | Used for |
|---|---|---|
| `configuredUri` | Exactly what the operator or agent wrote, byte for byte | Provenance — what was *intended* |
| `canonicalUri` | The §3 normalized `mcpl://` form | Equality, deduplication, "already connected" |
| `resolvedTransport` | The `wss://` target actually dialled | Debugging, logs, what the socket did |

```jsonc
{
  "id": "eidoverse",
  "configuredUri":    "mcpl://EIDOVERSE.Animalabs.AI?world=abc",
  "canonicalUri":     "mcpl://eidoverse.animalabs.ai/?world=abc",
  "resolvedTransport": "wss://eidoverse.animalabs.ai/?world=abc"
}
```

Collapsing any pair loses something that cannot be recovered. Overwriting `configuredUri`
with the canonical form destroys **intent** — a config that says `mcpl://` asserts "this is
an MCPL endpoint, reached securely", and rewriting it makes that assertion look like an
implementation detail to the next reader. Overwriting `canonicalUri` with the configured
form destroys **identity** — two spellings of one endpoint stop comparing equal, and
deduplication silently fails.

`mcpl_list` **SHOULD** expose all three as separate fields, alongside advertised
capabilities, the effective grant (§5.4), and manifest freshness (§17) — which are likewise
distinct facts that have historically been shown as one.

*(Blocker raised by Sol: the earlier draft called the configured value "canonical", which is
exactly the conflation that makes implementations overwrite one or the other.)*

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

Implementations **MUST** reproduce these exactly. Every value below was produced by running
the §3 algorithm, not written by hand.

### 8.1 Resolution

| # | Input | `canonicalUri` | `resolvedTransport` |
|---|---|---|---|
| 1 | `mcpl://example.com` | `mcpl://example.com/` | `wss://example.com/` |
| 2 | `mcpl://example.com/path` | `mcpl://example.com/path` | `wss://example.com/path` |
| 3 | `mcpl://example.com:8443/x` | `mcpl://example.com:8443/x` | `wss://example.com:8443/x` |
| 4 | `mcpl://eidoverse.animalabs.ai?world=abc` | `mcpl://eidoverse.animalabs.ai/?world=abc` | `wss://eidoverse.animalabs.ai/?world=abc` |
| 5 | `MCPL://Example.COM/x` | `mcpl://example.com/x` | `wss://example.com/x` |
| 6 | `mcpl://EIDOVERSE.Animalabs.AI:443/x` | `mcpl://eidoverse.animalabs.ai/x` | `wss://eidoverse.animalabs.ai/x` |
| 7 | `mcpl://ünicode.example/x` | `mcpl://xn--nicode-2ya.example/x` | `wss://xn--nicode-2ya.example/x` |
| 8 | `mcpl://[2001:DB8::1]:8443/x` | `mcpl://[2001:db8::1]:8443/x` | `wss://[2001:db8::1]:8443/x` |
| 9 | `mcpl://localhost/x` | `mcpl://localhost/x` | `wss://localhost/x` |
| 10 | `mcpl://h/p?b=2&a=1` | `mcpl://h/p?b=2&a=1` | `wss://h/p?b=2&a=1` |
| 11 | `mcpl://h/x?a=1&a=2` | `mcpl://h/x?a=1&a=2` | `wss://h/x?a=1&a=2` |
| 12 | `mcpl://h/a%2fb` | `mcpl://h/a%2fb` | `wss://h/a%2fb` |
| 13 | `mcpl://h/%7Euser` | `mcpl://h/%7Euser` | `wss://h/%7Euser` |

Note vector 13: percent-encoding is **not** normalized. `%7Euser` and `~user` are different
paths, and an implementation that decodes unreserved characters is non-conforming. (An
earlier draft of this RFC claimed the opposite; it was wrong.)

Vectors 10 and 11 exist because an implementation that round-trips the query through
`URLSearchParams` and re-serializes will sort or deduplicate, and fail both silently.

Vectors 6 and 7 are the ones that fail if canonicalization is applied to the `mcpl://` form
directly rather than to the resolved form (§3.1): the port survives, the case survives, and
`ünicode.example` becomes `%C3%BCnicode.example` instead of `xn--nicode-2ya.example`.

### 8.2 Rejection

| # | Input | Rejected because |
|---|---|---|
| 14 | `mcpl:///x` | empty authority — would otherwise dial host `x` |
| 15 | `mcpl://u:p@h/x` | userinfo |
| 16 | `mcpl://h/x#frag` | fragment |
| 17 | `mcpl://h/a/../b` | dot segment |
| 18 | `mcpl://h/a/%2e%2e/b` | dot segment, percent-encoded |
| 19 | `mcpl://h/a/./b` | dot segment (single) |
| 20 | `mcpl://h:99999/x` | port out of range |

Vectors 14 and 18 are the two that a string-level pre-check catches and a parser does not:
`mcpl:///x` parses happily as a non-special URI with an empty host, and `%2e%2e` collapses
silently into a shorter path.

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
