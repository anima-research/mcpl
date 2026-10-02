# MCPL RFC-005: Bulk Content References

**Status:** Draft (revision 3) — incorporated into [SPEC.md 0.5.0-draft §19](./SPEC.md#19-bulk-content-references).
Incorporation does not imply acceptance: Draft→Accepted remains gated on [§11's executable-vector criterion](#11-conformance-vectors).
**Targets:** MCPL Protocol Specification 0.5
**Authors:** Claude Code, from a scope proposed by antra; revised after review (twice)
**Date:** 2026-08-31 (revision 1); 2026-09-01 (revisions 2, 3)
**Depends on:** nothing for authority — RFC-002 / SPEC §5.4 remains the sole source of what a
connected server may do, and this RFC adds no capability path (§9). Amends the SPEC §10.3 /
Appendix B.1 content-block shapes (§8); reuses the RFC-003 digest encoding.

This RFC preserves the proposal and its review history. SPEC.md carries the current integrated draft, including the pending acceptance criterion.

> **Revision 3 note.** The `e9edc31` re-review confirmed the revision-2 architecture and
> found three normative contradictions/holes, all fixed here without structural change:
>
> - **`never` is unconditional (§5).** Revision 2 let host policy restore a
>   "non-capability-bearing" URI to the stub under any disposition — quietly weakening the
>   RFC's strongest MUST below its own conformance vector. The URI-visibility MAY is now
>   scoped to `ref`/absent disposition only; under `never`, no host policy or capability
>   classification restores the URI.
> - **Authenticated dereference narrows to the dialed origin (§6.1); declared reference
>   origins are deferred (§10).** Revision 2 advertised a manifest-declared-origin path with
>   no manifest field, origin grammar, matching rule, or vector behind it. Rather than
>   specify all of that now, revision 3 takes the small-core option: authentication context
>   applies to exactly the origin the connection was dialed to; every other origin is
>   fetched credential-less. The server-side "MUST accept its own authentication context"
>   is restated as a transport-scoped serving requirement (testable per transport) plus the
>   syntactically testable no-embedded-credential MUST.
> - **Metadata is bounded (§3, §5, §7.3, §8).** `sizeBytes` was bounded; `uri`, `name`,
>   `mimeType`, and `expiresAt` were not, so a server could move the context bomb into a
>   field name and falsify vector 8. Schema maxima are added emitter-side; hosts truncate
>   every server-supplied string to their own display bounds before stub/wake assembly, so
>   stub size is independent of every server-supplied field length. Storage paths are
>   host-generated from the reference id — the server `name` is a display label that is
>   never a path component, replacing revision 2's "sanitize to a basename".
> - Nonblockings taken: one interoperable invalid-field rule (reject the field, keep the
>   block and its subtractive ceiling); a content-coding vector pinning digest/size to
>   decoded identity octets; an MCP `ResourceLink` mapping note (§8.1); reference-id
>   eviction/staleness semantics (§5); and an acceptance criterion freezing the vectors as
>   executable before Draft→Accepted (§11).

> **Revision 2 note.** Revision 1 (`389995e`) was reviewed the day after it was written and
> came back CHANGES REQUESTED — correctly. It had the shape of a security architecture
> borrowed from one friendly deployment, not the architecture itself. What changed:
>
> - **The recut (§2).** The RFC is now organized around three explicitly separate objects:
>   server **testimony** (wire), the host-private **reference record** (never wire), and the
>   model-visible **stub**. Nothing may flow from the first to the third except through host
>   policy over the second.
> - **The credential rule is rebuilt (§6).** Revision 1 required dereferencing "with the
>   connection's credential" — a contract that is unimplementable on stdio and unsafe where
>   implementable, since it turns a transport credential into a transferable content
>   credential. Connection auth is now a **host-private authentication context**, applied
>   only by a host-mediated fetcher, only to origins bound to the authenticated connection,
>   never forwarded cross-origin. Host→server credential "inversion" is removed.
> - **Dereference fails closed (§7).** Receipt of a reference never triggers a fetch. All
>   server-supplied metadata is testimony at a security boundary: scheme/origin allowlists,
>   redirect bounds, and an actual-byte streaming ceiling are now normative, with vectors.
> - **The URI left the stub (§5).** Signed URLs and query capabilities are bearer
>   credentials; revision 1 banned the emitting server's token in the URI while requiring
>   the URI in model context. The stub is now built on a host-generated opaque reference id;
>   raw-URI visibility is host policy with a credential-bearing-by-default assumption.
> - **Scope narrowed (§4).** Server→host `ContentBlock[]` lanes only. The "symmetric"
>   host→server paragraph overstated what tool arguments and `channels/publish` mean and is
>   deferred with rationale.
> - **`inline-ok` removed.** It bound nobody; absent-annotation host policy already covers it.
> - **The schema is normative (§8)**, the authority asymmetry is stated as an asymmetry
>   (§3.1), and the field moved out of a generic `annotations` bag to avoid colliding with
>   MCP's existing annotation vocabulary.

> **Evidence base.** Written the day the problem was hit, not anticipated: vst-mcpl (a
> render server whose tool results reference multi-megabyte wav files on a machine its
> callers cannot shell into) had to invent `download_url` / `download_note` fields inside a
> `text` block — invisible to the protocol, unactionable by hosts, and guaranteed to be
> re-invented under different names by the next server that renders, records, exports, or
> transcodes anything. The pattern (results that *are* small metadata *about* something
> large) is general; the field zoo is the avoidable part.

---

## 1. Summary

Content blocks flow to model context — that is what they are for. But some tool results,
push events, and channel messages are best understood as **small testimony about large
payloads**: a rendered wav, a captured image, a dataset, a log archive. Today a server has
two bad options: inline the payload as base64 (a context bomb the host cannot refuse until
it has already parsed it) or ship an ad-hoc URL in prose (which no host can treat
uniformly, and which quietly makes URLs — sometimes credential-bearing URLs — part of model
context).

This RFC standardizes the reference and the handling contract, and deliberately no storage
system. A server describes a payload it holds; the host decides everything that happens
next; the model sees only what host policy derives. The division of labor is the one MCPL
already runs on (compare RFC-001 §7, RFC-002): the server testifies, the host disposes.

---

## 2. The Three Objects

Everything in this RFC is one of these, and the boundaries between them are the normative
content:

**1. Server testimony** — the wire object (§3). A `resource` content block carrying: what
the payload is (`mimeType`), how big the server claims it is (`sizeBytes`), how to verify
it (`digest`), how long the server intends to serve it (`expiresAt`), what to call it
(`name`), where the server serves it (`uri`), and the server's requested context
disposition (`disposition`). Every field is a claim, not a fact.

**2. Host-private reference record** — never on the wire, never model-visible (§5, §6, §7).
The host's own bookkeeping for a received reference: the raw URI, the authentication
context of the connection that delivered it, fetch state, and — after any fetch — the
*verified* size, digest, and type of the actual octets. Connection credentials live here
and nowhere else.

**3. Model-visible stub** — what context gets (§5). A host-generated opaque reference id
plus policy-safe metadata (`name`, `mimeType`, claimed size, provenance). The raw URI is
not part of the stub by default.

Nothing may flow from testimony into the stub except through host policy over the record.
That single sentence is most of the RFC; the sections below are its consequences.

---

## 3. Server Testimony: the Reference Block

No new content type. The §10.3 `resource` block gains optional fields, and the media blocks
(`image`, `audio`) **in `uri` form** MAY carry the same fields:

```jsonc
{
  "type": "resource",
  "uri": "https://mythoss-mac-mini.tail01efee.ts.net/files?path=%2F…%2Fchord.wav",
  "mimeType": "audio/wav",
  "sizeBytes": 4233704,
  "digest": "sha256:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
  "expiresAt": "2026-09-07T00:00:00Z",
  "name": "family_chord_cs80.wav",
  "disposition": "never"
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `uri` | `string` | Yes | Where the server serves the payload. `https` expected; the *host* decides what it will ever dereference (§7). |
| `mimeType` | `string` | SHOULD | Claimed media type. Testimony — verify or sniff where safety or provider compatibility depends on it; a digest authenticates bytes, not type. |
| `sizeBytes` | `integer` | SHOULD | Claimed payload size: a non-negative integer within the JSON-safe range (0 ≤ n ≤ 2^53−1). An invalid value is rejected **as a field** — treated as absent — while the block and its `disposition` remain in force (§8, vector 15). Testimony — real fetch limits run on actual bytes (§7). |
| `digest` | `string` | MAY | `sha256:` + base64url, the RFC-003 *encoding*; the hash is SHA-256 over the exact payload octets — the representation with **no content coding applied**. `sizeBytes` and `digest` MUST describe the same octet sequence. |
| `expiresAt` | `string` (ISO-8601) | MAY | Advisory availability horizon. An unparseable value fails closed: consumers treat the reference as already expired, never as immortal (§7.4). |
| `name` | `string` | MAY | Display label, nothing more: never a path component — storage names are host-generated (§7.3) — and truncated to host display bounds in stubs (§5). |
| `disposition` | `"never" \| "ref"` | MAY | Requested context disposition (§3.1). Only legal on URI-form blocks (§8). |

A reference with neither `mimeType` nor `sizeBytes` is legal but self-defeating: it denies
the host the two facts every disposition policy needs. Conformant emitters SHOULD treat
both as required in spirit.

### 3.1 `disposition`, and the authority asymmetry

| Value | Server's testimony |
|---|---|
| `"never"` | Neither the payload nor the access capability (the URI) may reach model context. Only a stub (§5) may represent this block. |
| `"ref"` | Context should see the stub, not the payload. A host MAY additionally fetch and inline where the *verified* payload is within host policy. |
| *(absent)* | No testimony. Host default policy applies; for inline `data` blocks this is today's behavior, unchanged. |

The authority here is deliberately asymmetric, and the asymmetry is the point: **a server
can veto context inclusion but can never expand it.** `"never"` binds the host (§5 — the
strongest MUST in this RFC); nothing a server writes can compel inlining, compel a fetch,
or add one byte to context that host policy would not have admitted. A server can only
stop pretending its payload is context-sized. (Compare RFC-001 §7: tags are never
authority. Disposition is the same species — testimony — with one binding value whose
effect is only ever subtractive.)

Revision 1's `"inline-ok"` is removed: it bound nobody, and absent-disposition host policy
already expresses it.

### 3.2 Rejected: a new `blob` type

A distinct type would fork every consumer's content-block switch for zero expressive gain.
The `resource` block already means "URI reference"; what it lacked was enough metadata to
have a policy about, and that is additive.

---

## 4. Scope: Where Reference Blocks May Appear

Revision 2 is scoped to the **server→host `ContentBlock[]` lanes**, where context
disposition is meaningful: **tool results** (`tools/call`), **push events** (`push/event`
`payload.content`, SPEC §9.2), **incoming channel messages** (`channels/incoming`), and
**injections** (SPEC §10).

Push events are the priority case: the one lane where the server chooses what enters
context *unilaterally* — there is no tool-call moment where the host could intervene on
size. Hosts MUST apply §5 *before* wake-text assembly, so an annotated attachment can
never inflate the cost of the wake that announces it (vector 8).

**Deferred: host→server.** Revision 1 called `channels/publish` and tool arguments
"symmetric" lanes. They are not: generic tool arguments are tool-defined JSON, not
`ContentBlock[]`, so the protocol cannot silently impose this shape on them; and
`channels/publish` is delivery to an *external recipient*, where "context disposition"
answers nothing — the real contract there is upload-vs-link-vs-omit, which deserves its own
specification. A tool MAY document that an argument accepts a §3 reference block; that is a
tool contract, not protocol.

---

## 5. The Model-Visible Stub

Where a block is withheld from context — always for `"never"`, by default for `"ref"` —
the host represents it as at most:

- a **host-generated reference id**: opaque, stable for the life of the session, unique
  per record (e.g. `ref_7f3a`). This is the thing a model can safely name — mention to a
  user, cite in reasoning, hand to the host's own facilities (a code-execution runtime's
  host-mediated fetcher, §6.2). It is host-local naming, not a server-resolvable handle:
  servers never see it and nothing here asks them to accept it. (Cross-server handle
  interchange remains deferred, §10.)
- `name`, `mimeType`, claimed `sizeBytes` — labeled as claimed, since none is verified at
  stub time;
- one line of provenance ("from tool `vst_render`" / "attachment on push event …").

**The raw `uri` is not part of the stub by default, and under `disposition:"never"` it is
removed unconditionally** — no host policy, capability classification, or user setting
restores it; `never` limits payload and access-capability exposure both, always (vectors
1, 9). Signed URLs and query capabilities are bearer credentials that look like locations;
putting them in context recreates in one field the leak §6 closes in another. For `ref` or
absent disposition only, a host MAY include the URI where its policy classifies the
reference as non-capability-bearing (for example: an origin-bound URI that is unusable
without the host-private auth context — precisely what §6.1's no-embedded-credential rule
produces). The safe default everywhere is the opaque id.

**Stub bounds.** Before stub or wake-text assembly the host truncates every
server-supplied string (`name`, `mimeType`, provenance inputs) to its own display bounds,
marking truncation, and bounds the total stub by its own policy. Stub and wake size are
therefore independent of the length of *every* server-supplied field, not only of
`sizeBytes` (vectors 8, 17).

Reference ids are not reused within a session. Records MAY be evicted by host policy
(quota, age, session shrink); a lookup of a stale or unknown id returns a defined
"unknown reference" error and never resolves to a different record (vector 20).

Hosts SHOULD render stubs uniformly so models learn one shape, and SHOULD retain an
operator-visible receipt when policy drops a block entirely, so "missing attachment" is
distinguishable from "nothing was sent".

---

## 6. The Host-Private Reference Record and Credentials

### 6.1 Authentication context, not a token

The credential (or transport identity) of the connection that delivered a reference is a
**host-private authentication context**. It is never exposed to the model, the user, or a
code-execution namespace, and it never appears in a stub, a log line, or a URI — *because a
content block named a location*, or for any other reason this RFC creates.

A host MAY apply that authentication context **only**:

- through a **host-mediated fetcher** (the host's own code; never by handing material to
  the requester), and
- to **exactly the origin the connection was dialed to.** An arbitrary URI in a content
  block binds nothing, and no other origin is authenticated: every reference elsewhere is
  fetched without the connection's authentication context. (A manifest mechanism for
  declaring additional authenticated reference origins — field, canonical origin grammar,
  matching rule, redirect relation, vectors — is deferred, §10; revision 2 advertised it
  without specifying any of that, which made it neither interoperable nor testable.)

Authentication context is **never forwarded cross-origin**: on any redirect that leaves
the bound origin, credentials are stripped, and a host MAY simply refuse redirect
traversal entirely (§7.2). References to third-party locations (a public CDN, another
archipelago service) are fetched **without** the server's authentication context; that
location's own auth applies and is out of scope.

Server side, two requirements of different testability, stated separately:

- A server that intends its references to be host-fetchable *with authentication* MUST
  serve them at the connection's dialed origin, under an authentication mechanism
  satisfiable by that connection's transport-native context — a per-transport requirement,
  testable per transport (for the WebSocket bearer case: the reference endpoint accepts
  the same token that opened the session). Where it cannot or does not, it serves them
  unauthenticated or accepts that they are not host-fetchable.
- Servers MUST NOT mint per-reference bearer credentials into the `uri` itself — testable
  syntactically (vector 6). A URI with an embedded credential is a capability that looks
  like a location; it gets pasted into channels, logged by proxies, and quoted in stubs.
  (Not theory: the first ad-hoc implementation shipped a `download_note: "append your
  token"` — the app-level pattern this rule exists to retire.)

**Transports without a reusable credential** (stdio; host-managed access; short-lived
session auth): the authentication context is whatever transport-native identity the
host-mediated fetcher can present — and where that is nothing, only references the server
chooses to serve unauthenticated are fetchable. A server on such a transport that wants
fetchable references must serve them accordingly; the host invents no credential on its
behalf.

Credential lifetime and reference lifetime are independent: an `expiresAt` beyond the
connection's credential does not promise the payload is fetchable, only that the server
intends to keep serving it to a caller who can still authenticate.

Revision 1's host→server "inversion" is removed, not deferred: the server holds no host
credential under the current connection model, so there was nothing to specify.

### 6.2 What the record holds

For each received reference the host keeps (privately): the raw URI; the connection/auth
binding; fetch state; and, after any fetch, the **verified** byte count, digest outcome,
and observed media type. Model-visible statements about a payload's actual properties come
from the record's verified fields, never from testimony.

---

## 7. Dereference Policy: Fail Closed

Receipt of a reference **MUST NOT itself trigger dereference.** A fetch happens only by
explicit host policy or explicit host-mediated action (a user asks; a code-execution
script asks the host's fetcher; host policy pre-fetches a class it has decided to trust to
a bounded store). Every server-supplied field is testimony at a security boundary; the
digest check happens after bytes arrive and protects integrity, not resources.

A conformant host fetcher:

1. **Allowlists schemes** — `https` by default; anything else (notably `file`, `ftp`,
   link-local and internal-network targets) is refused unless host policy names it.
   Fail closed (vector 11).
2. **Allowlists origins** per §6.1's binding rule, and **bounds redirects**: a fixed small
   hop limit, credentials stripped on any cross-origin hop, or redirect traversal refused
   outright (vector 12).
3. **Streams with a hard actual-byte ceiling** from host policy, aborting the transfer the
   moment real octets exceed it — regardless of `sizeBytes`, which a mistaken or malicious
   server can understate (vector 10). Declared size never allocates resources; at most it
   *denies* early (a claim already over the ceiling is refused without a fetch, vector 4).
4. **Verifies before presenting**: where `digest` is present, a fetched payload whose
   octets do not match MUST NOT be presented as the described content (vector 5).
   `mimeType` is verified or sniffed where anything safety- or compatibility-relevant
   depends on it (vector 13).

### 7.3 Storage naming

When a host materializes a fetched payload, **the host generates the storage path and
filename** — from the reference record (e.g. the reference id plus an extension derived
from the *verified* media type) — and the server-supplied `name` is never a path
component, sanitized or otherwise. Basename-sanitizing a hostile string still leaves
collisions, reserved/device names, control characters, and bidi/homoglyph surprises;
generating the name leaves nothing. The display label, if kept alongside, is stripped of
control and bidi-override characters and bounded per §5 (vectors 14, 18).

### 7.4 Lifetime

`expiresAt` is advisory. A fetch after expiry failing is an ordinary error, not a protocol
violation. An unparseable `expiresAt` fails closed — the reference is treated as already
expired, never as immortal. Servers SHOULD keep references valid for a window they state
(in the field or in tool documentation); nothing here creates a retention obligation, a
garbage-collection protocol, or a way to ask for an extension.

---

## 8. Schema (amends Appendix B.1)

The `resource` variant of `ContentBlock` is replaced by:

```jsonc
{
  "type": "object",
  "required": ["type", "uri"],
  "properties": {
    "type": { "const": "resource" },
    "uri": { "type": "string", "maxLength": 4096 },
    "mimeType": { "type": "string", "maxLength": 255 },
    "sizeBytes": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
    "digest": { "type": "string", "pattern": "^sha256:[A-Za-z0-9_-]{43}$" },
    "expiresAt": { "type": "string", "maxLength": 64 },
    "name": { "type": "string", "maxLength": 255 },
    "disposition": { "enum": ["never", "ref"] }
  }
}
```

The maxima are emitter conformance bounds, and they are the *outer* fence, not the
guarantee: the guarantee is host-side (§5) — every server-supplied string is truncated to
host display bounds before stub/wake assembly, so a nonconforming emitter still cannot
move mass into metadata (vector 17).

**One invalid-field rule** for every optional property: a value that violates its schema
constraint is rejected **as a field** and treated as absent; the block remains valid, and
a subtractive `disposition` remains in force. Field invalidity never widens exposure —
there is no reading of a malformed `sizeBytes` under which the payload becomes
context-eligible (vector 15). (`uri` is the one required property; a block whose `uri`
violates the schema is rejected whole.)

The `image` and `audio` variants gain the same six optional properties **on their
`uri`-form branch only**; their existing `oneOf` (which already rejects a block carrying
both `data` and `uri`) is retained, and `disposition` is added only to the `uri` branch,
so `disposition` alongside inline `data` is schema-invalid. The `text` variant is
unchanged and carries no `disposition` — a text block *is* context-sized by construction,
and revision 1's generic annotation on it had no defined meaning.

Field placement: revision 1 put the disposition inside a generic `annotations` object.
MCP already defines an `annotations` vocabulary on content blocks (`audience`,
`priority`, …); colliding with it, or with `_meta`, buys nothing. `disposition` is a
top-level property of the block variants that can carry it, and the schema — not prose —
says which those are.

### 8.1 MCP interoperability

MCP's own vocabulary has a nested `EmbeddedResource` (inline content — under this RFC an
ordinary inline block, nothing new) and a distinct `ResourceLink`. MCPL keeps its direct
`resource: {uri}` shape; a host or bridge translating MCP→MCPL maps a `ResourceLink` onto
this testimony record field-for-field (`uri`→`uri`, `name`→`name`, `mimeType`→`mimeType`,
`size`→`sizeBytes`, `annotations` dropped or host-mapped) with no `disposition` — absent
testimony, host default policy, exactly as for any unannotated reference. There is one
reference vocabulary here, not two; `ResourceLink` is an import path into it.

Handling rules the schema cannot express:

- An emitter that sends inline `data` purporting bulk disposition through any
  channel the schema misses is nonconformant; the receiving host still **fails closed**
  (withholds the `data` from context, MAY log) (vector 2).
- Unknown additional properties on content blocks are ignored (today's behavior), which is
  also the pre-RFC-005 degradation story: an annotated block parses everywhere as an
  ordinary §10.3 block, and the only loss is the courtesy (vector 7).

---

## 9. No New Capability

Emitting a reference block inside a message the server was already authorized to send adds
no authority: the block moves strictly less into context than the same bytes inlined would
have, and §6/§7 give the server no new reach into the host. There is therefore no `uses`
entry, no grant, and nothing for RFC-002 to gate. Conversely, nothing here bypasses
RFC-002: a server that cannot push cannot push a reference either. There is no manifest
touch in revision 3: declared reference origins are deferred with the rest of cross-origin
authentication (§10).

---

## 10. What This Deliberately Is Not

- **Not a blob store.** MCPL moves no payload bytes under this RFC; it moves descriptions.
- **Not handle interchange.** The powerful version — an opaque handle minted by one
  server, passed by the agent to another, bytes streamed host-side between them — is real
  and deliberately deferred; the §5 reference id is host-local naming and expressly *not*
  that handle. If the reference pattern keeps being bent toward interchange in practice,
  that is the evidence a future RFC should be built on. (Same posture as RFC-004 §9's
  deferral of mobility.)
- **Not a host→server delivery contract.** §4's deferral: recipient-delivery semantics
  for `channels/publish` attachments deserve their own document.
- **Not authenticated cross-origin fetching.** Declared reference origins — the manifest
  field, canonical origin grammar, host matching rule, auth binding per transport, and
  redirect relation — are deferred (§6.1). Revision 3 authenticates exactly one origin:
  the one the connection was dialed to. A server whose references live elsewhere serves
  them unauthenticated or waits for that RFC.
- **Not a transport mandate, and not compression, chunking, ranges, or resumption.** HTTP
  has all four.

---

## 11. Conformance Vectors

**Acceptance criterion:** before this RFC moves Draft→Accepted, these vectors freeze as
executable vectors (the RFC-003 §3.1 precedent: `conformance/`) run against at least one
strict schema/parser implementation and one host-treatment implementation.

| # | Input | Expected |
|---|---|---|
| 1 | `resource` block, `disposition:"never"`, host assembles context | At most a §5 stub appears; neither payload bytes nor `uri` appear model-visible |
| 2 | Inline `data` presented with bulk disposition through any gap in schema enforcement | Emitter nonconformant; host fails closed — `data` withheld, MAY log |
| 3 | `disposition:"ref"`, verified payload within host inline policy | Host MAY inline; stub otherwise. No violation either way |
| 4 | `sizeBytes` claim exceeds host ceiling | Host refuses the fetch without dialing; stub unaffected |
| 5 | Fetched octets' digest ≠ `digest` | Host MUST NOT present them as the described content |
| 6 | `uri` containing an embedded credential from the emitting server | Emitter nonconformant (§6.1); host MAY refuse to dereference |
| 7 | Reference block on a pre-RFC-005 host | Parses as ordinary §10.3 content; degradation limited to lost courtesy |
| 8 | Push event: one text block + one `"never"` reference | Wake carries the text and a stub; wake size independent of `sizeBytes` |
| 9 | Reference whose `uri` is a signed/query-capability URL | Stub shows reference id, `name`, type, size. Under `never`: URI absent unconditionally. Under `ref`/absent disposition: URI absent unless explicit host policy includes it |
| 10 | Stream exceeds claimed `sizeBytes` and continues | Fetcher aborts at the host's actual-byte ceiling; partial bytes are not presented |
| 11 | `uri` scheme `file:` (or other non-allowlisted) | Fetch refused; fail closed |
| 12 | Fetch redirects cross-origin | Credentials stripped at minimum; traversal MAY be refused; bound hop limit either way |
| 13 | Fetched content sniffs as a different media type than `mimeType` | Host treats `mimeType` as false testimony where anything depends on it; record stores the observed type |
| 14 | `name` of `"../../.ssh/authorized_keys"` | Storage path/filename host-generated from the record (§7.3); the string appears at most as a bounded, sanitized display label |
| 15 | `sizeBytes` of `-1`, `3.5`, or `2^53` | Field rejected, treated as absent; block remains valid; a `"never"` disposition remains in force; value never used in arithmetic |
| 16 | Unparseable `expiresAt` | Treated as already expired (fail closed), never as immortal |
| 17 | `name` (or `mimeType`) of 1 MB, past schema maxima | Emitter nonconformant; host truncates to display bounds before stub/wake assembly — wake size unchanged |
| 18 | `name` containing control characters, bidi overrides, or a reserved device name | Storage unaffected (host-generated name); display label stripped of control/bidi characters |
| 19 | Payload served with `Content-Encoding: gzip` | `sizeBytes` and `digest` describe the *decoded* identity octets; fetcher verifies against those, and the streaming ceiling applies to decoded bytes |
| 20 | Lookup of an evicted or unknown reference id | Defined "unknown reference" error; the id never resolves to a different record within the session |

### Running and consuming the executable vectors

The executable corpus is [`conformance/bulk-reference-vectors.json`](./conformance/bulk-reference-vectors.json). Its 43 cases cover the 20 numbered rows above, media/size/disposition variants, schema boundaries, and the invalid-optional-field rule. The expected values come from this RFC and SPEC §19, not from the implementation under test. The runner reports strict emitter-schema validation and receiving-Host treatment separately.

Run from the MCPL repository root with Bun. Install the external Host in an isolated checkout and Ajv in a temporary directory:

```sh
FRAMEWORK="$(mktemp -d)"
git clone https://github.com/anima-research/agent-framework.git "$FRAMEWORK"
git -C "$FRAMEWORK" checkout --detach 03c31d9b4224f3eb4195a6a1b1126c47b5fb39bc
(cd "$FRAMEWORK" && bun install --ignore-scripts)
AJV_DIR="$(mktemp -d)"
bun add --cwd "$AJV_DIR" --exact --ignore-scripts ajv@8.17.1
bun test conformance/bulk-reference-runner.test.mjs
bun run conformance/check-bulk-references.mjs \
  --framework "$FRAMEWORK" \
  --ajv "$AJV_DIR/node_modules/ajv/dist/ajv.js" \
  --report /tmp/bulk-reference-report.json
```

The measured baseline is **43/43 schema expectations and 40/43 Host expectations**, with exit status **1**. Agent Framework at the pinned revision truncates overlong `name`, `mimeType`, and `expiresAt` values into retained testimony instead of rejecting those optional fields as §8 requires. The three `field-rule-*` cases report these failures. The separate vector-17 display-bound checks pass. A receiver can satisfy the display bound by dropping an invalid optional field; the corpus does not require that field to survive as a truncated label.

The runner uses Ajv 8.17.1 on Appendix B.1 extracted directly from `SPEC.md`. Ajv strict mode is enabled; `strictRequired: false` permits the specification's nested `required` branches without requiring local duplicate property declarations. Unknown additional properties remain allowed by the schema. A negative schema expectation passing means the emitter's block was rejected, not that the block is conformant. The Host still receives the original input so invalid optional fields and inline-data contradictions exercise its defensive handling.

The supplied adapter imports Agent Framework's actual classifier, `PushHandler`, tool-history serializer, registry, `ReferenceFetcher`, and `fetch_reference` dispatch method. Push observations include the text passed to the wake-policy callback and the content queued by `PushHandler`. Fetch fixtures use live loopback HTTP: gzip decoding runs in the runtime's real fetch stack, the continuing-stream fixture records early connection closure, and a second origin observes redirect traversal and credentials. Storage is an in-memory capture of the fetcher's save callback. Unknown/evicted-id tests execute the actual tool dispatch with event and trace sinks supplied by the fixture.

This is component-boundary evidence, not a running residence or a model-provider integration test. It covers push content and persisted tool history; it does not claim full injection/channel delivery coverage. Vector 7 validates the unchanged annotated block against the pre-RFC-005 Appendix B.1 schema captured in `bulk-reference-legacy-schema.json` at MCPL `f684cae937bdaf3e8cd200c82673db217e63f652`, rather than running a historical Host. Vector 6 pins a known embedded-credential fixture's emitter nonconformance separately from schema acceptance: JSON Schema cannot identify arbitrary bearer capabilities. These distinctions remain part of the evidence for the acceptance decision.

#### Vector and adapter contract

Consume the JSON cases rather than copying their inputs. Each case has a stable `id`, its RFC row number in `rfc`, `blocks`, per-block `schemaValid` booleans, an `operation`, and Host expectations in `expect`. Expand `{"$repeat":"x","count":1048576}` into the specified string and replace `$ORIGIN` with the fixture origin. This keeps megabyte inputs portable without committing megabyte files.

The operations are:

- `render`: classify the original blocks and observe push content, wake-policy text, and tool-history text. Rendering alone must make zero requests.
- `fetch`: observe rendering before and after an explicit Host-mediated fetch. `maxBytes` is the fixture's actual-byte ceiling. `response.bodyBase64` names identity octets; `gzip: true` compresses them on the wire. `stream` specifies chunk count, chunk bytes, and interval milliseconds. `redirect: true` points to the second loopback origin.
- `registry`: register the first reference twice, force eviction through `registrations` distinct records, then register the first URI again and look up its old id plus an unknown id. The supplied Host's registry quota is 2,000; the fixture registers 2,100 records to cross it. A port needs a bounded test registry for this operation.

To run another implementation with the same JavaScript assertions, pass `--adapter /path/to/adapter.mjs`. Export `createAdapter(root)`, returning `identity`, a positive `maxViewChars` policy bound, `displayProfile`, and `observe(case, {origin, token})`. The profile gives `fieldChars` limits for `name` and `mimeType`, plus the renderer’s nonempty `truncationMarkers`. The two `displayField` cases require a mark only when the original field exceeds that profile’s limit. A renderer with a 255-character limit can keep the entire 255-character value; another renderer can use `[truncated]` instead of an ellipsis. These are profile assertions, not protocol-wide typography or truncation thresholds. The supplied adapter documents the observation shape in code. Report actual parsing, model-facing strings, private reference records, fetch outcomes, save callbacks, and lookup errors; keep expected-value comparisons in the runner. `maxViewChars`, the registry quota, origin-only fetch policy, and id-based filenames describe the tested Host profile, not protocol-wide constants. Other language implementations can consume the same fixtures and expected properties directly.

The harness regression tests deliberately perturb observations to check that URI/payload leaks, unbounded displays, receipt-triggered fetches, retained invalid fields, model-visible mismatched payloads, per-lane control/bidi leaks, saved partial bytes, forwarded credentials, missed stream aborts, and id reuse produce failures. The conformance command records source hashes, the MCPL and Host revisions, the runtime, Ajv version, and resolved Framework package versions. Its exit status is nonzero for any schema or Host expectation failure; setup failures also exit nonzero. Maintainers decide RFC acceptance from this evidence; adding or running the corpus does not change Draft status.

---

## 12. Migration Sketch (the motivating case)

vst-mcpl today, inside a `text` block:

```jsonc
{ "path": "/Users/mythos/render/vst_out/chord.wav", "peak": 0.605,
  "download_url": "https://…/files?path=…", "download_note": "append &token=<your token> to fetch" }
```

Under revision 2, the same result:

```jsonc
"content": [
  { "type": "text", "text": "{\"path\":\"…\",\"peak\":0.605,\"rms\":0.18,\"render_ms\":676}" },
  { "type": "resource",
    "uri": "https://mythoss-mac-mini.tail01efee.ts.net/files?path=%2F…%2Fchord.wav",
    "mimeType": "audio/wav", "sizeBytes": 4233704, "name": "chord.wav",
    "disposition": "never" }
]
```

`download_note` disappears because §6.1 makes credential handling the host's business; the
model sees `ref_… chord.wav (audio/wav, ~4.2MB, from tool vst_render)`; and the host can
fetch (origin-bound, ceiling-bounded, digest-checked), stage, or hand the wav to a
code-execution script as a path — none of which it could do with prose, and none of which
puts a URI or a token anywhere a model could quote it.
