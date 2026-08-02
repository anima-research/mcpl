#!/usr/bin/env python3
"""
Generate (and self-check) the MCPL RFC-003 §3.1 canonical manifest digest
conformance vectors.

    revision = "sha256:" + base64url_unpadded( SHA-256( JCS( manifest_without_revision ) ) )

This file is BOTH the generator for manifest-digest-vectors.json and a small
reference implementation of the algorithm. It is deliberately dependency-free
(stdlib only) so that a reviewer can re-derive every digest in the vector file
from the RFC text alone:

    python3 conformance/generate_vectors.py --check     # verify, write nothing
    python3 conformance/generate_vectors.py             # regenerate the file

It is NOT normative. The RFC is normative; the vector file is the artifact.
If this script and the RFC disagree, the RFC wins and this script is a bug.
"""

import argparse
import base64
import hashlib
import json
import os
import re
import sys
from decimal import Decimal

HERE = os.path.dirname(os.path.abspath(__file__))
VECTOR_PATH = os.path.join(HERE, "manifest-digest-vectors.json")

# The one worked vector the RFC already contains (RFC-003 §3.1, "Test vector").
RFC_CANONICAL = (
    '{"channels":{"incoming":true,"publish":true,"register":true},'
    '"contextHooks":{"beforeInference":true},'
    '"featureSets":{"demo.messaging":{"description":"Demo",'
    '"uses":["channels.incoming","channels.publish","pushEvents","tools"]}},'
    '"inferenceLifecycle":true,"pushEvents":true,"version":"0.5"}'
)
RFC_DIGEST = "sha256:_YZTS0h1tqTAMZI6eElCszSQE2WNx3xhAhmgUvNI9H4"


# --------------------------------------------------------------------------
# RFC 8785 (JCS) primitives
# --------------------------------------------------------------------------

# RFC 8785 §3.2.2.2: serialize as ECMAScript JSON.stringify does. Escape only
# QUOTATION MARK, REVERSE SOLIDUS and C0 controls, using the two-character
# escapes where ECMAScript defines them and \u00xx otherwise. Everything else,
# including U+007F, U+2028, U+2029 and astral characters, is emitted literally.
_JS_SHORT_ESCAPES = {
    0x08: "\\b",
    0x09: "\\t",
    0x0A: "\\n",
    0x0C: "\\f",
    0x0D: "\\r",
    0x22: '\\"',
    0x5C: "\\\\",
}


