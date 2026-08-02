# RFC-003 §3.1 canonical manifest digest — conformance vectors

This directory freezes the interoperability vectors for

```
revision = "sha256:" + base64url_unpadded( SHA-256( JCS( manifest_without_revision ) ) )
```

as defined in [RFC-003 §3.1](../RFC-003-manifest-changes.md). It exists so that
`mcpl-core-ts` and `Anarchid/mcpl-core`, implemented independently and unable to
see each other's work, converge on one digest rather than two.

| File | What it is |
|---|---|
| [`manifest-digest-vectors.json`](./manifest-digest-vectors.json) | The vectors. This is the artifact. |
| [`CONSUMING.md`](./CONSUMING.md) | How to wire the vectors into a test suite. Read this first if you are implementing. |
| [`generate_vectors.py`](./generate_vectors.py) | Generator and reference implementation, stdlib only. Non-normative. |
| [`crosscheck.mjs`](./crosscheck.mjs) | Independent Node verifier, sharing no code with the generator. Non-normative. |
| `README.md` | This file: how each digest was derived and checked, and what the RFC does not settle. |

Twenty manifest vectors (fifteen positive, five negative) and four comparator
vectors.

---

## 1. The RFC's own vector reproduces

**This was the first thing checked, because everything else is downstream of
it.** RFC-003 §3.1 supplies one worked vector. It is correct.

```console
$ printf '%s' '{"channels":{"incoming":true,"publish":true,"register":true},"contextHooks":{"beforeInference":true},"featureSets":{"demo.messaging":{"description":"Demo","uses":["channels.incoming","channels.publish","pushEvents","tools"]}},"inferenceLifecycle":true,"pushEvents":true,"version":"0.5"}' | shasum -a 256
fd86534b4875b6a4c031923a784942b3349013658dc77c610219a052f348f47e  -

$ printf '%s' '{"channels":...}' | openssl dgst -binary -sha256 | base64 | tr '+/' '-_' | tr -d '='
_YZTS0h1tqTAMZI6eElCszSQE2WNx3xhAhmgUvNI9H4
```

RFC expects `sha256:_YZTS0h1tqTAMZI6eElCszSQE2WNx3xhAhmgUvNI9H4`. **Match.**

The RFC's un-canonicalized manifest also canonicalizes to the RFC's canonical
string — checked separately, so both halves of the worked example are verified,
not just the hash of the pre-canonicalized text. That check is `vector 0` in the
file and the generator refuses to emit anything if it fails.

## 2. How every other digest was derived and checked

No digest in the file is predicted. Each one was computed and then confirmed by
**three implementations that share no code**:

1. **Python** — `generate_vectors.py`, using `hashlib`, with JCS written from
   RFC 8785 directly (ECMAScript `Number::toString` reimplemented from the ES6
   algorithm, member names sorted on UTF-16BE bytes, ES6 string escape set).
2. **Node 20** — a separate cross-check script that builds JCS the opposite way:
   it recursively sorts keys and hands the result to JavaScript's own
   `JSON.stringify`, which *is* the serializer RFC 8785 §3.2.2 defers to for
   strings and numbers. `crypto` for the hash, `Buffer.toString('base64url')`
   for the encoding. Independent JCS, independent SHA-256, independent base64url.
3. **The shell** — `openssl dgst -sha256` / `shasum -a 256` over the canonical
   bytes written to disk, so the encoding step (`canonicalJson` → UTF-8 bytes) is
   exercised by a tool with no knowledge of the vectors at all.

All three agree on all fifteen positive vectors:

```console
$ node conformance/crosscheck.mjs
  (note) utf8-vs-utf16-divergence-above-bmp: default JS sort() DIVERGES -> ["z","𐀀","🙂","�","￿"]
NODE CROSS-CHECK OK (19 checks)

$ for f in canon/*.bin; do openssl dgst -binary -sha256 "$f" | openssl base64 -A | tr '+/' '-_' | tr -d '='; done
   # 15/15 match the file
```

