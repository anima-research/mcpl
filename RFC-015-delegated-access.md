# MCPL RFC-015: Delegated Access

**Status:** Draft (revision 2)
**Targets:** MCPL Protocol Specification 0.5
**Authors:** Claude Code, from a scope proposed by antra
**Date:** 2026-10-25
**Depends on:** RFC-002 / SPEC §5.4 for authority. Adds one capability path (`access.token`),
one method (`access/token`, Server → Host, Request), one advertisement member on each side
(`access`), and one error code (`-32040`). Amends SPEC §4 (message flow), §5.1–§5.2
(advertisement), §6.2 (`uses` vocabulary), §13.1 (trust model), §18.3 (credentials), §19.6.1
(its closing paragraph), Appendix A, Appendix B, Changelog. Used by RFC-014 (Surfaces).

Section references (§) are to the SPEC; references to this document are written "RFC §".

> **Revision 2 note.** From the first host implementation (an mcpl-cc-bridge branch). No
> change to the method or its shape: wildcards never grant `access.token` (RFC §4.1 said both
> ways); MCP's `_meta` is allowed in params; the order of checks is fixed; code-point lengths
> and an `endpoint` bound; a host without an identity advertises nothing and answers `-32040`;
> the cache is per configured server, not per connection; and a warning that listing
> `access.token` in `uses` disables the feature set on pre-RFC hosts.

---

## 1. Summary

Some servers act on the agent's behalf toward a third service: a surface server that mounts a
remote game, a card table, a 3D pipeline; a proxy; a server that is itself the host of another
server. To do that as the agent, the server needs the agent's credential **for that
service**. The agent's identity lives in the host. Until now MCPL gave the server no way to
ask — SPEC §19.6.1 says so in as many words: *"There is no host→server credential
'inversion': the server holds no host credential under the current connection model."* The
only option was a credential written into the server's own configuration: long-lived, one
identity for every principal the server serves, and expiring silently.

This RFC adds the inversion as one request:

```jsonc
// Server → Host
{ "jsonrpc": "2.0", "id": 9, "method": "access/token",
  "params": { "audience": "games",
              "endpoint": "wss://games.example/mcpl",
              "purpose": "doom-1: opened by the agent" } }

// Host → Server
{ "jsonrpc": "2.0", "id": 9,
  "result": { "scheme": "bearer", "credential": "aid1.…",
              "expiresAt": "2026-10-25T04:15:00Z", "principal": "agent:example@animalabs.ai" } }
```

The host — which holds the agent's identity — mints a short-lived credential for the named
audience, or refuses. **Granting `access.token` is the trust decision.** A server holding
the grant may request a credential for any audience; what the agent itself may obtain from
its identity provider is the outer bound. There is no per-audience list to maintain.

---

## 2. Motivation

**Static credentials in server configuration.** Every adapter that reaches a service as the
agent carries a token in its config today. Agent tokens are minted long (days) because
nothing renews them; a shared server presents one identity for every agent connected to it;
and the token expires without anyone noticing until the next `open` fails. A host that
already mints fresh audience tokens at every dial (as hosts with an identity module do)
cannot help, because the server has no way to ask it.

**Passing the connection's credential through is wrong.** The credential that opened the
connection, where there is one, was minted for *this* server's audience. Forwarding it to
another service either fails (the verifier checks the audience) or, where audiences are
loose, makes the server a confused deputy. MCP's authorization guidance forbids exactly
this. What the server needs is a different credential, minted for the downstream audience,
by the party entitled to mint it.

**Why not only federation.** A host can dial remote MCPL servers itself and attach its own
credential (§18.3), and for a remote that *is* an MCPL server that remains the better
topology. It does not reach services that are not MCPL — HTTP APIs an adapter calls — and it
cannot let one local server own the lifecycle of many engagements, which is what RFC-014
surfaces are for.

### Design principles

1. **The grant is the trust decision.** One capability path, deny by default. Granting it
   says "this server acts as the agent". There is no second list of what it may act as.
2. **The identity provider bounds it.** A host can only obtain what the principal can; the
   provider's own policy for the principal is the outer limit, unchanged by this RFC.
