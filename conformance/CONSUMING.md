# How to consume `manifest-digest-vectors.json`

For implementers of `mcpl-core-ts`, `Anarchid/mcpl-core`, or any other library
that computes an RFC-003 §3.1 manifest revision.

You are implementing against these vectors, not against each other. If your
library passes all of them, it interoperates.

---

## 1. What you are implementing

```
revision = "sha256:" + base64url_unpadded( SHA-256( JCS( manifest_without_revision ) ) )
```

Five steps, in this order:

1. **Strip** the `revision` member — from the manifest **root object only**.
   Nothing else is removed. `version` stays. `false` and `null` members stay.
2. **Normalize set-valued arrays**: deduplicate, then sort ascending by **UTF-8
   byte sequence**. The set-valued paths are listed in the file's
   `setValuedArrayPaths` field. Every other array is a list — leave its order
   exactly as received.
3. **Validate identifiers**: every string in an `identifierPositions` location
   must be a non-empty match for `[A-Za-z0-9._:*-]`. If not, fail — do not emit
   a revision.
4. **Canonicalize** with RFC 8785 (JCS).
5. **Hash** the UTF-8 encoding of the JCS string with SHA-256, encode with
   RFC 4648 §5 base64url, strip `=` padding, prefix `sha256:`.

## 2. Reading the file

```jsonc
{
  "algorithm":            { /* the five steps, restated */ },
  "setValuedArrayPaths":  ["featureSets.*.uses", ...],
  "identifierPositions":  ["featureSets.#key", ...],   // "#key" = member names, "[]" = elements
  "errorCodes":           { "identifier_charset": "..." },
  "vectors":              [ /* manifests */ ],
  "sortVectors":          [ /* comparator only, not manifests */ ]
}
```

Each entry in `vectors` has:

| Field | Meaning |
|---|---|
| `name` | Stable identifier. Use it as your test name so failures are greppable across both repos. |
| `description` | What the vector pins and what failure mode it catches. Worth reading when one fails — it usually names the bug. |
| `input` | The manifest **as received**, before any normalization. Feed this to your digest function unchanged. |
| `canonicalJson` | The exact JCS string. Present on positive vectors only. |
| `sha256Hex` | SHA-256 of that string's UTF-8 bytes, in hex. Present on positive vectors only. |
| `digest` | The full `sha256:…` revision value. Present on positive vectors only. |
| `expectError` | A key of `errorCodes`. Present on negative vectors only. Your implementation MUST refuse to produce a digest. |
| `errorDetail` | Which value triggered it. Informational; do not assert on the text. |
| `sameDigestAs` / `differentDigestFrom` | An additional assertion against another vector, by `name`. |

A vector carries **either** `digest` **or** `expectError`, never both.

`sortVectors` entries have `name`, `description`, `input` (a list of strings) and
`sorted` (the required result after deduplication). They are not manifests; they
test your set comparator directly.

## 3. `canonicalJson` is a string value, not file bytes

The vector file is written in pure ASCII, so non-ASCII characters appear as
`\uXXXX` escapes. **Parse the file with a normal JSON parser, then compare
against the parsed string.** Do not compare against raw bytes from the file and
do not re-escape.

To get the bytes that are hashed: parse `canonicalJson`, then encode UTF-8.

```ts
const expectedBytes = new TextEncoder().encode(vector.canonicalJson);
```

```rust
let expected_bytes = vector.canonical_json.as_bytes();  // Rust String is already UTF-8
```

## 4. Assert on all three, in this order

When something breaks you want to know *which* step broke. Assert:

1. `canonicalJson` — isolates canonicalization (key order, escapes, numbers, set
   sorting).
2. `sha256Hex` — isolates the UTF-8 encoding and the hash.
3. `digest` — isolates the base64url alphabet and the padding strip.

A failure at 1 is a JCS bug. A pass at 1 and failure at 2 means your string→bytes
step is wrong. A pass at 2 and failure at 3 means you used standard base64
(`+/`) instead of base64url (`-_`), or left the `=` padding on.

## 5. Language-specific traps these vectors catch

**TypeScript / JavaScript**

- `Array.prototype.sort()` with no comparator sorts by **UTF-16 code units** and
  is wrong above U+FFFF. See `sortVectors["utf8-vs-utf16-divergence-above-bmp"]`.
  Compare code points, or encode to UTF-8 and compare bytes. RFC 8785's *member
  name* sort is UTF-16 and the default comparator is correct there — it is only
  the RFC-003 *set-array* sort that requires UTF-8.