Two independent sanity anchors fell out of this:

- `empty-manifest` canonicalizes to `{}` and digests to
  `sha256:RBNvo1WzZ4oRRq0W9-hknpT7T8If536DEMBg9hyq_4o`, whose hex is
  `44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a` — the
  widely published SHA-256 of the two-byte string `{}`.
- Vectors 0, 1 and 2 are three different input manifests that MUST collapse to
  one digest. They do.

Re-verify at any time:

```console
$ python3 conformance/generate_vectors.py --check
OK: 20 vectors, 4 sort vectors; RFC-003 worked example reproduces
```

`--check` re-parses the file from disk and recomputes each `digest` and
`sha256Hex` from the stored `canonicalJson`, so it is not merely the generator
agreeing with itself.

## 3. What each vector is for

### Reproduction and invariance

| Vector | Pins |
|---|---|
| `rfc-003-worked-example` | The RFC's own vector, byte for byte. |
| `key-ordering-and-set-ordering-independence` | Members supplied in a different order, `uses` reversed, one duplicate `uses` entry. Same digest as vector 0. JCS member sorting, set sorting and deduplication are all exercised at once, and none of them alone gets there. |
| `revision-present-is-stripped` | `revision` supplied with a **deliberately wrong** value. Same digest as vector 0. The digest never covers itself, and the supplied value cannot influence it. |
| `revision-only-stripped-at-root` | A *nested* member named `revision` is ordinary content and IS hashed. RFC-003 strips the manifest's `revision`, not every member of that name. Recursive stripping produces a different digest here. |

### Shape edges

| Vector | Pins |
|---|---|
| `empty-manifest` | `{}`. Not a valid manifest; the digest function must still be total, because a host recomputes the digest of whatever it fetched *before* deciding anything (RFC-003 §6.6: rejection is diagnostics, not authorization). |
| `minimal-manifest` | `{"version":"0.5"}` and nothing else. |
| `null-and-false-members-are-content` / `null-and-false-members-omitted` | RFC-003 §3.1: "Nothing else is stripped." A `false` capability and a `null` member are hashed as written and are **not** equivalent to absence. Digests MUST differ. Serializers that drop falsy/null members by default fail here. |
| `boolean-shorthand-is-not-expanded` / `boolean-shorthand-expanded-differs` | SPEC §5.1's `true`-means-every-leaf-below shorthand is an input to the **grant** computation, not a canonicalization step. Shorthand and expanded forms are different manifests with different digests. See §5 below. |
| `dot-in-capability-member-name` | `{"a.b":{"c":true}}` and `{"a":{"b.c":true}}` in one manifest. Both flatten to the path `a.b.c`; both are legal, because `.` is inside `[A-Za-z0-9._:*-]`. Canonicalize the **tree**, never the flattened paths. |

### JCS mechanics

`unicode-and-json-escapes` exercises RFC 8785 §3.2.2.2, which is ECMAScript
`JSON.stringify`: escape **only** `U+0022`, `U+005C` and C0 controls, using
`\b \t \n \f \r` where ECMAScript defines them and `\u00xx` otherwise.
Everything else is literal UTF-8. The description deliberately contains the
characters that serializers get wrong:

| Character | Required output | Failure mode it catches |
|---|---|---|
| `U+007F` DELETE | literal | Serializers that escape all "control" characters including DEL. |
| `U+2028` / `U+2029` | literal | Serializers that escape these for safe embedding in JavaScript source. Legal JSON; wrong here. |
| `U+00A0`, `é`, `日本語`, `«»`, `—` | literal UTF-8 | `ensure_ascii=True` / `\uXXXX`-everything serializers. |
| `U+1F642` | one 4-byte UTF-8 sequence | Emitting the surrogate-pair escape `🙂` instead. |
| `e` + `U+0301` and precomposed `U+00E9`, both present | both preserved distinctly | Any implementation that NFC/NFD-normalizes. RFC 8785 does **not** normalize. |
| `U+0009 U+000A U+000D U+0008 U+000C` | `\t` `\n` `\r` `\b` `\f` | Emitting the long form `\u0009` instead of the two-character escape. |
| `U+0001`, `U+001F` | `\u0001`, `\u001f` | Uppercase hex (`\u001F`) — JCS requires lowercase. |

