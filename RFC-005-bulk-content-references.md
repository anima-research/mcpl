# MCPL RFC-005: Bulk Content References

**Status:** Draft (revision 2)
**Targets:** MCPL Protocol Specification 0.5
**Authors:** Claude Code, from a scope proposed by antra; revised after review
**Date:** 2026-08-31 (revision 1); 2026-09-01 (revision 2)
**Depends on:** nothing for authority — RFC-002 / SPEC §5.4 remains the sole source of what a
connected server may do, and this RFC adds no capability path (§9). Amends the SPEC §10.3 /
Appendix B.1 content-block shapes (§8); reuses the RFC-003 digest encoding.

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
  "digest": "sha256:Zm9vYmFyLWV4YW1wbGUtZGlnZXN0LWJhc2U2NHVybA",
  "expiresAt": "2026-09-07T00:00:00Z",
  "name": "family_chord_cs80.wav",
  "disposition": "never"
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `uri` | `string` | Yes | Where the server serves the payload. `https` expected; the *host* decides what it will ever dereference (§7). |
| `mimeType` | `string` | SHOULD | Claimed media type. Testimony — verify or sniff where safety or provider compatibility depends on it; a digest authenticates bytes, not type. |
| `sizeBytes` | `integer` | SHOULD | Claimed payload size: a non-negative integer within the JSON-safe range (0 ≤ n ≤ 2^53−1). Consumers MUST reject fractional, negative, or unsafe values (§8). Testimony — real fetch limits run on actual bytes (§7). |
| `digest` | `string` | MAY | `sha256:` + base64url, the RFC-003 *encoding*; the hash is SHA-256 over the exact payload octets — the representation with **no content coding applied**. `sizeBytes` and `digest` MUST describe the same octet sequence. |
| `expiresAt` | `string` (ISO-8601) | MAY | Advisory availability horizon. An unparseable value fails closed: consumers treat the reference as already expired, never as immortal (§7.4). |
| `name` | `string` | MAY | Display label. A label, never a path: sanitize before any filesystem use (§7.3). |
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

**The raw `uri` is not part of the stub by default.** Signed URLs and query capabilities
are bearer credentials that look like locations; putting them in context recreates in one
field the leak §6 closes in another. A host MAY include the URI where its policy
classifies the reference as non-capability-bearing (for example: an origin-bound URI that
is unusable without the host-private auth context — precisely what §6.1's no-embedded-
credential rule produces). The safe default is the opaque id. `disposition: "never"`
limits **payload and access-capability exposure both** (vector 9).

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
- to an origin **bound to the authenticated server connection**: the origin the connection
  itself was dialed to, or a reference origin the server declared in its manifest and the
  host's policy accepted. An arbitrary URI in a content block binds nothing.

Authentication context is **never forwarded cross-origin**: on any redirect that leaves
the bound origin, credentials are stripped, and a host MAY simply refuse redirect
traversal entirely (§7.2). References to third-party locations (a public CDN, another
archipelago service) are fetched **without** the server's authentication context; that
location's own auth applies and is out of scope.

Servers MUST accept their own connection's authentication context on their reference
endpoints, and MUST NOT mint per-reference bearer credentials into the `uri` itself. A URI
with an embedded credential is a capability that looks like a location; it gets pasted
into channels, logged by proxies, and quoted in stubs. (Not theory: the first ad-hoc
implementation shipped a `download_note: "append your token"` — the app-level pattern this
rule exists to retire.)

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

### 7.3 Filesystem hygiene

`name` is a display label. Before any filesystem use it is sanitized to a basename — no
separators, no traversal, no reliance on the server's goodwill (vector 14).

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
    "uri": { "type": "string" },
    "mimeType": { "type": "string" },
    "sizeBytes": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
    "digest": { "type": "string", "pattern": "^sha256:[A-Za-z0-9_-]{43}$" },
    "expiresAt": { "type": "string" },
    "name": { "type": "string" },
    "disposition": { "enum": ["never", "ref"] }
  }
}
```

The `image` and `audio` variants gain the same seven optional properties **on their
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
RFC-002: a server that cannot push cannot push a reference either. The one manifest touch
is optional and restrictive: a server MAY declare reference origins (§6.1) for hosts that
require origin pre-binding stricter than the connection origin.

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
- **Not a transport mandate, and not compression, chunking, ranges, or resumption.** HTTP
  has all four.

---

## 11. Conformance Vectors

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
| 9 | Reference whose `uri` is a signed/query-capability URL | Stub shows reference id, `name`, type, size — never the URI, under any disposition, absent explicit host policy |
| 10 | Stream exceeds claimed `sizeBytes` and continues | Fetcher aborts at the host's actual-byte ceiling; partial bytes are not presented |
| 11 | `uri` scheme `file:` (or other non-allowlisted) | Fetch refused; fail closed |
| 12 | Fetch redirects cross-origin | Credentials stripped at minimum; traversal MAY be refused; bound hop limit either way |
| 13 | Fetched content sniffs as a different media type than `mimeType` | Host treats `mimeType` as false testimony where anything depends on it; record stores the observed type |
| 14 | `name` of `"../../.ssh/authorized_keys"` | Sanitized to a basename before any filesystem use |
| 15 | `sizeBytes` of `-1`, `3.5`, or `2^53` | Schema-invalid; block rejected or field ignored per host policy, never used in arithmetic |
| 16 | Unparseable `expiresAt` | Treated as already expired (fail closed), never as immortal |

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