3. **Short-lived, asked for per use.** Credentials expire in minutes and are requested at
   each dial, so revocation is quick and a leaked credential is short-lived.
4. **Never in model context.** Credentials move between host and server and nowhere else.
5. **Scheme-agnostic.** The wire carries a scheme and an opaque credential; aid1 bearer
   tokens are the first scheme, not the only one.

---

## 3. `access/token` (Server → Host, Request)

### 3.1 Parameters

| Field | Type | Required | Description |
|---|---|---|---|
| `audience` | `string` (1–128 code points) | Yes | The service the credential is for, in the identity provider's audience vocabulary |
| `endpoint` | `string` (absolute URI, ≤ 2048 code points) | No | Where the server will present it. For audit; see RFC §8.4 |
| `purpose` | `string` (≤ 256 code points) | No | Why, in words an operator reading an audit log would understand |
| `fresh` | `boolean` | No | Do not return a cached credential (the endpoint refused the last one) |
| `_meta` | `object` | No | MCP's reserved metadata member; ignored by this RFC |

Any other member **MUST** be rejected with `-32602 Invalid params`.

### 3.2 Result

| Field | Type | Required | Description |
|---|---|---|---|
| `scheme` | `string` | Yes | `"bearer"` in this revision |
| `credential` | `string` | Yes | The credential, opaque to MCPL |
| `expiresAt` | `string` (ISO 8601) | Yes | When it stops being valid. A host that cannot state this MUST NOT answer |
| `principal` | `string` | No | Whom it identifies (e.g. `agent:example@animalabs.ai`) |

### 3.3 Errors

| Code | When | `data` |
|---|---|---|
| `-32002` Capability denied | `access.token` is not in the effective grant | `{ capability: "access.token" }` |
| `-32040` Access refused | The host has no identity to mint from, or the identity provider refused | `{ audience, reason }` |
| `-32602` Invalid params | Malformed request, unknown member | `{ field, reason }` |

**Order of checks.** The grant first (`-32002`), then the parameters (`-32602`), then minting
(`-32040`): a server without the grant learns nothing about what a well-formed request would
have produced.

A refusal is final for that request. The server degrades — the feature that needed access is
unavailable, with the reason — and **MUST NOT** treat a refusal as a negotiation (§6.7):
there is no "grant me access or I will not start".

---

## 4. Capability, advertisement, grant

### 4.1 The path

`access.token` joins the §6.2 vocabulary. It is a **write of authority** — the server comes to
hold a credential that acts as the principal — and is **denied by default**: a host MUST NOT
include it in an effective grant unless the operator has named it for that server
explicitly. **No default policy, preset or wildcard grants it**: although `access.*` would
match it under §5.4's one-segment rule, a host MUST NOT let a wildcard confer this path, and
SHOULD warn when an operator's wildcard would otherwise have matched it.

**Pre-RFC hosts.** §6.2's vocabulary is closed, and §6.4 disables a feature set whose `uses`
names an unknown path. A server SHOULD therefore keep `access.token` out of the `uses` of any
feature set that should survive on a host that does not know this RFC — the method is
authorized by the grant (RFC §4.2), not by a feature set.

### 4.2 Advertisement

Server, when it may ask:

```jsonc
"experimental": { "mcpl": { …, "access": { "token": true } } }
```

Host, when it can answer (it holds an identity to mint from):

```jsonc
"experimental": { "mcpl": { …, "access": { "token": true } } }
```

A server **MUST NOT** send `access/token` to a host that did not advertise it, and a host
**MUST** answer one it receives without the grant with `-32002`, never silence (§6.6).
`access/token` carries no `featureSet`: like the channel methods (§14.1), it is authorized by
the grant alone (but see the note on `uses` in RFC §4.1).

A host that has no identity to mint from **MUST NOT** advertise `access`. If it nonetheless
includes `access.token` in a grant (an operator's configuration, kept across an identity
being removed), it answers requests with `-32040`, reason "no identity".

### 4.3 What the grant means