`number-canonicalisation` pins RFC 8785 §3.2.2.3. Its canonical form is:

```
{"demoLimits":{"e-6":0.000001,"e-7":1e-7,"e20":100000000000000000000,"e21":1e+21,
"half":2.5,"hundred":100,"large":1.7976931348623157e+308,
"maxSafeInteger":9007199254740991,"minSubnormal":5e-324,"negZero":0,
"negative":-17,"one":1,"pow2To53":9007199254740992,"tenth":0.1,
"thirds":0.3333333333333333,"zero":0},"version":"0.5"}
```
*(wrapped for reading; the real string is one line)*

The load-bearing values are the two ECMAScript formatting boundaries — `1e20`
stays positional while `1e21` becomes `1e+21`, and `1e-6` stays positional while
`1e-7` becomes `1e-7` — plus `-0.0 → 0`, `1.0 → 1` (no trailing `.0`), and
`0.1 → 0.1` rather than the exact binary expansion. A Rust implementation using
arbitrary-precision decimals, or a Go implementation using `%g`, diverges here.

> **`demoLimits` is a vendor extension, not spec surface.** No spec-defined
> member of the 0.5 manifest is numeric. It is here anyway because RFC-003 §3
> digests the *complete* `experimental.mcpl` object — the `capabilities` domain
> is "every member other than `version`, `revision`, and `featureSets`", vendor
> extensions included — and RFC-003 §3.1 itself cites mcpl-editor and both core
> libraries advertising shapes no spec version contains. An implementation that
> cannot serialize a number cannot digest a real server's manifest.

### Set semantics

`set-sort-is-utf8-byte-order` uses only legal identifiers, so it is reachable
from a conforming manifest. Its `implies` set canonicalizes to:

```
["demo:Alpha","demo:Zeta","demo:alpha","demo:alpha-1","demo:alpha.1",
 "demo:alpha1","demo:alpha9","demo:alpha:1","demo:zeta"]
```

Read that against the alternatives it rules out:

- `demo:Alpha` and `demo:Zeta` precede **every** lowercase entry, because
  `0x41`/`0x5A` < `0x61`. A case-insensitive sort gives
  `Alpha, alpha, alpha-1, …, Zeta, zeta`. An ICU/`localeCompare` sort gives
  something else again.
- Within the lowercase run: `-`(0x2D) < `.`(0x2E) < `1`(0x31) < `9`(0x39) <
  `:`(0x3A). Collations that treat punctuation as ignorable reorder these.
- `demo:alpha` is a proper prefix of the rest and sorts first. Comparators that
  sort by length-then-lexicographic get this wrong.
- `coreTags` carries a duplicate `chat:dm` that must be removed, and `uses`
  carries five entries out of order.

`nested-featuresets-and-list-arrays` is the big one: five feature sets, a full
`tagOntology`, and the **set/list boundary**.

- Sets, sorted and deduped: `uses`, `tagOntology.coreTags`,
  `tagOntology.tags.*.implies`.
- Lists, order preserved verbatim: `keyed.*.values` (RFC-003 §3.1 names it
  explicitly), the `tagOntology.suggestedTreatment` rule list (ordered,
  first-match-wins per SPEC §16.7) and — **this is the trap** — the
  `tagsAny` / `tagsAll` / `tagsNone` members inside those rules. Those are
  semantically sets. RFC-003's table does not name them, and its default is "any
  array not listed is a list", so they are lists and their order is part of the
  digest. They are supplied out of sorted order in this vector and MUST stay
  that way. See §5 below.

