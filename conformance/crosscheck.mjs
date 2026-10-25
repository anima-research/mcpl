import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const path = process.argv[2] ||
  new URL('./manifest-digest-vectors.json', import.meta.url).pathname;
const doc = JSON.parse(readFileSync(path, 'utf8'));

const SET_PATHS = [
  ['featureSets', '*', 'uses'],
  ['featureSets', '*', 'tagOntology', 'coreTags'],
  ['featureSets', '*', 'tagOntology', 'tags', '*', 'implies'],
];
const LIST_INDEX = '[i]';
// SPEC §17.2: these paths are written against the object-keyed shape, so '*' never matches a list index.
const matches = (p, pat) =>
  p.length === pat.length && p.every((s, i) => pat[i] === '*' ? s !== LIST_INDEX : pat[i] === s);
const isSet = (p) => SET_PATHS.some((pat) => matches(p, pat));

const enc = new TextEncoder();
function utf8cmp(a, b) {
  const x = enc.encode(a), y = enc.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

function normalize(v, path = []) {
  if (Array.isArray(v)) {
    const items = v.map((x) => normalize(x, [...path, LIST_INDEX]));
    // SPEC §17.2 totality: set semantics only for the conforming all-string
    // shape; a non-string member leaves the array verbatim.
    if (isSet(path) && items.every((x) => typeof x === 'string')) return [...new Set(items)].sort(utf8cmp);
    return items;
  }
  if (v && typeof v === 'object') {
    const out = {};
    // JCS object member order: UTF-16 code-unit sequence == JS default string <.
    for (const k of Object.keys(v).sort()) out[k] = normalize(v[k], [...path, k]);
    return out;
  }
  return v;
}

function jcs(v) {
  // RFC 8785 §3.2.2 serializes strings and numbers as ES6 JSON.stringify does.
  return JSON.stringify(v);
}

let fails = 0, checked = 0;
for (const v of doc.vectors) {
  if (v.expectError) continue;
  const { revision, ...rest } = v.input;
  const canonical = jcs(normalize(rest));
  const h = createHash('sha256').update(canonical, 'utf8').digest();
  const digest = 'sha256:' + h.toString('base64url');
  checked++;
  if (canonical !== v.canonicalJson) {
    fails++;
    console.log(`CANONICAL MISMATCH ${v.name}\n  node: ${canonical}\n  file: ${v.canonicalJson}`);
  }
  if (digest !== v.digest) {
    fails++;
    console.log(`DIGEST MISMATCH ${v.name}\n  node: ${digest}\n  file: ${v.digest}`);
  }
  if (h.toString('hex') !== v.sha256Hex) {
    fails++;
    console.log(`HEX MISMATCH ${v.name}`);
  }
}

for (const s of doc.sortVectors) {
  const got = [...new Set(s.input)].sort(utf8cmp);
  checked++;
  if (JSON.stringify(got) !== JSON.stringify(s.sorted)) {
    fails++;
    console.log(`SORT MISMATCH ${s.name}\n  node: ${JSON.stringify(got)}\n  file: ${JSON.stringify(s.sorted)}`);
  }
  const naive = [...new Set(s.input)].sort();
  if (JSON.stringify(naive) !== JSON.stringify(s.sorted)) {
    console.log(`  (note) ${s.name}: default JS sort() DIVERGES -> ${JSON.stringify(naive)}`);
  }
}

console.log(fails === 0 ? `NODE CROSS-CHECK OK (${checked} checks)` : `NODE CROSS-CHECK FAILED (${fails})`);
process.exit(fails === 0 ? 0 : 1);