A server holding `access.token` may obtain, **for the connection's principal**, a credential
for **any audience the principal can obtain**. The protocol defines no narrowing. A host MAY
refuse particular audiences by its own policy, and says so with `-32040`; it is not required
to keep, and this RFC does not define, a list.

The rationale is the threat model. A server trusted to act as the agent at one service is
already trusted with the agent's actions, data and spend there; a list does not protect
against a compromised server, which would simply request what the list allows, and it costs
an operator a piece of configuration per service per server, out of date the day a service is
added. The bound that matters — what the agent may do at all — is enforced where it already
lives, by the identity provider.

### 4.4 One principal per connection

The host mints only for the principal of the connection the request arrived on. A server
serving several principals over several connections receives each principal's credential
over that principal's connection and **MUST NOT** use a credential obtained on one
connection on behalf of another principal.

### 4.5 Revocation

Revoking `access.token` (a grant reduction, §6.7) takes effect at once for new requests.
Credentials already issued remain valid until `expiresAt` — they are bearer credentials,
which is why lifetimes are short (RFC §5). A server that loses the grant **SHOULD** discard
cached credentials.

---

## 5. Lifetime and reuse

- Hosts **SHOULD** issue credentials that expire within **15 minutes**, where the identity
  provider supports choosing a lifetime, and **MUST** report the real `expiresAt`.
- A server **MUST NOT** use a credential after its `expiresAt`. It **SHOULD** request at each
  dial and reconnect, and **MAY** reuse a credential across requests until shortly before
  expiry (the reference implementation renews 60 s early).
- When the endpoint rejects a credential, the server **MAY** request once with
  `fresh: true`; a second rejection is the endpoint's answer, not a reason to retry.
- Hosts **MAY** cache per (configured server, audience) — across reconnects of the same
  configured server, never across principals — and **MAY** rate-limit; a server whose
  requests are throttled degrades as for a refusal. `fresh: true` bypasses the cache.

---

## 6. Server obligations

A server holding a credential obtained through this method:

1. **MUST** present it only to the audience's service — the endpoint it named, if it named
   one.
2. **MUST NOT** place it in any content block, tool result, event, channel message, resource,
   URI shown to a model, or log line, and **MUST NOT** hand it to any other server except as
   RFC §7 allows. The same reasoning as §19.6: what reaches model context reaches
   chronicles, compression, channels and screenshots.
3. **MUST NOT** persist it beyond its lifetime, and **SHOULD NOT** persist it at all.
4. **SHOULD** say, when access is refused, what is unavailable and why, in the terms the host
   gave — without speculating about credentials.

---

## 7. Chains

A server that is itself the host of an upstream server (it dialed it) may receive
`access/token` from that upstream. It **MAY** satisfy the request by making its own
`access/token` request to its host, **only if** its own effective grant includes
`access.token` **and** it granted `access.token` to the upstream. The principal does not
change along the chain; each hop applies its own grant; the credential returns down the same
path. A hop **MUST NOT** answer from a credential it obtained for a different request's
audience.

---

## 8. Host obligations

### 8.1 Minting

The host obtains the credential from its identity provider for the connection's principal
and the named audience, requesting a lifetime within RFC §5 (the reference host asks for 15
minutes; a provider that cannot shorten lifetimes issues its own, which the host reports
truthfully in `expiresAt`).
How it does so is the provider's protocol (for archipelago-home: a signed key-proof to
`POST /token`).

### 8.2 Audit

The host **SHOULD** record each request: server, audience, endpoint, purpose, outcome,
`expiresAt`. It **MUST NOT** record the credential.

### 8.3 Agent-facing surface

None. The agent never sees, names or handles credentials; the most it sees is a server
saying an app is unavailable and why. (Hosts that keep credential mechanics out of agent
context do so for hygiene and because a model narrating token handling reads as exfiltration
to safety classifiers — reasons that apply unchanged here.)

### 8.4 The `endpoint` field