Feature-set names also exercise JCS member sorting: `demo.Messaging` precedes
`demo.messaging` (`0x4D` < `0x6D`), `demo.messaging.extra` precedes
`demo.messaging2` (`0x2E` < `0x32`), and the all-digits name `10` sorts first.

> **A JavaScript hazard that turns out not to be one.** `Object.keys()` returns
> integer-like own keys first, in ascending numeric order, regardless of
> insertion order — so `{"10": …, "demo.x": …}` enumerates differently in JS than
> in Python or Rust. It cannot affect the digest, because JCS re-sorts member
> names unconditionally. The `10` feature set is in the vector to document that
> this was checked, not assumed.

### Negative vectors

All five are charset violations of `[A-Za-z0-9._:*-]`. They are chosen to be
things a human would actually type:

| Vector | The bad identifier |
|---|---|
| `negative-non-ascii-tag-identifier` | `demo:naïve` — a tag identifier containing `U+00EF`. |
| `negative-solidus-in-feature-set-name` | `demo/messaging` — plausible, because MCPL *method* names use `/`. |
| `negative-trailing-space-in-uses` | `"channels.publish "` — invisible in review and in most diffs. |
| `negative-space-in-nested-capability-member` | `inject.before user`, nested three deep. Catches implementations that validate only root-level member names — which SPEC §5.4 already calls non-conforming ("a hardcoded set of nestable keys is non-conforming"). |
| `negative-empty-identifier` | `""` in `uses`. Catches unanchored regexes and "contains only allowed characters" tests, both of which accept the empty string. |

`negative-trailing-space-in-uses` is worth distinguishing from SPEC §6.4's
`invalid_uses`: `invalid_uses` disables **one feature set** while the manifest
still gets a revision. A charset violation means **no revision can be computed
at all**. Different failure, different blast radius. See §5.

### Comparator vectors (`sortVectors`)

These are not manifests. They test the set-array comparator in isolation:
`input` is a list of strings, `sorted` is the required result after dedupe.

They exist because of a gap: **RFC-003's UTF-8 byte-order rule is currently
unreachable through a conforming manifest.** The three set-valued arrays are
`uses`, `coreTags` and `implies`; all three hold identifiers; identifiers MUST
be ASCII; and the RFC itself observes that for ASCII, UTF-8 byte order, UTF-16
code-unit order and code-point order coincide. The RFC's "the UTF-8 rule governs
anything else" is a hook for a field that does not exist yet. Without these
vectors the rule ships untested until the first field that needs it — at which
point two libraries have already shipped.

`utf8-vs-utf16-divergence-above-bmp` is the one that bites. `U+FFFD` encodes as
`EF BF BD` and `U+10000` as `F0 90 80 80`, so UTF-8 puts `U+FFFD` first. In
UTF-16, `U+10000` is the surrogate pair `D800 DC00` and `U+FFFD` is `FFFD`, so
JavaScript's default `Array.prototype.sort()` puts `U+10000` first. The
cross-check prints this divergence on every run rather than asserting it in
prose:

```
(note) utf8-vs-utf16-divergence-above-bmp: default JS sort() DIVERGES -> ["z","𐀀","🙂","�","￿"]
```

Required (UTF-8): `["z","�","￿","𐀀","🙂"]`.

A TypeScript implementation MUST NOT use the bare comparator. Compare code
points (`[...a]` / `codePointAt`) or encode to UTF-8 and compare bytes. Rust's
`str: Ord` already compares UTF-8 bytes and is conforming as-is.

---

## 4. Verified against the code, not the comments

Claims above about manifest shape are from files read, not inferred:

- Manifest object shape and the boolean shorthand: `SPEC.md:190-229` (§5.1).
- `uses` is a closed enum of 17 capability paths: `SPEC.md:369-395` (§6.2), and
  again as JSON Schema at `SPEC.md:1978-2013` (Appendix B.2).
