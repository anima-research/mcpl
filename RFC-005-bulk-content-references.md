# MCPL RFC-005: Bulk Content References

**Status:** Draft (revision 1)
**Targets:** MCPL Protocol Specification 0.5
**Authors:** Claude Code, from a scope proposed by antra
**Date:** 2026-08-31
**Depends on:** nothing for authority — RFC-002 / SPEC §5.4 remains the sole source of what a
connected server may do, and this RFC adds no capability path (§8). Builds on the SPEC §10.3
content-block shapes; reuses the RFC-003 digest format.

> **Evidence base.** This RFC was written the day the problem was hit, not anticipated:
> vst-mcpl (a render server whose tool results reference multi-megabyte wav files on a
> machine its callers cannot shell into) had to invent `download_url` / `download_note`
> fields inside a `text` block — invisible to the protocol, unactionable by hosts, and
> guaranteed to be re-invented under different names by the next server that renders,
> records, exports, or transcodes anything. The pattern (results that *are* small metadata
> *about* something large) is general; the field zoo is the avoidable part.

---

## 1. Summary

Content blocks flow to model context — that is what they are for. But some tool results,
push events, and channel messages are best understood as **small testimony about large
payloads**: a rendered wav, a captured image, a dataset, a log archive. Today a server has
two bad options: inline the payload as base64 (a context bomb the host cannot refuse until
it has already parsed it) or ship an ad-hoc URL in prose (which no host can treat
uniformly).

This RFC adds three small things and no storage system:

1. **Reference metadata** on the existing `resource` content block — `mimeType`,
   `sizeBytes`, `digest`, `expiresAt`, `name` — so a host can have a policy about a
   reference without fetching it (§3).
2. **A `context` annotation** on any content block — `"never" | "ref" | "inline-ok"` — by
   which the server testifies how the block relates to context, and the **host decides**
   what actually happens (§4, §5).
3. **A credential rule** for fetching references, because the ad-hoc versions of this keep
   facing the same trap and resolving it by taste (§6).

The division of labor is the one MCPL already runs on: the server describes, the host
disposes. An annotation is never authority (compare RFC-001 §7 — tags are never authority);
it is a machine-readable version of the sentence "this is 50 MB of audio, here is where it
lives," addressed to a host that until now could not be told.

---

## 2. Motivation

Three concrete pressures, all observed:

- **Tool results.** A render server's result is `{path, peak, rms, duration}` plus the
  audio. The metadata belongs in context; the audio never does. Without a spec shape, the
  server smuggles a URL through prose and every host treats it as prose.
- **Push events.** SPEC §9 is the one lane where the server chooses what enters context
  *unilaterally* — there is no tool-call moment where the host could intervene on size. An
  async-completion wake that inlines its result is fine at 200 bytes of JSON and a disaster
  the day someone attaches a preview render. The annotation is the only mechanism that
  keeps the wake cheap while still delivering the result (§7).
- **Code execution.** Hosts that run programmatic tool calling already keep tool results
  out of context by interception — but they cannot distinguish "large field the script
  should get as a file path" from "large field that is simply a long string" without a
  marker. §5 gives runtimes the marker.

What is deliberately *not* motivating this RFC: a desire for MCPL to move bytes. It moves
none (§9).

---

## 3. The Reference Block

No new content type. The §10.3 `resource` block gains optional metadata, and the media
blocks (`image`, `audio`) in `uri` form MAY carry the same fields:

```jsonc
{
  "type": "resource",
  "uri": "https://mythoss-mac-mini.tail01efee.ts.net/files?path=%2F…%2Fchord.wav",
  "mimeType": "audio/wav",
  "sizeBytes": 4233704,
  "digest": "sha256:Zm9vYmFyLWV4YW1wbGUtZGlnZXN0LWJhc2U2NHVybA",   // RFC-003 format
  "expiresAt": "2026-09-07T00:00:00Z",
  "name": "family_chord_cs80.wav",
  "annotations": { "context": "never" }
}
```