`endpoint` is the server's statement of where the credential will go. A host **MAY** compare
it with a directory it trusts (an identity provider's published service map) and refuse a
mismatch; that catches misconfiguration and makes audits legible. It is not a security
boundary: a bearer credential can be presented anywhere that accepts its audience, whatever
the request said.

---

## 9. Security considerations

**What a granted server can do.** Act as the principal at any audience the principal can
reach, until each credential expires. That is the same power the host exercises when it
dials on the agent's behalf, extended to a process the operator chose to trust with it — the
reason the path is denied by default and granted only explicitly.

**Bearer exposure.** Bounded by audience binding (verifiers check `aud`) and lifetime.
Sender-constrained credentials (proof-of-possession) and delegated credentials that name the
intermediary as an actor would bound it further; both need identity-provider support and are
left to a later revision (RFC §12). The `scheme` field leaves room for them.

**Not passthrough.** The credential is minted for the downstream audience by the party
entitled to mint it, never the credential that opened the connection. The confused-deputy
problem that rule exists for does not arise.

**Model context.** RFC §6.2 and §8.3 keep credentials out of everything a model reads.

**Amplification.** A server could request credentials in a loop; hosts MAY rate-limit, and
caching (RFC §5) makes normal operation cheap.

---

## 10. Spec amendments

- **§4** message-flow table: `access/token` | Request | Server → Host.
- **§5.1, §5.2**: the `access` advertisement member on both sides.
- **§6.2**: `access.token` joins the `uses` vocabulary.
- **§13.1**: a granted server may hold short-lived credentials acting as the principal.
- **§18.3**: "Credential policy belongs to the host and to whatever identity mechanism a future
  revision defines" — this RFC defines the host→server half; endpoint credentials remain as
  they are.
- **§19.6.1**, closing paragraph: replace "There is no host→server credential 'inversion' …"
  with a reference to this RFC, and keep the rule that a connection's own authentication
  context is never handed to the server.
- **Appendix A**: `-32040` Access refused, `data: { audience, reason }`.

---

## 11. Schema

```ts
interface AccessTokenParams {
  audience: string;          // 1..128
  endpoint?: string;
  purpose?: string;          // ≤ 256
  fresh?: boolean;
}
interface AccessTokenResult {
  scheme: "bearer";
  credential: string;
  expiresAt: string;         // ISO 8601
  principal?: string;
}
// experimental.mcpl.access?: { token?: boolean }   (server and host)
// capability path: "access.token"
// error: -32040 Access refused, data: { audience: string, reason: string }
```

---

## 12. Conformance vectors

Freeze before Draft→Accepted (RFC-005 §11):

1. Request without the grant → `-32002`, `data.capability = "access.token"`.
2. Request to a host that did not advertise `access` → the server does not send it.
3. Granted request → result with `scheme`, `credential`, `expiresAt` in the future.
4. Identity provider refuses → `-32040` with `audience` and `reason`; no credential.
5. Unknown params member → `-32602`.
6. A credential never appears in any `push/event`, tool result, or log line of the server
   (syntactic scan over a recorded session).
7. Two principals on one server: each request is answered with that principal's credential.
8. Grant revoked → next request `-32002`.
9. Chain: a hop without the grant refuses its upstream's request with `-32002`.

---

## 13. Open questions

1. **Actor claims.** A delegated credential that names the intermediary (`act`, as in OAuth
   token exchange) would let a service see "agent X, via server Y". Needs provider support.
2. **Proof of possession.** Binding a credential to the server's own key would make a leaked
   credential useless elsewhere. Needs provider and verifier support.
3. **Telling the server about revocation.** Today a server learns by its next request failing.
4. **Other schemes.** OAuth access tokens, signed requests; the wire is ready, the vocabulary
   is not.

---

## 14. Reference implementations

- **Server:** a TypeScript server runtime in which apps ask through `ctx.access(audience)`;
  credentials cached per principal and audience, renewed 60 s before expiry, re-requested on
  reconnect, never rendered.
- **Host:** mcpl-cc-bridge — an enrolled ed25519 identity, per-dial minting for
  servers it dials (`access`), and `access/token` answered for servers granted
  `access.token`.
- **Identity provider:** archipelago-home, with a change letting `POST /token` request a
  lifetime no longer than the principal's own.