- `featureSets` is an **object keyed by feature-set name** with
  `{description, uses}`: `SPEC.md:335-360` (§6.1). Note RFC-001 §5's
  `tagOntology` example at `RFC-001-event-tags.md:199-235` shows `featureSets`
  as an **array of `{name, …}`** instead. The vectors follow SPEC §6.1 and
  RFC-003's own worked example, both of which are object-keyed.
- `tagOntology` fields (`coreTags`, `tags.*.{desc,facet,implies,suggestedTreatment,stability}`,
  `keyed.*.{desc,values,ordered}`, `suggestedTreatment`, `open`):
  `RFC-001-event-tags.md:199-249`.
- `rollback: true` as an extra feature-set member: `SPEC.md:602-621` (§8.1) —
  which is why the vectors include a feature set carrying a member outside
  Appendix B.2's two required properties.
- Channel capability leaves: `SPEC.md:1285-1318` (§14.1).
- Grants are computed by "generic recursive walk", hardcoded nestable keys are
  non-conforming: `SPEC.md:299-301` (§5.4).
- "Rejection is diagnostics, not authorisation" — a host acts on manifest
  *content*, and a digest mismatch is a conformance defect and not grounds to
  reject: `RFC-003-manifest-changes.md:179-181` (§3.1) and `SPEC.md:466` (§6.6).

All `SPEC.md` line numbers are against `origin/main` at `0618783`.

> **Incoming: RFC-003 is being merged into SPEC.md as §17.** A parallel branch
> folds RFC-003 into the 0.5 spec, moving the digest definition to §17.2. The
> definition is carried over **verbatim** — same formula, same array semantics,
> same UTF-8 set ordering, same `[A-Za-z0-9._:*-]` charset, same worked vector —
> so every vector here applies unchanged to either document. That merge also adds
> a JSON Schema pattern for the field, `^sha256:[A-Za-z0-9_-]{43}$`; all fifteen
> positive vectors were checked against it and all fifteen match. Once §17 lands,
> re-point the citations above from `RFC-003-manifest-changes.md` to
> `SPEC.md §17`; nothing else changes.

**No numeric member exists anywhere in the 0.5 manifest surface.** Searched
`SPEC.md` for numeric literals; every hit is a JSON-RPC `id`, a token count, a
`turnIndex`, a `contextWindow` or an inference parameter — all payload, none
manifest. That is why `number-canonicalisation` uses a vendor extension and says
so.

---

## 5. Unresolved — questions RFC-003 does not settle

Each of these was answered **fail-closed** and pinned in the vectors so the two
libraries agree while the question is open. If the RFC later answers one
differently, the affected vector changes and both libraries change together —
which is the point of freezing them.

1. **Who enforces the identifier charset, and what happens on violation?**
   RFC-003 §3.1 states the `MUST` but assigns it to no actor and defines no
   failure. It could plausibly be the validator's job, leaving the digester to
   hash whatever it is given.
   *Chosen:* the **digest function refuses**, error `identifier_charset`. Hashing
   a non-ASCII identifier makes the UTF-8/UTF-16 ordering divergence reachable
   inside a set-valued array, which is the exact failure the ASCII rule exists to
   prevent — so producing a digest there would produce a digest that two
   conforming libraries can disagree about. Note this is *stricter* than SPEC
   §6.4's `invalid_uses`, which degrades one feature set and still yields a
   revision.

2. **Which string positions are identifiers?** RFC-003 says "capability paths and
   tag identifiers" without enumerating them.
   *Chosen:* the explicit list in the vector file's `identifierPositions` —
   capability member names at **every** depth (per SPEC §5.4's recursive-walk
   requirement), feature-set names, `uses` entries, `coreTags`, `tags` keys,
   `implies` entries, `keyed` keys, `keyed.*.values` entries, and
   `suggestedTreatment` rule matchers. Descriptions (`description`, `desc`) are
   free text and are explicitly **not** checked; that is what makes the unicode
   vector legal. **This list is the single item in this file most in need of RFC
   confirmation.**

