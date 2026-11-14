# MCPL RFC-009: Endpoint Discovery from a Service Address

**Status:** Draft (revision 1). Draft→Accepted is gated on [§10's executable-vector
criterion](#10-conformance-vectors).
**Targets:** MCPL Protocol Specification 0.5
**Authors:** Claude Code, from a question asked by antra ("if an agent is given the URL of a
document, how does it know an MCPL server exists, and how to connect?"), after a first
implementation in Anima Docs.
**Date:** 2026-10-17
**Depends on:** RFC-004 / SPEC §18 for the `mcpl://` URI this RFC *finds*; RFC-002 / SPEC §5.4
for what a connected server may do, which this RFC does not touch. RFC-004 §9 parked discovery
("`.well-known`, SRV records") as a separate RFC layered on top; this is that RFC, for the one
case that has come up: **an HTTP(S) address inside a service → that service's MCPL endpoint.**

---

## 1. Summary

An agent is handed `https://docs.example.org/d/dXYZ`. It can fetch the address, but nothing in
what comes back says that the service also has an MCPL endpoint, where it is, what identity it
expects, or where to read how any of this works. Today that knowledge travels by prose in a
README or a chat message, and an agent that has only the address stops at a blank app shell.

This RFC defines **three places a service puts the same fact** and **one courtesy**, so that an
agent — or the host dialling on its behalf — can get from any address in the service to its
endpoint without a human:

| Where | What | For whom |
|---|---|---|
| `Link` response header | `rel="mcpl"` → the endpoint; `rel="help"` → an agent guide | any client that looks at headers (one `HEAD`) |
| HTML `<link rel="mcpl">`, `<meta name="mcpl">` | the same endpoint, in the page | clients that fetch and parse HTML (most agent tooling) |
| `/.well-known/mcpl` | a JSON record: endpoint, identity hints, guide | clients that look things up by origin |
| `Accept: text/markdown` | a readable answer at the same address: the pointer, and the resource's text when it is readable anyway | agents that read, not render |

The fact itself is an **RFC-004 endpoint URI**. This RFC adds no authority, no identity and no
trust: finding an endpoint is not permission to use it, and presenting a credential to a found
endpoint is governed by the host's policy, not by this document (§7).

---

## 2. Terms

- **Service address** — any `https://` URL whose origin is served by the service: a document,
  a page, a share link, the root.
- **Endpoint** — the service's MCPL door, written as an RFC-004 URI (`mcpl://host/path`), or as
  the `wss://` it resolves to. `ws://` is **never** advertised by this RFC (RFC-004 §2).
- **Guide** — a document written for agents: how to connect, what identity is expected, what
  the tools are. Served as `text/markdown`.
- **Record** — the JSON document at `/.well-known/mcpl`.

---

## 3. The `Link` header

A service **SHOULD** send, on **every** HTTP response it controls (pages, API answers, errors,
redirects):

```
Link: <mcpl://docs.example.org/mcpl>; rel="mcpl", <https://docs.example.org/agents.md>; rel="help"
```

- `rel="mcpl"` — exactly one; its target is the endpoint. The relation type `mcpl` is an
  extension relation (RFC 8288 §2.1.2); registration is future work (§11).
- `rel="help"` — the guide (a registered relation, RFC 8288). Optional but recommended.
- The header goes on every response because the client that needs it may be fetching anything:
  a share link that redirects, an API error, an image. One `HEAD` on any service address answers
  the question.

---

## 4. In HTML

A service that serves HTML **SHOULD** include, in `<head>`:

```html
<link rel="mcpl" href="mcpl://docs.example.org/mcpl">
<meta name="mcpl" content="mcpl://docs.example.org/mcpl">
<link rel="help" type="text/markdown" href="https://docs.example.org/agents.md">
```

and **SHOULD** place, in the body, text an agent will see when it fetches the page as HTML and
reads it as text — a `<noscript>` block is the natural place for a single-page app, since
browsers with scripting never show it and text extractors keep it:

```html
<noscript><div class="agents-note">
<p>This is Docs. Agents work here over MCPL; the door is mcpl://docs.example.org/mcpl …</p>
<p>How to connect and what the tools are: https://docs.example.org/agents.md</p>
<p>This address is document dXYZ.</p>
</div></noscript>
```

The `<link>`/`<meta>` pair is for parsers; the note is for readers. Both say the same thing.

---

## 5. The well-known record

`GET /.well-known/mcpl` (and, as an alias, `/.well-known/mcpl.json`) **SHOULD** return
`application/json`:

```json
{
  "service": "Anima Docs",
  "origin": "https://docs.example.org",
  "mcpl": "mcpl://docs.example.org/mcpl",
  "wss": "wss://docs.example.org/mcpl",
  "spec": "MCPL 0.5; mcpl:// per RFC-004",
  "identity": {
    "issuer": "https://id.example.org",
    "audience": "docs",
    "scopes": ["docs:use"],
    "guide": "https://id.example.org/agents.md"
  },
  "guide": "https://docs.example.org/agents.md",
  "featureSets": ["docs.read", "docs.write", "docs.comment", "docs.share", "docs.watch"]
}
```

| field | required | meaning |
|---|---|---|
| `mcpl` | **yes** | the endpoint, an RFC-004 URI in canonical form (§3 there) |
| `wss` | no | the same endpoint resolved; **MUST** equal RFC-004's resolution of `mcpl` when present |
| `service`, `origin` | no | a human name; the origin this record speaks for |
| `spec` | no | protocol version and the RFCs the service relies on, free text |
| `identity` | no | *hints* about what the endpoint will accept: the issuer it trusts, the audience and scopes it requires, and where an agent learns to obtain such a credential. Hints only (§7) |
| `guide` | no | the agent guide; the same document as `rel="help"` |
| `featureSets` | no | the feature-set names the endpoint offers (SPEC §6), so a host can decide before dialling whether it wants to |

Unknown fields **MUST** be ignored. The record is cacheable (`Cache-Control: public`); it changes
when the service moves, which is rare.

**Consistency.** The endpoint named by the header, the HTML and the record **MUST** be the same
endpoint after RFC-004 canonicalization. A client finding a disagreement **SHOULD** prefer the
record (it is the service speaking about itself at a fixed address) and **MAY** report the
disagreement.

---

## 6. The readable answer

A service **SHOULD** answer a service address with `text/markdown` when the request asks for text
rather than the application:

- `Accept` lists `text/markdown` or `text/plain` and does **not** list `text/html`; or
- a service-defined query parameter asks for it (`?format=md` is the convention used so far).

The answer **MUST** begin with the pointer (what the service is, the endpoint, the identity
expectation, the guide, and the resource's identifier if the address names one), and **MAY**
continue with the resource's content — **only content the requester could read anyway without
credentials** (a public page, a resource behind an anyone-with-the-link address when that address
is what was fetched). A readable answer **MUST NOT** become a side door: the same access decision
applies as to the rendered page. When the content is not readable, the answer says so and stops.

Browsers never see this: `Accept: text/html` keeps the application. Crawlers that read HTML for
link cards keep theirs. The courtesy exists because an agent fetching an address wants to *read*
it, and a blank SPA shell reads as nothing.

---

## 7. What discovery is not

- **Not authority.** A found endpoint grants nothing. Connection, grants and feature sets follow
  SPEC §5 and RFC-002 exactly as if the endpoint had been typed by hand.
- **Not trust.** The `identity` hints tell an agent *what kind* of credential will be asked for.
  A host **MUST NOT** present a credential to a discovered endpoint on the strength of the record
  alone; it does so under its own policy (an operator allow-list, a confirmation, an
  audience-scoped token that is useless elsewhere — RFC-004 §9's "identity" remains out of scope
  here too).
- **Same origin, by default.** The endpoint's host **SHOULD** be the address's host or a
  subdomain of it. A record or header naming an endpoint on an unrelated host is legal (a service
  may front several hostnames) but a host dialling automatically **MUST** treat it as a cross-host
  referral: surface it rather than dial it silently. This is the one place discovery could be
  turned into phishing — a page that says "your MCPL door is over there" — and the mitigation is
  that an aid1-style audience-bound token presented to the wrong host is worthless, *and* that
  hosts do not follow a referral off-origin without saying so.
- **Not transport selection, not mobility, not DNS.** SRV records, several transports behind one
  name, `server/moved` — still parked (RFC-004 §9). This RFC finds *one* endpoint from *one*
  HTTPS origin.

---

## 8. Host behaviour

A host (or an agent with HTTP access) given a service address and wanting the endpoint:

1. `HEAD` the address; if a `Link` with `rel="mcpl"` is present, that is the endpoint. Stop.
2. Otherwise `GET /.well-known/mcpl` on the address's origin; if it parses and has `mcpl`, that
   is the endpoint. Stop.
3. Otherwise `GET` the address with `Accept: text/html`, parse `<link rel="mcpl">` / `<meta
   name="mcpl">`.
4. Otherwise there is no advertised endpoint; the host says so rather than guessing a path.

The result is an RFC-004 URI; feed it to the host's connect operation (`mcpl_deploy {"url": …}`
or equivalent). A host **MAY** also fetch the guide and the readable answer and give them to the
agent as context: that is what they are for.

An agent that has no MCPL-speaking host at all can still do step 1 or 2 with any HTTP client,
read the guide, and ask its operator — which is the failure mode this RFC is designed to make
short.

---

## 9. First implementation

Anima Docs (`https://docs.animalabs.ai`) implements §3–§6: the header on every response,
`<link>`/`<meta>`/`<noscript>` in its app shell, `/.well-known/mcpl`, `/agents.md` (also served as
`/llms.txt`), and markdown answers at document, page and share-link addresses with the access
rule of §6. Its guide points at the identity node's own agent guide
(`https://id.animalabs.ai/agents.md`) for the credential half. The mcpl-cc-bridge and the
Connectome agent-framework accept the discovered `mcpl://` URI as an endpoint (RFC-004).

---

## 10. Conformance vectors

**Acceptance criterion:** before this RFC moves Draft→Accepted, these vectors freeze as
executable vectors under `conformance/` (RFC-003 §3.1 precedent) and run against at least one
service implementation and one host (dialler) implementation. `conformance/discovery-vectors.json`
holds the frozen inputs and expectations; the service half was checked against Anima Docs' own
test suite at the time of writing.

| # | Input | Expected |
|---|---|---|
| 1 | `HEAD` any service address | `Link` carries exactly one `rel="mcpl"` whose target is an RFC-004 URI or its `wss://` resolution; never `ws://` |
| 2 | `GET /.well-known/mcpl` | `200 application/json`; `mcpl` present and canonical; `wss`, if present, equals RFC-004 resolution of `mcpl` |
| 3 | Header, HTML and record compared after canonicalization | one endpoint; a disagreeing client prefers the record and MAY report |
| 4 | `GET` a service address with `Accept: text/markdown` | `200 text/markdown`; body begins with the pointer naming the endpoint and the guide |
| 5 | Vector 4 on a resource not readable without credentials | body contains no resource content; says it is not readable |
| 6 | Vector 4 on an anyone-with-the-link address | body contains the resource's content |
| 7 | `GET` a service address with `Accept: text/html` | the application (or page), unchanged by this RFC |
| 8 | Record with unknown fields | parsed; unknown fields ignored |
| 9 | Record naming an endpoint on an unrelated host | a dialling host does not dial silently; it surfaces the referral |
| 10 | Record `mcpl` written as `ws://…` | host rejects the record (RFC-004 §2: never plaintext by advertisement) |
| 11 | Host procedure (§8) on a service with no header, no record, no tags | host reports "no advertised endpoint"; it does not guess `/mcpl` |

---

## 11. Future work

- Register `mcpl` as a link relation type (RFC 8288 §2.1.1) once the relation has settled.
- A `rel="mcpl"` on a **non**-HTML resource type (e.g. an `application/json` API answer) is
  covered by §3 already; a representation *inside* JSON APIs (a top-level `_mcpl` field) is not
  defined here and is not needed while the header exists.
- Discovery across transports and hosts — RFC-004 §9's remaining items — stays parked.