- `JSON.stringify` is the right serializer for JCS strings and numbers. Do not
  hand-roll escaping, and do not use a "JSON-safe for JS embedding" helper —
  those escape `U+2028`/`U+2029`, which is wrong here.
- Do not use a `stable-stringify` package without checking its sort. Several
  sort with `localeCompare`.

**Rust**

- `str: Ord` compares UTF-8 bytes. Your set sort is `sort()` and it is correct
  as written.
- `serde_json` with default features uses `BTreeMap`, which already sorts member
  names — by `str` Ord, i.e. UTF-8 bytes. For the ASCII member names a
  conforming manifest contains, that is identical to JCS's UTF-16 order. If you
  enable `preserve_order`, you must sort explicitly.
- **Numbers are the real risk.** `serde_json`'s `arbitrary_precision` feature and
  the default `Display` for floats do **not** produce ECMAScript
  `Number::toString`. `1e21` must serialize as `1e+21` and `1e20` as
  `100000000000000000000`; `-0.0` must serialize as `0`; `1.0` must serialize as
  `1`. `number-canonicalisation` pins all of these. Use a JCS crate or the ES6
  algorithm, not `format!`.

**Both**

- Do not NFC/NFD-normalize strings. RFC 8785 does not, and
  `unicode-and-json-escapes` contains both a combining sequence and a
  precomposed character that must stay distinct.
- Do not drop `false` or `null` members. See
  `null-and-false-members-are-content`.
- Do not expand SPEC §5.1's boolean shorthand before hashing. See
  `boolean-shorthand-is-not-expanded`.

## 6. Suggested test shape

```ts
import vectors from "../conformance/manifest-digest-vectors.json";

const byName = new Map(vectors.vectors.map(v => [v.name, v]));

for (const v of vectors.vectors) {
  test(v.name, () => {
    if (v.expectError) {
      expect(() => computeRevision(v.input)).toThrow();
      return;
    }
    expect(canonicalize(v.input)).toBe(v.canonicalJson);
    expect(sha256Hex(v.canonicalJson)).toBe(v.sha256Hex);
    expect(computeRevision(v.input)).toBe(v.digest);
    if (v.sameDigestAs) {
      expect(computeRevision(v.input))
        .toBe(computeRevision(byName.get(v.sameDigestAs)!.input));
    }
    if (v.differentDigestFrom) {
      expect(computeRevision(v.input))
        .not.toBe(computeRevision(byName.get(v.differentDigestFrom)!.input));
    }
  });
}

for (const s of vectors.sortVectors) {
  test(`sort: ${s.name}`, () => {
    expect(sortSet(s.input)).toEqual(s.sorted);
  });
}
```

Iterate the file rather than transcribing vectors into your source. When a
vector is added or corrected, you pick it up by updating the file, and the two
libraries stay in step.

**Do not transcribe `input` into a JavaScript or Rust literal.** For
`unicode-and-json-escapes` in particular, a copy-paste through an editor can
silently normalize the combining sequence and change the digest.

## 7. Scope — what these vectors do NOT cover

They cover **canonicalization and digest computation only**. Specifically not:

- Whether a manifest is *valid*. `empty-manifest` gets a digest and is not a
  valid manifest. Validation is SPEC §6.4 (`invalid_uses`) and RFC-003 §6, and
  is a separate concern: RFC-003 §3.1 says a digest mismatch is a conformance
  defect and **not** grounds to reject a manifest, and SPEC §6.6 says rejection
  is diagnostics, not authorization. Digest first, validate second, and never
  let the digest gate acceptance.
- The wire methods `mcpl/manifestChanged` and `mcpl/manifest` (RFC-003 §4–§5).
- Diffing, the change receipt vocabulary, or grant recomputation (RFC-003 §6–§7).
- The `revision` value a server *announces*. RFC-003 §3 is explicit that the
  revision is server-authored and untrusted, and that the host's diff of the
  fetched manifest is authoritative. These vectors let both sides derive the
  same value; they do not make it believable.

## 8. If you think a vector is wrong

Say so loudly and do not work around it. A wrong vector that two libraries both
work around is worse than a wrong vector that one library fails on.

- Re-derive it: `python3 conformance/generate_vectors.py --check`.
- Check `README.md` §5 first — it lists ten questions RFC-003 does not settle,
  each answered fail-closed. If your disagreement is with one of those, it is a
  spec question, not a vector bug, and it needs an RFC amendment rather than a
  local fix.
- Otherwise open an issue against `anima-research/mcpl` with the vector `name`,
  your `canonicalJson`, and your `digest`. Do not change the file in your own
  repo.