3. **Are `suggestedTreatment` rule matchers sets or lists?** `tagsAny` /
   `tagsAll` / `tagsNone` are semantically unordered, but RFC-003's set table
   does not name them and its stated default is that unlisted arrays are lists.
   *Chosen:* **lists**, order preserved. Following the stated default is the
   conservative reading — but it means two servers with identical matching
   behaviour produce different revisions, and a server that reorders a matcher
   announces a change that has no consequence. RFC-003 should either name them or
   say explicitly that it declines to.

4. **Is `revision` stripped recursively or only at the root?** §3.1 says "the
   complete `experimental.mcpl` object with the `revision` member removed".
   *Chosen:* **root only** (`revision-only-stripped-at-root`), because the stated
   reason is self-exclusion, which only applies to the root member.

5. **Is SPEC §5.1's boolean shorthand expanded before hashing?** RFC-003 §3.1
   defines no expansion.
   *Chosen:* **no expansion** — shorthand and expanded forms digest differently.
   Expanding would make the digest depend on the leaf vocabulary, and SPEC §5.4
   says that vocabulary "will grow", so two libraries on different vocabulary
   revisions would disagree about a manifest neither of them changed. The cost is
   real and should be stated: a server that rewrites `true` into its expansion
   announces a change that changed nothing, and the host's authoritative diff
   (§3) correctly reports no consequence.

6. **Is a member name containing `.` legal, and what does it mean?** `.` is
   inside the charset and is also the capability-path separator, so `{"a.b":{"c":
   true}}` and `{"a":{"b.c":true}}` flatten to the same path `a.b.c`.
   *Chosen:* both are legal and digest differently (`dot-in-capability-member-name`);
   canonicalize the tree, never the flattened paths. The digest is well defined
   either way. The **grant-matching** ambiguity is real and out of scope for this
   RFC — it belongs to §5.4's wildcard matching.

7. **Is `{}` a manifest?** SPEC §5.1 always shows `version`, but nothing states
   it as required, and RFC-003 §3.1 says only that `version` is not stripped.
   *Chosen:* the digest function is **total** — `{}` gets a digest. A host must
   be able to digest what it fetched before it validates it, per RFC-003 §6 and
   SPEC §6.6. Whether the host then *accepts* that manifest is a separate
   decision this file takes no position on.

8. **Is set-ness scoped by path or by member name?** RFC-003 names `uses`,
   `coreTags` and `implies` without paths. A vendor extension containing an array
   named `uses` somewhere else is therefore ambiguous.
   *Chosen:* **path-scoped** to the three locations the 0.5 shape defines, listed
   as `setValuedArrayPaths` in the vector file. A like-named array anywhere else
   is a list, per the "any array not listed is a list" default.

9. **Non-finite numbers.** RFC 8785 forbids them; they cannot appear in parsed
   JSON but can appear in an in-memory manifest a server library is asked to
   digest. No vector, because there is no way to express `NaN` in a JSON vector
   file.
   *Chosen:* the reference implementation raises `non_finite_number`.
   Implementations should do likewise; this is noted rather than tested.

10. **`featureSets` object vs array.** `RFC-001-event-tags.md:201` shows
    `"featureSets": [{ "name": …}]`; `SPEC.md:339` and RFC-003's own worked
    vector show an object keyed by name.
    *Chosen:* **object**, following SPEC §6.1 and RFC-003 §3.1. Flagged because
    the two documents disagree on the page and a Rust implementation reading
    RFC-001 first would produce a different digest for the same server.

---

## 6. Regenerating

```console
$ python3 conformance/generate_vectors.py            # rewrite the vector file
$ python3 conformance/generate_vectors.py --check    # verify only, exit 1 if stale
```

The generator refuses to write anything if the RFC's worked example stops
reproducing, if vector 0's canonical string drifts from the RFC text, or if any
`sameDigestAs` / `differentDigestFrom` assertion fails.

**The generator is not normative.** RFC-003 is normative and
`manifest-digest-vectors.json` is the frozen artifact. If the generator and the
RFC ever disagree, the generator is the bug.