def jcs_string(s):
    out = ['"']
    for ch in s:
        cp = ord(ch)
        if cp in _JS_SHORT_ESCAPES:
            out.append(_JS_SHORT_ESCAPES[cp])
        elif cp < 0x20:
            out.append("\\u%04x" % cp)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def jcs_number(x):
    """RFC 8785 §3.2.2.3 -> ECMAScript Number::toString for a finite IEEE-754
    double. Returns the shortest round-tripping decimal in ES6 format."""
    x = float(x)
    if x != x or x in (float("inf"), float("-inf")):
        raise ValueError("non_finite_number")
    if x == 0.0:
        return "0"  # covers -0.0: ES6 String(-0) is "0"
    sign = "-" if x < 0 else ""
    # repr() gives Python's shortest round-tripping decimal, same property the
    # ES6 spec requires of its digit string.
    d = Decimal(repr(abs(x)))
    dsign, digits, exp = d.as_tuple()
    digits = list(digits)
    # Make k minimal: strip trailing zeros, folding them into the exponent.
    while len(digits) > 1 and digits[-1] == 0:
        digits.pop()
        exp += 1
    k = len(digits)
    n = exp + k  # value == 0.<digits> * 10**n
    ds = "".join(str(c) for c in digits)
    if k <= n <= 21:
        return sign + ds + "0" * (n - k)
    if 0 < n <= 21:
        return sign + ds[:n] + "." + ds[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + ds
    e = n - 1
    esign = "+" if e >= 0 else "-"
    if k == 1:
        return sign + ds + "e" + esign + str(abs(e))
    return sign + ds[0] + "." + ds[1:] + "e" + esign + str(abs(e))


def _utf16_key(s):
    """RFC 8785 §3.2.3 sorts object members by UTF-16 code-unit sequence.
    Comparing UTF-16BE byte strings is equivalent to comparing code-unit
    sequences."""
    return s.encode("utf-16-be")


def jcs(value):
    """Serialize an already-normalized Python value to its JCS form."""
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "null"
    if isinstance(value, str):
        return jcs_string(value)
    if isinstance(value, (int, float)):
        return jcs_number(value)
    if isinstance(value, list):
        return "[" + ",".join(jcs(v) for v in value) + "]"
    if isinstance(value, dict):
        parts = []
        for k in sorted(value.keys(), key=_utf16_key):
            if not isinstance(k, str):
                raise ValueError("object member name must be a string")
            parts.append(jcs_string(k) + ":" + jcs(value[k]))
        return "{" + ",".join(parts) + "}"
    raise ValueError("unserializable value: %r" % (value,))


# --------------------------------------------------------------------------
# MCPL-specific normalization (RFC-003 §3.1)
# --------------------------------------------------------------------------

IDENT_RE = re.compile(r"^[A-Za-z0-9._:*-]+$")

# Paths (relative to the manifest root, "*" = any member name) whose arrays are
# SETS: byte-sorted ascending and deduplicated. RFC-003 §3.1 names `uses`,
# `coreTags` and `tagOntology.tags.*.implies`; these are the only locations the
# 0.5 manifest shape puts them in. Everything else is a list (order preserved).
SET_PATHS = (
    ("featureSets", "*", "uses"),
    ("featureSets", "*", "tagOntology", "coreTags"),
    ("featureSets", "*", "tagOntology", "tags", "*", "implies"),
)

# Positions whose string values are IDENTIFIERS and so MUST match
# [A-Za-z0-9._:*-]. "#key" means the object's member names at that path.
IDENT_PATHS = (
    ("featureSets", "#key"),                                  # feature set names
    ("featureSets", "*", "uses", "[]"),                       # capability paths
    ("featureSets", "*", "tagOntology", "coreTags", "[]"),
    ("featureSets", "*", "tagOntology", "tags", "#key"),
    ("featureSets", "*", "tagOntology", "tags", "*", "implies", "[]"),
    ("featureSets", "*", "tagOntology", "keyed", "#key"),
    ("featureSets", "*", "tagOntology", "keyed", "*", "values", "[]"),
    ("featureSets", "*", "tagOntology", "suggestedTreatment", "*", "tagsAny", "[]"),
    ("featureSets", "*", "tagOntology", "suggestedTreatment", "*", "tagsAll", "[]"),
    ("featureSets", "*", "tagOntology", "suggestedTreatment", "*", "tagsNone", "[]"),
    ("featureSets", "*", "tagOntology", "tags", "*", "facet"),
)

# Manifest members that are never capability paths and so are exempt from the
# identifier rule as member names at the root. RFC-003 §3's domain table: the
# `capabilities` domain is "every member other than version, revision, and
# featureSets".
ROOT_NON_CAPABILITY = ("version", "revision", "featureSets")


def _is_capability_member_name_path(path):
    """True if the member names of the object at `path` are capability-path
    segments, and so identifiers. SPEC §5.1: "Advertisement mirrors the
    capability paths" and §5.4 requires a "generic recursive walk", so this is
    the whole capabilities subtree at every depth, not just the root."""
    if path == ():
        return True                       # root: capability members
    return path[0] not in ROOT_NON_CAPABILITY


def _path_matches(path, pattern):
    if len(path) != len(pattern):
        return False
    for got, want in zip(path, pattern):
        if want == "*":
            # "*" is a DICT-KEY wildcard. It never matches a list index
            # ("[i]") — SPEC §17.2's set/identifier paths are written against
            # the object-keyed shape, and the non-conforming array shape is
            # hashed verbatim (differ adjudication 2026-08-02; the sorted
            # reading shipped once, in Rust, and produced a second revision
            # for identical bytes).
            if got == "[i]":
                return False
            continue
        if got != want:
            return False
    return True


def _is_set_path(path):
    return any(_path_matches(path, p) for p in SET_PATHS)


def _is_ident_path(path):
    return any(_path_matches(path, p) for p in IDENT_PATHS)


class VectorError(Exception):
    def __init__(self, code, detail):
        super().__init__("%s: %s" % (code, detail))
        self.code = code
        self.detail = detail


def _check_ident(value, where):
    if not isinstance(value, str) or not IDENT_RE.match(value):
        raise VectorError("identifier_charset", "%s = %r" % (where, value))


def normalize(value, path=()):
    """Apply RFC-003 §3.1 array semantics and the identifier charset rule.
    Returns a value ready for jcs()."""
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            check = _is_ident_path(path + ("#key",))
            if _is_capability_member_name_path(path):
                check = not (path == () and k in ROOT_NON_CAPABILITY)
            if check:
                _check_ident(k, ".".join(path + (k,)) or k)
            out[k] = normalize(v, path + (k,))
        return out
    if isinstance(value, list):
        items = [normalize(v, path + ("[i]",)) for v in value]
        epath = path + ("[]",)
        if _is_ident_path(epath):
            for it in items:
                _check_ident(it, ".".join(path) + "[]")
        if _is_set_path(path):
            seen, uniq = set(), []
            for it in items:
                if not isinstance(it, str):
                    raise VectorError("set_member_not_string", ".".join(path))
                if it in seen:
                    continue
                seen.add(it)
                uniq.append(it)
            # RFC-003 §3.1: sort by UTF-8 byte sequence, ascending.
            uniq.sort(key=lambda s: s.encode("utf-8"))
            return uniq
        return items
    if isinstance(value, str):
        if _is_ident_path(path):
            _check_ident(value, ".".join(path))
        return value
    return value


def canonicalize(manifest):
    """manifest -> exact JCS string that gets hashed."""
    if not isinstance(manifest, dict):
        raise VectorError("manifest_not_object", type(manifest).__name__)
    stripped = {k: v for k, v in manifest.items() if k != "revision"}
    return jcs(normalize(stripped))


def digest(manifest):
    canonical = canonicalize(manifest)
    h = hashlib.sha256(canonical.encode("utf-8")).digest()
    b64 = base64.urlsafe_b64encode(h).decode("ascii").rstrip("=")
    return canonical, h.hex(), "sha256:" + b64


# --------------------------------------------------------------------------
# Vector inputs
# --------------------------------------------------------------------------

UNICODE_DESC = (
    "Caf\u00e9 \u65e5\u672c\u8a9e \U0001f642 "
    '"quoted" and back\\slash, '
    "tab[\t] nl[\n] cr[\r] bs[\b] ff[\f] "
    "soh[\u0001] us[\u001f] del[\u007f] "
    "ls[\u2028] ps[\u2029] nbsp[\u00a0] "
    "combining[e\u0301] precomposed[\u00e9] end"
)


def build_vectors():
    V = []

    V.append({
        "name": "rfc-003-worked-example",
        "description": (
            "The single worked vector already present in RFC-003 §3.1. "
            "Reproduced and verified here byte for byte; every other vector in "
            "this file is only as trustworthy as this one. Object members are "
            "supplied out of JCS order and `uses` out of set order, so neither "
            "JCS member sorting nor set sorting alone yields this digest."
        ),
        "input": {
            "version": "0.5",
            "pushEvents": True,
            "contextHooks": {"beforeInference": True},
            "inferenceLifecycle": True,
            "channels": {"register": True, "publish": True, "incoming": True},
            "featureSets": {
                "demo.messaging": {
                    "description": "Demo",
                    "uses": ["channels.publish", "channels.incoming",
                             "pushEvents", "tools"],
                }
            },
        },
    })

    V.append({
        "name": "key-ordering-and-set-ordering-independence",
        "description": (
            "Same manifest as vector 0 with every object's members supplied in a "
            "different order, `uses` reversed, and one duplicate `uses` entry. "
            "MUST produce the identical digest to vector 0: JCS fixes member "
            "order, set semantics fix `uses` order and remove duplicates. A "
            "reader that preserves JSON insertion order sees genuinely shuffled "
            "input here; a reader that sorts on parse trivially passes, which is "
            "fine — the invariant is the digest, not the intermediate."
        ),
        "input": {
            "featureSets": {
                "demo.messaging": {
                    "uses": ["tools", "pushEvents", "channels.publish",
                             "channels.incoming", "tools"],
                    "description": "Demo",
                }
            },
            "channels": {"incoming": True, "register": True, "publish": True},
            "inferenceLifecycle": True,
            "contextHooks": {"beforeInference": True},
            "pushEvents": True,
            "version": "0.5",
        },
        "sameDigestAs": "rfc-003-worked-example",
    })

    V.append({
        "name": "revision-present-is-stripped",
        "description": (
            "Vector 0 with a `revision` member carrying a deliberately WRONG "
            "value. The digest never covers itself: `revision` is removed before "
            "canonicalization, so this MUST yield vector 0's digest and the "
            "supplied value MUST NOT influence it. An implementation that hashes "
            "the manifest as received fails here. Note `revision` is stripped "
            "only at the manifest root — see vector "
            "'revision-only-stripped-at-root'."
        ),
        "input": {
            "revision": "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "version": "0.5",
            "pushEvents": True,
            "contextHooks": {"beforeInference": True},
            "inferenceLifecycle": True,
            "channels": {"register": True, "publish": True, "incoming": True},
            "featureSets": {
                "demo.messaging": {
                    "description": "Demo",
                    "uses": ["channels.publish", "channels.incoming",
                             "pushEvents", "tools"],
                }
            },
        },
        "sameDigestAs": "rfc-003-worked-example",
    })

    V.append({
        "name": "revision-only-stripped-at-root",
        "description": (
            "RFC-003 §3.1 strips `revision` from the manifest object, not from "
            "everything named `revision`. A nested member of that name is "
            "ordinary content and is hashed. Contrast with "
            "'revision-present-is-stripped'; an implementation that strips "
            "recursively produces a different digest here."
        ),
        "input": {
            "version": "0.5",
            "revision": "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "demoExtension": {"revision": "not-stripped"},
        },
    })

    V.append({
        "name": "empty-manifest",
        "description": (
            "The empty object. Not a valid manifest — SPEC §5.1 always shows "
            "`version` — but the digest function MUST be total, because a host "
            "recomputes the digest of whatever it fetched before deciding "
            "anything about it (RFC-003 §6.6: rejection is diagnostics, not "
            "authorization). Canonicalizes to two bytes."
        ),
        "input": {},
    })

    V.append({
        "name": "minimal-manifest",
        "description": (
            "The smallest manifest a conforming server can present: protocol "
            "version only, no capabilities, no feature sets."
        ),
        "input": {"version": "0.5"},
    })

    V.append({
        "name": "unicode-and-json-escapes",
        "description": (
            "Exercises RFC 8785 §3.2.2.2 string serialization on a "
            "`description` (descriptions are free text; only identifiers are "
            "charset-restricted). The escaping rule is ECMAScript "
            "JSON.stringify: escape ONLY U+0022, U+005C and C0 controls, using "
            "\\b \\t \\n \\f \\r where defined and \\u00xx otherwise. "
            "Everything else is literal UTF-8 — including U+007F DELETE, "
            "U+2028/U+2029 (which some serializers escape for JavaScript "
            "embedding and MUST NOT here), U+00A0, a combining sequence that "
            "MUST NOT be NFC-normalized, and an astral emoji that MUST be one "
            "4-byte UTF-8 sequence, not a surrogate pair escape. Non-ASCII also "
            "appears in a nested tagOntology `desc`."
        ),
        "input": {
            "version": "0.5",
            "featureSets": {
                "demo.unicode": {
                    "description": UNICODE_DESC,
                    "uses": ["pushEvents"],
                    "tagOntology": {
                        "tags": {
                            "demo:accent": {
                                "desc": "naïve résumé — em dash, "
                                        "«guillemets», 中文",
                                "facet": "content",
                            }
                        },
                        "open": True,
                    },
                }
            },
        },
    })

    V.append({
        "name": "number-canonicalisation",
        "description": (
            "No spec-defined manifest member is numeric in MCPL 0.5. But "
            "RFC-003 §3 digests the COMPLETE experimental.mcpl object — "
            "'every member other than version, revision and featureSets' is the "
            "capabilities domain, vendor extensions included — so an "
            "implementation that cannot serialize a number cannot digest a real "
            "server's manifest. `demoLimits` is a vendor extension, not spec "
            "surface. Values pin RFC 8785 §3.2.2.3 / ECMAScript "
            "Number::toString: integer-valued doubles lose the '.0'; negative "
            "zero serializes as '0'; 1e20 stays positional while 1e21 goes "
            "exponential as '1e+21'; 1e-6 stays positional while 1e-7 becomes "
            "'1e-7'; the shortest round-tripping digit string is used, so "
            "0.1 is '0.1' and not '0.1000000000000000055511151231257827'."
        ),
        "input": {
            "version": "0.5",
            "demoLimits": {
                "zero": 0,
                "negZero": -0.0,
                "one": 1.0,
                "hundred": 100,
                "negative": -17,
                "half": 2.5,
                "tenth": 0.1,
                "thirds": 0.3333333333333333,
                "e20": 1e20,
                "e21": 1e21,
                "e-6": 1e-06,
                "e-7": 1e-07,
                "maxSafeInteger": 9007199254740991,
                "pow2To53": 9007199254740992,
                "minSubnormal": 5e-324,
                "large": 1.7976931348623157e308,
            },
        },
    })

    V.append({
        "name": "set-sort-is-utf8-byte-order",
        "description": (
            "Set-valued arrays sort by UTF-8 byte sequence ascending (RFC-003 "
            "§3.1) — not by locale collation and not case-insensitively. Every "
            "value here is a legal identifier, so this is reachable from a "
            "conforming manifest. It discriminates byte order from the "
            "alternatives: 'demo:Alpha' and 'demo:Zeta' precede ALL lowercase "
            "entries because 0x41/0x5A < 0x61; a locale or case-folding sort "
            "would interleave them. Within the lowercase run the ASCII "
            "punctuation order '-'(0x2D) < '.'(0x2E) < digits(0x30..) < "
            "':'(0x3A) is exercised, which ICU-style collations reorder or "
            "ignore entirely. 'demo:alpha' being a proper prefix sorts first. "
            "`coreTags` additionally carries a duplicate that MUST be removed."
        ),
        "input": {
            "version": "0.5",
            "featureSets": {
                "demo.sorting": {
                    "description": "Set ordering",
                    "uses": ["tools", "channels.publish", "channels.incoming",
                             "channels.acknowledge", "pushEvents"],
                    "tagOntology": {
                        "coreTags": ["chat:reply", "chat:dm", "chat:addressed",
                                     "chat:mention", "chat:dm", "chat:from-bot",
                                     "chat:from-human"],
                        "tags": {
                            "demo:sorted": {
                                "desc": "Byte-order probe",
                                "implies": [
                                    "demo:zeta",
                                    "demo:Zeta",
                                    "demo:alpha-1",
                                    "demo:alpha.1",
                                    "demo:Alpha",
                                    "demo:alpha1",
                                    "demo:alpha:1",
                                    "demo:alpha",
                                    "demo:alpha9",
                                    "demo:alpha-1",
                                ],
                            }
                        },
                        "open": False,
                    },
                }
            },
        },
    })

    V.append({
        "name": "nested-featuresets-and-list-arrays",
        "description": (
            "Five feature sets with a full tagOntology, pinning the boundary "
            "between set-valued and list-valued arrays. SETS (sorted, deduped): "
            "`uses`, `tagOntology.coreTags`, `tagOntology.tags.*.implies`. "
            "LISTS (order preserved verbatim, RFC-003 §3.1 'any array not "
            "listed is a list'): `keyed.*.values`, the `tagOntology."
            "suggestedTreatment` rule list, and — this is the trap — the "
            "`tagsAny`/`tagsNone` members inside those rules, which are "
            "semantically sets but are not named in RFC-003's table. They are "
            "supplied out of sorted order and MUST stay that way. Feature-set "
            "names also exercise JCS member sorting: 'demo.Messaging' precedes "
            "'demo.messaging' (0x4D < 0x6D), 'demo.messaging.extra' precedes "
            "'demo.messaging2' (0x2E < 0x32), and the all-digits name '10' "
            "sorts first — harmlessly, since JCS re-sorts and JavaScript's "
            "integer-like own-key reordering therefore cannot be observed."
        ),
        "input": {
            "version": "0.5",
            "pushEvents": True,
            "modelInfo": True,
            "inferenceRequest": {"streaming": True},
            "contextHooks": {
                "beforeInference": {
                    "observe": True,
                    "inject": {"system": False, "beforeUser": True,
                               "afterUser": True},
                }
            },
            "channels": {"register": True, "lifecycle": True, "publish": True,
                         "incoming": True, "streaming": False,
                         "acknowledge": True, "typing": False},
            "featureSets": {
                "demo.messaging": {
                    "description": "Messaging",
                    "uses": ["channels.publish", "channels.incoming",
                             "channels.register", "pushEvents"],
                    "tagOntology": {
                        "coreTags": ["chat:mention", "chat:reply",
                                     "chat:addressed", "chat:ambient",
                                     "chat:from-bot"],
                        "tags": {
                            "demo:role-mention": {
                                "desc": "A role the agent holds was pinged",
                                "facet": "addressing",
                                "implies": ["chat:broadcast", "chat:ambient"],
                                "suggestedTreatment": "throttle",
                            },
                            "demo:voice": {
                                "desc": "Voice state change",
                                "facet": "lifecycle",
                                "stability": "experimental",
                            },
                        },
                        "keyed": {
                            "urgency": {
                                "desc": "Producer urgency hint",
                                "values": ["low", "normal", "high", "critical"],
                                "ordered": True,
                            },
                            "locale": {
                                "desc": "Message locale",
                                "values": ["ja-JP", "en-GB", "en-US"],
                                "ordered": False,
                            },
                        },
                        "suggestedTreatment": [
                            {"tagsAny": ["chat:mention", "chat:addressed"],
                             "behavior": "immediate"},
                            {"tagsAny": ["chat:deleted"], "behavior": "mute"},
                            {"tagsAny": ["chat:from-bot", "chat:ambient"],
                             "tagsNone": ["chat:reply", "chat:mention"],
                             "behavior": "throttle"},
                        ],
                        "open": True,
                    },
                },
                "demo.messaging.extra": {
                    "description": "Extra",
                    "uses": ["tools"],
                    "rollback": True,
                },
                "demo.messaging2": {
                    "description": "Second",
                    "uses": ["inferenceLifecycle", "modelInfo"],
                },
                "demo.Messaging": {
                    "description": "Capitalised sibling",
                    "uses": ["contextHooks.beforeInference.inject.afterUser",
                             "contextHooks.beforeInference.observe",
                             "contextHooks.beforeInference.inject.beforeUser"],
                },
                "10": {
                    "description": "All-digits feature set name",
                    "uses": ["modelInfo"],
                },
            },
        },
    })

    V.append({
        "name": "boolean-shorthand-is-not-expanded",
        "description": (
            "SPEC §5.1 says a boolean `true` at any level is shorthand for every "
            "leaf beneath it. That shorthand is an input to the host's GRANT "
            "computation, not a canonicalization step: RFC-003 §3.1 defines no "
            "expansion, and expanding would make the digest depend on a "
            "vocabulary that §5.4 says will grow — two implementations on "
            "different vocabulary revisions would then disagree. So the "
            "shorthand form and the expanded form are DIFFERENT manifests with "
            "DIFFERENT digests. This vector is the shorthand form; "
            "'boolean-shorthand-expanded-differs' is the expansion, and their "
            "digests differ by construction. See README 'Unresolved'."
        ),
        "input": {
            "version": "0.5",
            "contextHooks": {"beforeInference": True},
            "channels": True,
        },
    })

    V.append({
        "name": "boolean-shorthand-expanded-differs",
        "description": (
            "The expansion of 'boolean-shorthand-is-not-expanded'. Semantically "
            "the same advertisement under SPEC §5.1; a different manifest under "
            "RFC-003 §3.1, hence a different digest. Asserting the digests "
            "differ is the conformance check — an implementation that "
            "normalizes shorthand will collapse these two and fail."
        ),
        "input": {
            "version": "0.5",
            "contextHooks": {
                "beforeInference": {
                    "observe": True,
                    "inject": {"system": True, "beforeUser": True,
                               "afterUser": True},
                }
            },
            "channels": {"register": True, "lifecycle": True, "publish": True,
                         "incoming": True, "streaming": True,
                         "acknowledge": True, "typing": True},
        },
        "differentDigestFrom": "boolean-shorthand-is-not-expanded",
    })

    V.append({
        "name": "dot-in-capability-member-name",
        "description": (
            "'.' is inside [A-Za-z0-9._:*-], and capability paths are "
            "dot-separated (SPEC §5.4), so a member NAME may legally contain "
            "the separator. `{\"a.b\": {\"c\": true}}` and "
            "`{\"a\": {\"b.c\": true}}` both flatten to the path 'a.b.c' while "
            "being different manifests with different digests. That is not a "
            "digest defect — canonicalization is over the tree, not the "
            "flattened paths, so the digest is well defined either way — but it "
            "IS a grant-matching ambiguity, and it is unresolved (see README). "
            "This vector pins the digest behaviour so the two libraries agree "
            "while the spec question is open: DO NOT flatten before hashing."
        ),
        "input": {
            "version": "0.5",
            "a.b": {"c": True},
            "a": {"b.c": True},
        },
    })

    V.append({
        "name": "null-and-false-members-are-content",
        "description": (
            "RFC-003 §3.1 strips exactly one thing: the root `revision`. "
            "'Nothing else is stripped.' A `false` capability and a `null` "
            "member are therefore hashed as written and are NOT equivalent to "
            "the member being absent — see 'null-and-false-members-omitted' for "
            "the contrasting digest. An implementation that drops falsy or null "
            "members before hashing (a common serializer default) fails here."
        ),
        "input": {
            "version": "0.5",
            "pushEvents": False,
            "modelInfo": None,
            "inferenceLifecycle": True,
        },
    })

    V.append({
        "name": "null-and-false-members-omitted",
        "description": (
            "The same manifest as 'null-and-false-members-are-content' with the "
            "false and null members absent. Digests MUST differ."
        ),
        "input": {
            "version": "0.5",
            "inferenceLifecycle": True,
        },
        "differentDigestFrom": "null-and-false-members-are-content",
    })

    # ---- negative vectors -------------------------------------------------

    V.append({
        "name": "negative-non-ascii-tag-identifier",
        "description": (
            "RFC-003 §3.1: 'capability paths and tag identifiers MUST be ASCII "
            "— [A-Za-z0-9._:*-]'. 'demo:naïve' is a tag identifier "
            "containing U+00EF. A conforming digest implementation MUST refuse "
            "to produce a revision for this manifest rather than silently "
            "hashing it, because the UTF-8-vs-UTF-16 ordering divergence the "
            "ASCII rule exists to prevent becomes reachable the moment "
            "non-ASCII enters a set-valued array. See README 'Unresolved' — "
            "this is the fail-closed reading; the RFC states the MUST but not "
            "who enforces it."
        ),
        "input": {
            "version": "0.5",
            "featureSets": {
                "demo.bad": {
                    "description": "Bad tag identifier",
                    "uses": ["pushEvents"],
                    "tagOntology": {
                        "tags": {"demo:naïve": {"desc": "non-ASCII key"}}
                    },
                }
            },
        },
        "expectError": "identifier_charset",
    })

    V.append({
        "name": "negative-solidus-in-feature-set-name",
        "description": (
            "Feature-set names are dot-separated identifiers (SPEC §6.3). "
            "'demo/messaging' contains U+002F SOLIDUS, which is outside "
            "[A-Za-z0-9._:*-]. MUST be rejected. The value is plausible enough "
            "to be typed by hand — MCPL method names use '/' — which is exactly "
            "why it is here."
        ),
        "input": {
            "version": "0.5",
            "featureSets": {
                "demo/messaging": {
                    "description": "Slash in name",
                    "uses": ["tools"],
                }
            },
        },
        "expectError": "identifier_charset",
    })

    V.append({
        "name": "negative-trailing-space-in-uses",
        "description": (
            "'channels.publish ' with a trailing U+0020. Invisible in review, "
            "invisible in most diffs, and it changes both the digest and the "
            "SPEC §6.2 enum match. MUST be rejected on the charset rule. Note "
            "this failure is distinct from SPEC §6.4's `invalid_uses` "
            "degradation: `invalid_uses` disables one feature set while the "
            "manifest still gets a revision, whereas a charset violation means "
            "no revision can be computed at all."
        ),
        "input": {
            "version": "0.5",
            "featureSets": {
                "demo.messaging": {
                    "description": "Trailing space",
                    "uses": ["pushEvents", "channels.publish "],
                }
            },
        },
        "expectError": "identifier_charset",
    })

    V.append({
        "name": "negative-space-in-nested-capability-member",
        "description": (
            "The charset rule applies to capability PATHS, and SPEC §5.1 says "
            "advertisement mirrors those paths — a nested member name is a path "
            "segment, so 'contextHooks.beforeInference.inject.before user' is a "
            "capability path containing U+0020. §5.4 additionally requires a "
            "'generic recursive walk' and calls a hardcoded set of nestable "
            "keys non-conforming, so an implementation that only validates "
            "root-level member names is wrong at exactly the depth the "
            "vocabulary is growing into. MUST be rejected."
        ),
        "input": {
            "version": "0.5",
            "contextHooks": {
                "beforeInference": {
                    "observe": True,
                    "inject": {"before user": True},
                }
            },
        },
        "expectError": "identifier_charset",
    })

    V.append({
        "name": "negative-empty-identifier",
        "description": (
            "The empty string is not a match for [A-Za-z0-9._:*-]+ and is not a "
            "capability path. An implementation using a regex without anchors, "
            "or one testing 'contains only allowed chars' rather than 'is a "
            "non-empty run of allowed chars', accepts this."
        ),
        "input": {
            "version": "0.5",
            "featureSets": {
                "demo.messaging": {
                    "description": "Empty uses entry",
                    "uses": [""],
                }
            },
        },
        "expectError": "identifier_charset",
    })

    # ── Differ adjudications, 2026-08-02 (SPEC §17.2 "the digest is total") ──
    # Each pins a case where the two library implementations diverged. See the
    # review comments on mcpl-core-ts#6 and Anarchid/mcpl-core#3.

    V.append({
        "name": "wrong-typed-set-field-hashed-verbatim",
        "description": (
            "SPEC §17.2: the digest is TOTAL — set semantics apply only when "
            "the value actually IS an array. `\"uses\": \"tools\"` is a "
            "wrong-typed value in a set position: it is hashed verbatim (JCS "
            "only), never sorted and never refused. Validation (§6.4 "
            "invalid_uses) is where this fails; the digest's job is to give "
            "two libraries the same answer for the same bytes. Adjudicated "
            "after one implementation refused with an invented error code "
            "while the other hashed — digest-vs-error for identical bytes."
        ),
        "input": {
            "version": "0.5",
            "featureSets": {
                "demo.messaging": {"description": "d", "uses": "tools"}
            },
        },
    })

    V.append({
        "name": "array-form-featuresets-hashed-verbatim",
        "description": (
            "The array-of-{name,...} featureSets shape is NON-CONFORMING "
            "(SPEC §6.1 defines an object keyed by name; RFC-001's array "
            "example was a documented error, corrected 2026-08-02). A digest "
            "implementation MUST NOT set-normalize inside it: §17.2's set "
            "paths are written against the object shape, so `uses` here keeps "
            "its input order (['tools','pushEvents'] stays unsorted) and no "
            "identifier check applies. Adjudicated after one implementation "
            "sorted inside the array shape and produced a different revision "
            "than the other for identical manifest bytes — precisely the "
            "failure the digest exists to prevent. Hash verbatim; let "
            "validation reject the shape."
        ),
        "input": {
            "version": "0.5",
            "featureSets": [
                {"name": "f", "description": "d", "uses": ["tools", "pushEvents"]}
            ],
        },
    })

    V.append({
        "name": "empty-member-differs-from-absent",
        "description": (
            "SPEC §17.3: an ABSENT member and an EMPTY one are different "
            "manifests — they canonicalize differently — so a member "
            "appearing or disappearing IS a change to its domain. This vector "
            "is {version, featureSets:{}}; its digest MUST differ from "
            "minimal-manifest ({version} alone). Adjudicated after one "
            "implementation projected absent to {} in its domain diff and "
            "under-announced the change."
        ),
        "input": {"version": "0.5", "featureSets": {}},
        "differentDigestFrom": "minimal-manifest",
    })

    return V


# Comparator vectors: the RFC's UTF-8 rule "governs anything else", but no
# set-valued array in the 0.5 manifest shape can legally hold a non-ASCII
# string (see README). These test the comparator directly so the rule is still
# pinned for future set-valued fields.
SORT_VECTORS = [
    {
        "name": "ascii-punctuation-and-case",
        "description": (
            "Pure ASCII, reachable from a conforming manifest. Byte order is "
            "'*'(0x2A) < '-'(0x2D) < '.'(0x2E) < '0'(0x30) < ':'(0x3A) < "
            "'A'(0x41) < 'a'(0x61). Any case-insensitive or ICU-style collation "
            "produces a different order."
        ),
        "input": ["a:b", "A:b", "a.b", "a-b", "a*b", "a0b", "a:", "a", "ab",
                  "A", "Ab"],
    },
    {
        "name": "prefix-is-shortest-first",
        "description": (
            "A proper prefix sorts before any extension of it, in both UTF-8 "
            "byte order and every other order — included because "
            "length-then-lexicographic comparators get it wrong."
        ),
        "input": ["chat:from-self", "chat:from", "chat:from-human", "chat:f",
                  "chat:from-bot"],
    },
    {
        "name": "utf8-vs-utf16-divergence-above-bmp",
        "description": (
            "THE reason RFC-003 §3.1 says 'UTF-8 byte sequence' and not 'sort'. "
            "U+FFFD encodes as EF BF BD and U+10000 as F0 90 80 80, so UTF-8 "
            "puts U+FFFD first. In UTF-16, U+10000 is the surrogate pair D800 "
            "DC00 and U+FFFD is FFFD, so JavaScript's default "
            "Array.prototype.sort() (UTF-16 code units) puts U+10000 first. "
            "Rust's str Ord (UTF-8 bytes, equivalently code points) agrees with "
            "the RFC. A JavaScript implementation MUST NOT use the default "
            "comparator; compare code points, or encode to UTF-8 and compare "
            "bytes. Not reachable from a conforming 0.5 manifest — see README."
        ),
        "input": ["\U00010000", "\ufffd", "\U0001f642", "\uffff", "z"],
    },
    {
        "name": "utf8-equals-codepoint-order",
        "description": (
            "UTF-8 byte order and Unicode code-point order are the same order — "
            "UTF-8 is order-preserving. This vector exists so an implementation "
            "may compare code points instead of encoding, and know that is "
            "conforming."
        ),
        "input": ["\u00ff", "\u0100", "\u07ff", "\u0800", "\u07c0", "\u0080", "\u007f"],
    },
]


# --------------------------------------------------------------------------
# Assembly and self-check
# --------------------------------------------------------------------------

def assemble():
    problems = []

    # Gate everything on the RFC's own worked example.
    h = hashlib.sha256(RFC_CANONICAL.encode("utf-8")).digest()
    got = "sha256:" + base64.urlsafe_b64encode(h).decode("ascii").rstrip("=")
    if got != RFC_DIGEST:
        problems.append("RFC worked example does not reproduce: %s != %s"
                        % (got, RFC_DIGEST))

    vectors, by_name = [], {}
    for spec in build_vectors():
        out = {"name": spec["name"], "description": spec["description"],
               "input": spec["input"]}
        if "expectError" in spec:
            try:
                canonicalize(spec["input"])
                problems.append("%s: expected error %s, none raised"
                                % (spec["name"], spec["expectError"]))
            except VectorError as e:
                if e.code != spec["expectError"]:
                    problems.append("%s: expected %s, got %s"
                                    % (spec["name"], spec["expectError"], e.code))
                out["expectError"] = spec["expectError"]
                out["errorDetail"] = e.detail
        else:
            canonical, hexd, rev = digest(spec["input"])
            out["canonicalJson"] = canonical
            out["sha256Hex"] = hexd
            out["digest"] = rev
        for extra in ("sameDigestAs", "differentDigestFrom"):
            if extra in spec:
                out[extra] = spec[extra]
        vectors.append(out)
        by_name[spec["name"]] = out

    # Cross-vector assertions.
    for v in vectors:
        ref = v.get("sameDigestAs")
        if ref and v["digest"] != by_name[ref]["digest"]:
            problems.append("%s: digest differs from %s" % (v["name"], ref))
        ref = v.get("differentDigestFrom")
        if ref and v["digest"] == by_name[ref]["digest"]:
            problems.append("%s: digest equals %s" % (v["name"], ref))

    v0 = by_name["rfc-003-worked-example"]
    if v0["canonicalJson"] != RFC_CANONICAL:
        problems.append("vector 0 canonical JSON does not match the RFC text")
    if v0["digest"] != RFC_DIGEST:
        problems.append("vector 0 digest does not match the RFC text")

    sorts = []
    for s in SORT_VECTORS:
        sorts.append({
            "name": s["name"],
            "description": s["description"],
            "input": s["input"],
            "sorted": sorted(set(s["input"]), key=lambda x: x.encode("utf-8")),
        })

    doc = {
        "$schema": "https://github.com/anima-research/mcpl "
                   "conformance/manifest-digest-vectors",
        "title": "MCPL RFC-003 §3.1 canonical manifest digest — conformance vectors",
        "specRevision": "RFC-003 (Accepted, 2026-08-02), against SPEC.md 0.5.0-draft",
        "generatedBy": "conformance/generate_vectors.py",
        "readme": "conformance/README.md",
        "algorithm": {
            "formula": 'revision = "sha256:" + base64url_unpadded('
                       "SHA-256( JCS( manifest_without_revision ) ) )",
            "canonicalization": "RFC 8785 JSON Canonicalization Scheme",
            "hash": "SHA-256 over the UTF-8 encoding of the JCS string",
            "encoding": "RFC 4648 §5 base64url, '=' padding removed",
            "strip": "the `revision` member of the manifest root object, and "
                     "nothing else",
            "setArraySort": "UTF-8 byte sequence, ascending; duplicates removed",
            "objectMemberSort": "RFC 8785: UTF-16 code-unit sequence of the "
                                "member name. Every member name in a conforming "
                                "manifest is ASCII, so this coincides with UTF-8 "
                                "byte order throughout.",
            "identifierCharset": "[A-Za-z0-9._:*-] (non-empty)",
        },
        "setValuedArrayPaths": [".".join(p) for p in SET_PATHS],
        "listValuedArrayNote": (
            "Every array not listed in setValuedArrayPaths is a list: its order "
            "is part of the manifest and is preserved verbatim. This includes "
            "`keyed.*.values` (RFC-003 §3.1) and, less obviously, the "
            "`tagsAny`/`tagsAll`/`tagsNone` members of `suggestedTreatment` "
            "rules, which are semantically sets but are not named as such."
        ),
        "identifierPositions": [".".join(p) for p in IDENT_PATHS],
        "identifierPositionsNote": (
            "'#key' means the object's member names at that path; '[]' means "
            "the array's elements. RFC-003 does not enumerate these positions; "
            "this list is the fail-closed reading and is the one thing in this "
            "file most in need of RFC confirmation. Root member names are "
            "capability paths and are checked, except `version`, `revision` and "
            "`featureSets`, which are not capabilities (RFC-003 §3)."
        ),
        "errorCodes": {
            "identifier_charset": "A string in an identifier position is empty "
                                  "or contains a character outside "
                                  "[A-Za-z0-9._:*-].",
            "set_member_not_string": "A set-valued array contains a non-string.",
            "manifest_not_object": "The manifest is not a JSON object.",
        },
        "howToRead": (
            "`input` is the manifest as received, before any normalization. "
            "`canonicalJson` is the exact JCS string; it is stored as a JSON "
            "string, so parse it and encode the result as UTF-8 to obtain the "
            "bytes that are hashed — do not compare raw file bytes. "
            "`sha256Hex` is that hash in hex, present so a mismatch localizes "
            "to canonicalization or to encoding rather than 'somewhere'. "
            "`digest` is the full revision value. A vector carries either "
            "`digest` or `expectError`, never both. `sameDigestAs` and "
            "`differentDigestFrom` are assertions to test in addition to the "
            "digest itself."
        ),
        "vectors": vectors,
        "sortVectors": sorts,
        "sortVectorsNote": (
            "These test the set-array comparator in isolation: input is a list "
            "of strings, `sorted` is the required result after deduplication. "
            "They are not manifests. They exist because no set-valued array in "
            "the 0.5 manifest shape can legally hold a non-ASCII string — every "
            "one of them holds identifiers — so RFC-003's 'the UTF-8 rule "
            "governs anything else' clause is currently unreachable through a "
            "conforming manifest and would otherwise go untested until the "
            "first field that needs it."
        ),
    }
    return doc, problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="verify only; do not write")
    args = ap.parse_args()

    doc, problems = assemble()

    if problems:
        for p in problems:
            print("FAIL: %s" % p, file=sys.stderr)
        return 1

    text = json.dumps(doc, indent=2, ensure_ascii=True) + "\n"

    if args.check:
        if not os.path.exists(VECTOR_PATH):
            print("FAIL: %s missing" % VECTOR_PATH, file=sys.stderr)
            return 1
        with open(VECTOR_PATH, "r", encoding="utf-8") as f:
            on_disk = f.read()
        if on_disk != text:
            print("FAIL: %s is stale (regenerate)" % VECTOR_PATH, file=sys.stderr)
            return 1
        # Re-verify every digest by parsing the file back, so the check does not
        # merely compare the generator to itself.
        parsed = json.loads(on_disk)
        for v in parsed["vectors"]:
            if "expectError" in v:
                continue
            got = hashlib.sha256(v["canonicalJson"].encode("utf-8")).digest()
            exp = ("sha256:" + base64.urlsafe_b64encode(got)
                   .decode("ascii").rstrip("="))
            if exp != v["digest"] or got.hex() != v["sha256Hex"]:
                print("FAIL: %s digest does not match its canonicalJson"
                      % v["name"], file=sys.stderr)
                return 1
        print("OK: %d vectors, %d sort vectors; RFC-003 worked example "
              "reproduces" % (len(parsed["vectors"]), len(parsed["sortVectors"])))
        return 0

    with open(VECTOR_PATH, "w", encoding="utf-8") as f:
        f.write(text)
    print("wrote %s (%d vectors, %d sort vectors)"
          % (VECTOR_PATH, len(doc["vectors"]), len(doc["sortVectors"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