| Field | Type | Required | Meaning |
|---|---|---|---|
| `uri` | `string` | Yes | Where the payload lives. Any scheme; `https` expected in practice. |
| `mimeType` | `string` | SHOULD | What it is. |
| `sizeBytes` | `number` | SHOULD | How big it is — the field host size policy runs on. |
| `digest` | `string` | MAY | `sha256:` + base64url(SHA-256(payload)), the RFC-003 encoding. Lets a fetching host verify it got what was described. |
| `expiresAt` | `string` (ISO-8601) | MAY | Advisory availability horizon (§6.3). |
| `name` | `string` | MAY | Human/stub-friendly filename. |

A reference with neither `mimeType` nor `sizeBytes` is legal but self-defeating: it denies
the host the two facts every disposition policy needs. Conformant emitters SHOULD treat
both as required in spirit.

### 3.1 Rejected: a new `blob` type

A distinct type would fork every consumer's content-block switch for zero expressive gain.
The `resource` block already means "URI reference"; what it lacked was enough metadata to
have a policy about, and that is additive.

---

## 4. The `context` Annotation

Any content block MAY carry:

```jsonc
"annotations": { "context": "never" | "ref" | "inline-ok" }
```

| Value | Server's testimony |
|---|---|
| `"never"` | The payload must not reach model context. Only a stub (§4.1) may represent it. |
| `"ref"` | Context should see the reference, not the payload. A host MAY inline anyway when the payload is trivially small and policy allows. |
| `"inline-ok"` | The server considers the payload context-sized. This is information, not permission — the host's size policy still applies. |
| *(absent)* | No testimony. Host default policy applies (for inline `data` blocks, that is today's behavior, unchanged). |

The annotation is testimony, never authority, in both directions: `"never"` binds the host
(it is the one MUST in this RFC, §5), while `"inline-ok"` binds nobody. A server cannot
talk its payload into context; it can only stop pretending the payload is context-sized.

### 4.1 The stub

Where a block is withheld from context, the host represents it as at most: `name`, `uri`,
`mimeType`, `sizeBytes`, and one line of provenance ("from tool vst_render" /
"attachment on push event …"). A stub is a pointer the model can act on — pass to a tool,
mention to a user, fetch through code execution — without carrying the payload. Hosts
SHOULD render stubs uniformly so models learn one shape.

---

## 5. Host Treatment

The host MUST honor `"never"`: model-visible content derived from such a block is limited
to the §4.1 stub. Everything else is host policy, and the RFC deliberately enumerates
options rather than mandating one:

- **Drop** the block entirely (conformant; the stub is a ceiling, not a floor).
- **Stub** it into context (§4.1) — the expected default.
- **Fetch on behalf**, using the connection's credential (§6), to local storage — then
  surface the local path in the stub, hand it to an attachment pipeline, or both.
- **Expose to code execution**: runtimes that intercept tool results SHOULD surface a
  referenced payload as a file path or lazy handle in the script's namespace rather than
  as an inline string. This is the marker such runtimes currently lack (§2).
- **Inline**, only where the annotation permits it and the payload is within the host's
  own size policy.

A host that understands none of this and shows the model the raw block JSON is degraded
but not broken — the block is small; that is the point. The failure mode this RFC removes
is the *payload* in context, and that only ever happens via inline `data`, which
`"never"`-annotated blocks do not carry.

---

## 6. Credentials, Lifetime, Integrity

### 6.1 Fetch credential

When a host (or its code-execution runtime, or its user) dereferences a `uri` from a
server, it authenticates **with the credential of the connection that delivered the
block** — the same token that opened the session. Servers MUST accept their own session
credential on their reference endpoints, and MUST NOT mint per-reference bearer tokens
into the `uri` itself. A URI with an embedded credential is a capability that looks like a
location; it gets pasted into channels, logged by proxies, and quoted in stubs. (This is
not theory: the first ad-hoc implementation shipped a `download_note: "append your
token"` for exactly this reason. The rule belongs in spec text, not per-server taste.)

References to *third-party* locations (a public CDN, another archipelago service) are out
of scope: the URI names the location, and that location's own auth applies.

### 6.2 Integrity

A host that fetches SHOULD verify `digest` when present and MUST NOT present
digest-mismatched content as the described content.

### 6.3 Lifetime

`expiresAt` is advisory. A fetch after expiry failing is an ordinary error, not a protocol
violation. Servers SHOULD keep references valid for a window they state (in the field, or
in tool documentation); nothing here creates a retention obligation, a garbage-collection
protocol, or a way to ask for an extension. A server that recycles storage aggressively
should say so where the tool is documented.

---

## 7. Where Reference Blocks May Appear

Everywhere `ContentBlock[]` already flows: **tool results** (`tools/call`), **push events**
(`push/event` `payload.content` — SPEC §9.2), **channel messages** (`channels/incoming`,
`channels/publish`), and **injections** (SPEC §10). Two call-outs:

- **Push events** are the priority case: the unilateral lane (§2). Hosts MUST apply §5
  *before* wake-text assembly, so an annotated attachment can never inflate the cost of
  the wake that announces it.
- **Host→server directions** (`channels/publish`, tool *arguments*) may carry references
  symmetrically; the credential rule inverts (the server dereferences with the same
  session's standing). This RFC blesses the shape there but specifies host-side
  obligations only; server-side fetch policy is the server's business.

---

## 8. No New Capability

Emitting an annotated block inside a message the server was already authorized to send
adds no authority: the block moves less into context than the same bytes inlined would
have. There is therefore no `uses` entry, no grant, and nothing for RFC-002 to gate.
Conversely, nothing here bypasses RFC-002: a server that cannot push cannot push a
reference either.

---

## 9. What This Deliberately Is Not

- **Not a blob store.** MCPL moves no payload bytes under this RFC; it moves descriptions.
- **Not handle interchange.** The powerful version — an opaque handle minted by one server,
  passed by the agent to another, bytes streamed host-side between them — is real and
  deliberately deferred. It drags storage semantics, GC, and cross-server trust into a
  messaging spec. If the reference pattern keeps being bent toward it in practice, that is
  the evidence a future RFC should be built on. (Same posture as RFC-004 §9's deferral of
  mobility.)
- **Not a transport mandate.** `uri` is a URI. `https` is expected, nothing is required.
- **Not compression, chunking, ranges, or resumption.** HTTP has all four.

---

## 10. Conformance Vectors

| # | Input | Expected |
|---|---|---|
| 1 | `resource` block, `context:"never"`, host assembles context | At most a §4.1 stub appears; payload bytes appear nowhere model-visible |
| 2 | `audio` block with inline `data` and `context:"never"` | Contradiction: emitter nonconformant. Host treats as `"never"` (withholds `data`), MAY log |
| 3 | `context:"inline-ok"`, `sizeBytes` over host's inline ceiling | Host stubs; no violation by either side |
| 4 | Reference with no `sizeBytes`, host policy is size-keyed | Host MAY treat size as unbounded (i.e., stub or drop) |
| 5 | Fetched payload's digest ≠ `digest` | Host MUST NOT present it as the described content |
| 6 | `uri` containing `token=` query credential from the emitting server | Emitter nonconformant (§6.1); host MAY refuse to dereference |
| 7 | Annotated block on a pre-RFC-005 host | Block parses as ordinary §10.3 content; nothing breaks (annotation ignored — degraded, §5) |
| 8 | Push event whose `payload.content` is one text block + one `"never"` reference | Wake carries the text and a stub; wake size independent of `sizeBytes` |

---

## 11. Migration Sketch (the motivating case)

vst-mcpl today, inside a `text` block:

```jsonc
{ "path": "/Users/mythos/render/vst_out/chord.wav", "peak": 0.605,
  "download_url": "https://…/files?path=…", "download_note": "append &token=<your token> to fetch" }
```

Under this RFC, the same result:

```jsonc
"content": [
  { "type": "text", "text": "{\"path\":\"…\",\"peak\":0.605,\"rms\":0.18,\"render_ms\":676}" },
  { "type": "resource",
    "uri": "https://mythoss-mac-mini.tail01efee.ts.net/files?path=%2F…%2Fchord.wav",
    "mimeType": "audio/wav", "sizeBytes": 4233704, "name": "chord.wav",
    "annotations": { "context": "never" } }
]
```

`download_note` disappears because §6.1 makes it the rule; the host can now fetch, stage,
stub, or hand the wav to a code-execution script as a path — none of which it could do
with prose.
