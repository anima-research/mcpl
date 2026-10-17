// These are harness regression tests, not another Host implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expand, checkObservation, assertCorpus } from './check-bulk-references.mjs';

const corpus = JSON.parse(readFileSync(new URL('./bulk-reference-vectors.json', import.meta.url), 'utf8'));
const token = corpus.fixtures.token;
const adapter = { maxViewChars: 256, credentialPolicy: 'connection-bearer' };
const network = { requests: [], redirected: [] };
const vector = {
  operation: 'render',
  blocks: [{ type: 'resource', uri: 'https://example.invalid/payload', disposition: 'never' }],
  expect: { stub: true, hidden: ['https://example.invalid/payload', 'payload-secret'] },
};
const record = { refId: 'ref_fixture', testimony: { disposition: 'never' } };
function observation() {
  return {
    parsed: [{ kind: 'reference', testimony: { disposition: 'never', rejectedFields: [] } }],
    records: [structuredClone(record)],
    before: { push: [{ type: 'text', text: '[ref_fixture] attachment' }], wake: '[ref_fixture] attachment', history: '[ref_fixture] attachment' },
  };
}
const refused = () => ({ ...observation(), after: structuredClone(observation().before), outcome: { ok: false, error: 'refused' }, tool: { success: false, isError: true, error: 'refused' }, saves: [] });
function check(c = vector, out = observation(), net = network, profile = adapter) { checkObservation(c, out, net, profile, token); }

test('compact vectors expand strings and preserve numeric boundaries', () => {
  assert.deepEqual(expand({ uri: '$ORIGIN/file', big: { $repeat: 'a', count: 1048576 }, max: 9007199254740991 }, 'http://loopback'),
    { uri: 'http://loopback/file', big: 'a'.repeat(1048576), max: 9007199254740991 });
  assert.equal(expand({ $repeat: '$CASE/', count: 2 }, 'http://loopback', 'a b'), 'a%20b/a%20b/');
  assert.equal(expand({ $repeat: 'a', count: 2 ** 21 }, '').length, 2 ** 21);
  assert.throws(() => expand({ $repeat: 'a', count: -1 }, ''), /\$repeat count must be an integer from 0 to 2\^21/);
  assert.throws(() => expand({ $repeat: 'a', count: 2 ** 21 + 1 }, ''), /\$repeat count must be an integer from 0 to 2\^21/);
  assert.throws(() => expand({ $repeat: 'a', count: 1, extra: true }, ''), /\$repeat takes only count beside it/);
});
test('the frozen corpus has its documented shape', () => {
  assertCorpus(corpus);
  const dropped = structuredClone(corpus); dropped.cases.splice(dropped.cases.findIndex(c => c.id === '04-claim-at-ceiling'), 1);
  assert.throws(() => assertCorpus(dropped), /frozen cases per RFC row/);
  const misspelt = structuredClone(corpus); misspelt.cases[0].expect.boundd = true;
  assert.throws(() => assertCorpus(misspelt), /unknown expectation boundd/);
  const staged = structuredClone(corpus); staged.cases.find(c => c.expect.before).expect.before.ok = true;
  assert.throws(() => assertCorpus(staged), /unknown before expectation ok/);
  const negative = structuredClone(corpus); negative.cases[0].expect.stub = false;
  assert.throws(() => assertCorpus(negative), /stub expectation is true or absent/);
  const shared = structuredClone(corpus); shared.cases[1].blocks[0].uri = '$ORIGIN/case/01-never/payload';
  assert.throws(() => assertCorpus(shared), /URI shared with 01-never/);
  const undeclared = structuredClone(corpus); delete undeclared.cases.find(c => c.id === '03-verified-never').expect.decodedBase64;
  assert.throws(() => assertCorpus(undeclared), /03-verified-never: a successful fetch declares its decodedBase64/);
  const empty = structuredClone(corpus); empty.cases.find(c => c.expect.after?.stubOrInlineBase64).expect.after.stubOrInlineBase64 = '';
  assert.throws(() => assertCorpus(empty), /stubOrInlineBase64 must decode to bytes/);
});
test('a refused local case names a payload a Host could read whole', () => {
  const edited = (id, edit) => { const copy = structuredClone(corpus); edit(copy.cases.find(c => c.id === id)); return copy; };
  for (const id of ['11-file-refused', '11-data-refused']) {
    const fails = new RegExp(id + ': a local URI must name a payload readable whole within the case');
    assert.throws(() => assertCorpus(edited(id, c => { c.maxBytes = 8; })), fails);
    assert.throws(() => assertCorpus(edited(id, c => { c.blocks[0].sizeBytes = 12; })), fails);
  }
  // Any file: URI is held to it, however it is spelt: here the corpus itself, past the ceiling.
  const literal = edited('11-file-refused', c => { c.blocks[0].uri = new URL('./bulk-reference-vectors.json', import.meta.url).href; });
  assert.throws(() => assertCorpus(literal), /11-file-refused: a local URI must name a payload readable whole/);
  // The scheme is read as the URL parser reads it, in capitals after leading space:
  // the payload is measured whole, and a wrong declared size is refused.
  const respell = (id, uri) => c => { c.blocks[0].uri = uri(expand(c, 'http://origin.invalid').blocks[0].uri); };
  for (const [id, uri] of [['11-data-refused', u => ' DATA:' + u.slice('data:'.length)], ['11-file-refused', u => ' FILE:' + u.slice('file:'.length)]]) {
    assertCorpus(edited(id, respell(id, uri)));
    assert.throws(() => assertCorpus(edited(id, c => { respell(id, uri)(c); c.blocks[0].sizeBytes = 12; })),
      new RegExp(id + ': a local URI must name a payload readable whole'));
  }
  // A data: payload decodes as fetch() decodes it: percent-escapes bytewise, the
  // fragment dropped, then forgiving-base64 if the type says so.
  const dataUri = (uri, size = 19) => edited('11-data-refused', c => { c.blocks[0].uri = uri; c.blocks[0].sizeBytes = size; });
  assertCorpus(dataUri('data:audio/wav;case=11-data-refused,RIFF0000WAVEpayload'));
  assertCorpus(dataUri('data:audio/wav;case=11-data-refused,%FF', 1));
  assertCorpus(dataUri('data:audio/wav;case=11-data-refused;base64,UklGRjAwMDBXQVZFcGF5bG9hZA==#ignored'));
  // A local URI fetch() couldn't read names no payload, so a refused case can't rest
  // on it. Each declares the size a looser reading would give it.
  for (const [uri, size] of [['data:audio/wav;case=11-data-refused;base64,AA-_', 3], ['data:audio/wav;case=11-data-refused', 30], ['file://exa mple/x.wav', 19]]) {
    assert.throws(() => assertCorpus(dataUri(uri, size)), /11-data-refused: a local URI must name a payload readable whole/, uri);
  }
});
test('an observed bounded reference stub passes', () => { check(); });
for (const lane of ['push', 'wake', 'history']) {
  test('URI and payload leak is detected on ' + lane, () => {
    for (const leak of vector.expect.hidden) {
      const out = observation();
      if (lane === 'push') out.before.push.push({ type: 'text', text: leak });
      else out.before[lane] += leak;
      assert.throws(() => check(vector, out), /forbidden/);
    }
  });
  test('an oversized ' + lane + ' view is detected', () => {
    const out = observation();
    if (lane === 'push') out.before.push.push({ type: 'text', text: 'x'.repeat(300) });
    else out.before[lane] += 'x'.repeat(300);
    assert.throws(() => check(vector, out), /display bound/);
  });
}
test('a forbidden value is named by position, never printed', () => {
  const out = observation(); out.before.wake += 'payload-secret';
  assert.throws(() => check(vector, out), error => /forbidden value #2 in before wake/.test(error.message) && !error.message.includes('payload-secret'));
});
test('a forbidden value in its JSON-escaped form is detected', () => {
  const c = { ...vector, expect: { ...vector.expect, hidden: ['say "secret"'] } };
  const out = observation(); out.before.history += JSON.stringify({ text: 'say "secret"' });
  assert.throws(() => check(c, out), /forbidden/);
});
test('push values include object keys, and an included text must sit within one piece', () => {
  const out = observation(); out.before.push.push({ 'payload-secret': true });
  assert.throws(() => check(vector, out), /forbidden/);
  const c = { ...vector, expect: { ...vector.expect, includes: ['event text'] } };
  const split = observation(); split.before.push.push({ type: 'text', text: 'event ' }, { type: 'text', text: 'text' });
  split.before.wake += 'event text'; split.before.history += 'event text';
  assert.throws(() => check(c, split), /missing text: event text/);
});
test('receipt-triggered fetch and missing id cannot produce a pass', () => {
  assert.throws(() => check(vector, observation(), { requests: [{}] }), /dereference/);
  const out = observation(); out.before.wake = 'missing';
  assert.throws(() => check(vector, out), /identify/);
});
test('optional-field truncation cannot pass as rejection', () => {
  const c = structuredClone(vector); c.expect.missingFields = ['name'];
  const out = observation(); out.parsed[0].testimony.name = 'truncated';
  assert.throws(() => check(c, out), /absent/);
  const widened = observation(); delete widened.parsed[0].testimony.disposition;
  assert.throws(() => check(c, widened), /subtractive disposition survives/);
});
test('a rejected field shown in a lane cannot pass', () => {
  const c = structuredClone(vector); c.expect.missingFields = ['name'];
  c.blocks[0].name = 'n'.repeat(256);
  for (const lane of ['push', 'wake', 'history']) {
    const out = observation();
    if (lane === 'push') out.before.push[0].text += 'n'.repeat(120) + '…';
    else out.before[lane] += 'n'.repeat(120) + '…';
    assert.throws(() => check(c, out), /rejected name shown in before /, lane);
  }
  // Shown in its JSON-escaped form, as a serialized lane carries it.
  const quoted = structuredClone(c); quoted.blocks[0].name = 'say "hi" ' + 'n'.repeat(247);
  const escaped = observation(); escaped.before.history += JSON.stringify({ name: quoted.blocks[0].name.slice(0, 120) });
  assert.throws(() => check(quoted, escaped), /rejected name shown in before history/);
  // Every block's rejected value counts, not only the first block's.
  const second = structuredClone(c);
  second.blocks = [{ ...c.blocks[0], name: 'short.wav' }, { ...c.blocks[0], uri: 'https://example.invalid/second', name: 'm'.repeat(256) }];
  const out = observation(); out.before.wake += 'm'.repeat(120) + '…';
  assert.throws(() => check(second, out), /rejected name shown in before wake/);
});
test('partial bytes from a refused fetch cannot pass', () => {
  const c = { ...vector, operation: 'fetch', expect: { ...vector.expect, ok: false, requests: 0 } };
  const out = { ...refused(), saves: [{ name: 'partial' }] };
  assert.throws(() => check(c, out), /partial/);
  const pathed = refused(); pathed.records[0].fetchedPath = 'scratch/refs/ref_fixture.wav';
  assert.throws(() => check(c, pathed), /failed fetch leaves no fetched path/);
  const verified = refused(); verified.records[0].verifiedBytes = 19;
  assert.throws(() => check(c, verified), /failed fetch verifies no bytes/);
});
test('the fetch_reference result is checked as model-visible text', () => {
  const c = { ...vector, operation: 'fetch', expect: { ...vector.expect, ok: false, requests: 0 } };
  check(c, refused());
  assert.throws(() => check(c, { ...refused(), tool: { success: false, isError: true, error: 'cannot reach https://example.invalid/payload' } }), /forbidden value #1 in the fetch_reference result/);
  assert.throws(() => check(c, { ...refused(), tool: { success: true, data: '{}' } }), /reports the fetch outcome/);
  assert.throws(() => check(c, { ...refused(), tool: undefined }), /fetch_reference result/);
});
test('cross-origin forwarding of a connection credential cannot pass', () => {
  const c = { ...vector, operation: 'fetch', expect: { ...vector.expect, redirectSafe: true } };
  const net = { requests: [{ authorization: 'Bearer ' + token }], redirected: [{ authorization: 'Bearer ' + token }] };
  assert.throws(() => check(c, refused(), net), /credential leak/);
  // The redirect is exercised, and followed at most one hop.
  check(c, refused(), { requests: [{ authorization: 'Bearer ' + token }], redirected: [{ authorization: null }] });
  assert.throws(() => check(c, refused(), { requests: [{ authorization: 'Bearer ' + token }], redirected: [{ authorization: null }, { authorization: null }] }), /redirect traversal must be bounded/);
  assert.throws(() => check(c, refused(), { requests: [], redirected: [] }), /initial redirect response must be exercised/);
});
test('a continued stream must close before its producer finishes', () => {
  const c = { ...vector, operation: 'fetch', response: { stream: { chunks: 64 } }, expect: { ...vector.expect, abortStream: true } };
  const net = { ...network, requests: [{ authorization: 'Bearer ' + token }] };
  assert.throws(() => check(c, refused(), { ...net, streamClosed: true, chunksSent: 64 }), /buffer/);
  assert.throws(() => check(c, refused(), { ...net, streamClosed: false, chunksSent: 3 }), /stream must close on abort/);
  check(c, refused(), { ...net, streamClosed: true, chunksSent: 3 });
});
test('an evicted-id alias, a missing live id or an undefined tool error cannot pass', () => {
  const c = { operation: 'registry', blocks: [{ uri: 'https://example.invalid/a' }], expect: { hidden: ['https://example.invalid/a'] } };
  const error = { success: false, isError: true, error: 'unknown reference' };
  const out = {
    firstId: 'old', stableId: 'old', ids: ['old', 'new'], fresh: { refId: 'new', testimony: { uri: c.blocks[0].uri } }, live: 'new',
    evicted: null, unknown: null, evictedError: error, unknownError: error,
  };
  check(c, out);
  assert.throws(() => check(c, { ...out, fresh: { ...out.fresh, refId: 'old' }, live: 'old' }), /reused/);
  assert.throws(() => check(c, { ...out, live: null }), /live id resolves/);
  // Each registry rule fails on its own fault.
  const faults = [
    [{ stableId: 'other' }, /keeps a live reference stable/],
    [{ evicted: { refId: 'old' } }, /evicted reference must be a defined miss/],
    [{ unknown: { refId: 'ref_unknown_fixture' } }, /unknown reference must be a defined miss/],
    [{ ids: ['old', 'new', 'new'] }, /distinct id/],
    [{ fresh: { ...out.fresh, testimony: { uri: 'https://example.invalid/b' } } }, /fresh record is for the same URI/],
  ];
  for (const [fault, pattern] of faults) assert.throws(() => check(c, { ...out, ...fault }), pattern);
  // A lookup error is model-visible: no unsafe label character, no rejected value.
  const labelled = { ...c, expect: { ...c.expect, cleanLabel: true } };
  check(labelled, out);
  assert.throws(() => check(labelled, { ...out, unknownError: { ...error, error: 'unknown reference \u202e' } }), /unsafe display-label characters in the unknown lookup error/);
  const rejected = { ...c, blocks: [{ ...c.blocks[0], name: 'n'.repeat(256) }], expect: { ...c.expect, missingFields: ['name'] } };
  check(rejected, out);
  assert.throws(() => check(rejected, { ...out, evictedError: { ...error, error: 'unknown reference ' + 'n'.repeat(16) } }), /rejected name shown in the evicted lookup error/);
  // Each of these errors is wrong in one way only.
  for (const wrong of [{ ...error, success: true }, { ...error, isError: false }, { ...error, error: 'not found' }]) {
    assert.throws(() => check(c, { ...out, unknownError: wrong }), JSON.stringify(wrong));
  }
  assert.throws(() => check(c, { ...out, evictedError: { ...error, error: 'unknown reference https://example.invalid/a' } }), /forbidden value #1 in the evicted lookup error/);
});
for (const lane of ['push', 'wake', 'history']) {
  test('raw control and bidi characters are checked in ' + lane + ' values', () => {
    const c = { ...vector, expect: { ...vector.expect, cleanLabel: true } };
    for (const value of ['\u0000', '\u0007', '\u0008', '\u000b', '\u000c', '\u000e', '\u001f', '\u007f', '\u0085', '\u009f', '\u061c',
      '\u200e', '\u200f', '\u202a', '\u202d', '\u202e', '\u2066', '\u2069']) {
      const out = observation();
      if (lane === 'push') out.before.push[0].text += value;
      else out.before[lane] += value;
      assert.throws(() => check(c, out), /unsafe display-label/);
    }
  });
  test('mismatched payload cannot appear before or after fetch in ' + lane, () => {
    const c = {
      ...vector, operation: 'fetch',
      expect: { ...vector.expect, ok: false, requests: 0, hidden: ['mismatched-body', 'bWlzbWF0Y2hlZC1ib2R5'] },
    };
    for (const stage of ['before', 'after']) {
      for (const body of c.expect.hidden) {
        const out = refused();
        if (lane === 'push') out[stage].push[0].text += body;
        else out[stage][lane] += body;
        assert.throws(() => check(c, out), /forbidden/);
      }
    }
  });
}
test('truncation markers and thresholds come from the declared display profile', () => {
  // A letter in neither the stub's text nor any marker, so no label character occurs by chance.
  const label = 'z'.repeat(255);
  const c = { ...vector, blocks: [{ ...vector.blocks[0], name: label }], expect: { ...vector.expect, displayField: 'name' } };
  const render = text => {
    const out = observation();
    out.before = { push: [{ type: 'text', text }], wake: text, history: text };
    return out;
  };
  for (const marker of ['…', '[truncated]']) {
    const profile = { ...adapter, maxViewChars: 1024, displayProfile: { fieldChars: { name: 120 }, truncationMarkers: [marker] } };
    check(c, render('[ref_fixture] ' + 'z'.repeat(119) + marker), network, profile);
    check(c, render('[ref_fixture] ' + 'z'.repeat(120) + marker), network, profile);
    assert.throws(() => check(c, render('[ref_fixture] ' + 'z'.repeat(120)), network, profile), /must be marked/);
    // The mark belongs at the end of the label as shown, not elsewhere.
    assert.throws(() => check(c, render('[ref_fixture] ' + 'z'.repeat(100) + ' x' + marker), network, profile), /must be marked/);
    assert.throws(() => check(c, render('[ref_fixture] ' + label + marker), network, profile), /past the declared display limit/);
    // A mark alone doesn't show the field.
    assert.throws(() => check(c, render('[ref_fixture] ' + marker), network, profile), /over the display limit must still be shown/);
  }
  const wider = { ...adapter, maxViewChars: 1024, displayProfile: { fieldChars: { name: 255 }, truncationMarkers: ['[truncated]'] } };
  check(c, render('[ref_fixture] ' + label), network, wider);
  assert.throws(() => check(c, render('[ref_fixture] ' + 'z'.repeat(200) + '[truncated]'), network, wider), /shown whole/);
});
const corpusCase = id => expand(corpus.cases.find(c => c.id === id), 'http://fixture.invalid');
const viewOf = text => ({ push: [{ type: 'text', text }], wake: text, history: text });
const addVisible = (view, lane, text) => { if (lane === 'push') view.push[0].text += text; else view[lane] += text; };
function successfulVerifiedReference(c) {
  const out = observation(), data = c.expect.decodedBase64;
  out.after = structuredClone(out.before);
  Object.assign(out.records[0], { fetchedPath: 'scratch/ref_fixture.wav', verifiedBytes: Buffer.from(data, 'base64').length, verifiedMimeType: 'audio/wav', digestVerified: true });
  out.outcome = { ok: true, path: out.records[0].fetchedPath, bytes: out.records[0].verifiedBytes, mimeType: 'audio/wav', digestVerified: true };
  out.tool = { success: true, data: JSON.stringify({ path: out.outcome.path, bytes: out.outcome.bytes, mime_type: 'audio/wav', digest_verified: true }) };
  out.saves = [{ name: 'ref_fixture.wav', base64: data, mimeType: 'audio/wav' }];
  return out;
}
const authenticatedRequest = { requests: [{ authorization: 'Bearer ' + token }], redirected: [] };
test('a Host that reads local URIs fails the refused file: and data: cases', async () => {
  const readers = [
    ['11-file-refused', 'opens the file: URI', async uri => readFileSync(fileURLToPath(uri))],
    ['11-data-refused', 'fetches the data: URI', async uri => Buffer.from(await (await fetch(uri)).arrayBuffer())],
  ];
  for (const [id, how, read] of readers) {
    const c = corpusCase(id);
    const bytes = await read(c.blocks[0].uri);
    assert.ok(bytes.length > 0 && bytes.length <= c.maxBytes, 'a Host that ' + how + ' reads the payload whole within the ceiling');
    const out = successfulVerifiedReference({ ...c, expect: { ...c.expect, decodedBase64: bytes.toString('base64') } });
    assert.throws(() => check(c, out, { requests: [], redirected: [] }), /fetch outcome succeeded/, 'a Host that ' + how + ' fails ' + id);
  }
});
test('the refused local cases hide their payload and leave the stub unchanged', () => {
  for (const id of ['11-file-refused', '11-data-refused']) {
    const c = corpusCase(id);
    check(c, refused());
    for (const echo of ['RIFF0000WAVEpayload', 'UklGRjAwMDBXQVZFcGF5bG9hZA==']) {
      const echoed = refused(); echoed.tool.error = 'refused: ' + echo;
      assert.throws(() => check(c, echoed), /forbidden value #\d+ in the fetch_reference result/, id + ' ' + echo);
    }
    const restubbed = refused(); restubbed.after.wake += ' (refused)';
    assert.throws(() => check(c, restubbed), /leave stub unchanged/, id);
  }
  // A Host's read error names the file's path, which holds the file's name, as
  // every spelling of its URI does.
  const file = corpusCase('11-file-refused');
  for (const path of [fileURLToPath(file.blocks[0].uri), new URL(file.blocks[0].uri).pathname]) {
    const named = refused(); named.tool.error = "ENOENT: no such file or directory, open '" + path + "'";
    assert.throws(() => check(file, named), /forbidden value #\d+ in the fetch_reference result/, path);
  }
});
test('a rejected field or an unsafe label in the fetch_reference result cannot pass', () => {
  // The refused fetch's error must not echo the rejected value.
  const field = corpusCase('field-rule-expiresAt');
  check(field, refused());
  const echoed = refused(); echoed.tool.error = 'refused: expiresAt ' + field.blocks[0].expiresAt;
  assert.throws(() => check(field, echoed), /rejected expiresAt shown in the fetch_reference result/);
  // The successful fetch's data must not carry the unsafe label.
  const label = corpusCase('18-label-controls');
  const fetched = () => successfulVerifiedReference({ ...label, expect: { ...label.expect, decodedBase64: label.response.bodyBase64 } });
  check(label, fetched(), authenticatedRequest);
  const unsafe = fetched(); unsafe.tool.data = JSON.stringify({ ...JSON.parse(unsafe.tool.data), name: label.blocks[0].name });
  assert.throws(() => check(label, unsafe, authenticatedRequest), /unsafe display-label characters in the fetch_reference result/);
  // Structured data is read as the model reads it, not as one opaque value.
  const structured = fetched(); structured.tool.data = { name: label.blocks[0].name };
  assert.throws(() => check(label, structured, authenticatedRequest), /unsafe display-label characters in the fetch_reference result/);
});
test("a label's own tab or line break is found, and a Host's own layout passes", () => {
  const c = { ...vector, expect: { ...vector.expect, cleanLabel: true } };
  const laidOut = observation(); laidOut.before.history += '\n\t(attachment)\r\n';
  check(c, laidOut);
  for (const layout of ['\t', '\n', '\r']) {
    const named = { ...c, blocks: [{ ...c.blocks[0], name: 'two' + layout + 'lines' }] };
    // The Host's own layout passes, and so does the label stripped or with a space for the break.
    check(named, laidOut);
    for (const shown of ['twolines', 'two lines']) {
      const out = observation(); out.before.history += '\n' + shown + '\r\n';
      check(named, out);
    }
    // The label's break kept, in its own form or another, fails in every lane and in the result.
    for (const shown of ['two' + layout + 'lines', 'two\r\nlines', 'two\u2028lines']) {
      for (const lane of ['push', 'wake', 'history']) {
        const kept = observation(); addVisible(kept.before, lane, '\n\t' + shown + '\n');
        assert.throws(() => check(named, kept), new RegExp("a display label's tab or line break in before " + lane), JSON.stringify([layout, shown, lane]));
      }
      const fetched = { ...named, operation: 'fetch', expect: { ...named.expect, ok: false, requests: 0 } };
      const result = refused(); result.tool.error = 'refused: ' + shown;
      assert.throws(() => check(fetched, result), /a display label's tab or line break in the fetch_reference result/, JSON.stringify([layout, shown]));
    }
  }
  // A case that checks labels gives its label's break three ASCII letters or digits
  // on each side, so the text looked for doesn't depend on what a Host does with
  // the label's other characters. Exactly three on each side is enough.
  const edited = (id, edit) => { const copy = structuredClone(corpus); edit(copy.cases.find(x => x.id === id)); return copy; };
  const withName = name => x => { x.blocks[0].name = name; };
  assertCorpus(edited('18-label-controls', withName('abc\ndef')));
  for (const name of ['ab\u202ec\ndef', 'abc\nd\u0007ef', 'ab\u00e9\ndef', 'ab\ncdef', 'abc\nde', 'abcdef\n', 'abc\n\ndef', 'abc\u2028de']) {
    assert.throws(() => assertCorpus(edited('18-label-controls', withName(name))),
      /18-label-controls: a label's tab or line break has 3 ASCII letters or digits on each side/, JSON.stringify(name));
  }
  // The rule holds for a case that checks labels at one stage only.
  assert.throws(() => assertCorpus(edited('17-oversized-name', x => { withName('ab\ncdef')(x); x.expect.before = { cleanLabel: true }; })),
    /17-oversized-name: a label's tab or line break has 3 ASCII letters or digits on each side/);
  // A case that doesn't check labels may carry any.
  assertCorpus(edited('17-oversized-name', withName('a\nb')));
  // A result laid out over several lines conforms in both label cases.
  for (const id of ['18-label-device', '18-label-controls']) {
    const label = corpusCase(id);
    const pretty = successfulVerifiedReference({ ...label, expect: { ...label.expect, decodedBase64: label.response.bodyBase64 } });
    pretty.tool.data = JSON.stringify(JSON.parse(pretty.tool.data), null, 2);
    check(label, pretty, authenticatedRequest);
  }
});
test('the verified-ref corpus permits stub or inline only after the fetch', () => {
  const c = corpusCase('03-verified-ref');
  for (const after of ['[ref_fixture] attachment', c.expect.decodedBase64, Buffer.from(c.expect.decodedBase64, 'base64').toString('utf8')]) {
    const out = successfulVerifiedReference(c);
    out.after = viewOf(after);
    check(c, out, authenticatedRequest);
  }
  const out = successfulVerifiedReference(c); out.after = viewOf('neither');
  assert.throws(() => check(c, out, authenticatedRequest), /may inline or retain its stub/);
  const missing = successfulVerifiedReference(c); delete missing.after;
  assert.throws(() => check(c, missing, authenticatedRequest), /post-fetch/);
});
test('each successful-fetch rule fails on its own fault', () => {
  const c = corpusCase('03-verified-never');
  check(c, successfulVerifiedReference(c), authenticatedRequest);
  const faults = [
    [out => { out.saves[0].base64 = Buffer.alloc(19, 120).toString('base64'); }, /saved bytes must be decoded identity octets/],
    [out => { out.saves[0].mimeType = 'image/png'; }, /saved MIME type/],
    [out => { out.records[0].digestVerified = false; }, /record digest verified/],
    [out => { Object.assign(out.outcome, { ok: false, error: 'boom' }); out.tool = { success: false, isError: true, error: 'boom' }; }, /fetch outcome failed: boom/],
  ];
  for (const [fault, pattern] of faults) {
    const out = successfulVerifiedReference(c); fault(out);
    assert.throws(() => check(c, out, authenticatedRequest), pattern);
  }
  // A declared empty body is compared too: the saved bytes must be empty.
  const empty = { ...c, expect: { ...c.expect, decodedBase64: '' } };
  assert.throws(() => check(empty, successfulVerifiedReference(c), authenticatedRequest), /saved bytes must be decoded identity octets/);
  const PAYLOAD = 'UklGRjAwMDBXQVZFcGF5bG9hZA==';
  const stored = (id, name) => {
    const named = corpusCase(id);
    const out = successfulVerifiedReference({ ...named, expect: { ...named.expect, decodedBase64: PAYLOAD } });
    out.saves[0].name = name;
    return [named, out];
  };
  check(...stored('14-path-label', 'ref_fixture.wav'), authenticatedRequest);
  assert.throws(() => check(...stored('14-path-label', 'other.wav'), authenticatedRequest), /storage name must come from reference id/);
  assert.throws(() => check(...stored('14-path-label', 'ref_fixture.x/y'), authenticatedRequest), /storage name cannot contain a path/);
  assert.throws(() => check(...stored('18-label-device', 'ref_fixture.CON'), authenticatedRequest), /server label must not be a storage component/);
});
test('a refused fetch must leave the stub unchanged, and an included text must appear', () => {
  const c = { ...vector, operation: 'fetch', expect: { ...vector.expect, ok: false, requests: 0, unchanged: true } };
  check(c, refused());
  const out = refused(); out.after.wake = '[ref_fixture] attachment saved';
  assert.throws(() => check(c, out), /leave stub unchanged/);
  const included = { ...vector, expect: { ...vector.expect, includes: ['claimed'] } };
  assert.throws(() => check(included, observation()), /missing text: claimed/);
});
test('the expected credential comes from the corpus token', () => {
  const c = corpusCase('03-verified-never');
  assert.throws(() => checkObservation(c, successfulVerifiedReference(c), authenticatedRequest, adapter, 'another-token'), /credential-use profile/);
});
for (const lane of ['push', 'wake', 'history']) {
  test('unverified inline bytes fail in the corpus before-fetch ' + lane + ' view', () => {
    const c = corpusCase('03-verified-ref');
    for (const leaked of [c.expect.decodedBase64, Buffer.from(c.expect.decodedBase64, 'base64').toString('utf8')]) {
      const out = successfulVerifiedReference(c);
      addVisible(out.before, lane, leaked);
      assert.throws(() => check(c, out, authenticatedRequest), /forbidden/);
    }
  });
  test('the inline-contradiction corpus excludes decoded data and URI in ' + lane, () => {
    for (const id of ['02-inline-image', '02-inline-audio', 'schema-both-uri-and-data']) {
      const c = corpusCase(id), block = c.blocks[0];
      const forbidden = [block.data, Buffer.from(block.data, 'base64').toString('utf8'), ...(block.uri ? [block.uri] : [])];
      for (const text of forbidden) {
        const out = observation();
        addVisible(out.before, lane, text);
        assert.throws(() => check(c, out), /forbidden/, id + ' must withhold ' + text);
      }
    }
  });
}
test('same-origin credential omission is permitted under its declared profile', () => {
  const c = corpusCase('03-verified-ref'), out = successfulVerifiedReference(c);
  const omit = { ...adapter, credentialPolicy: 'omit' };
  const anonymous = { requests: [{ authorization: null }], redirected: [] };
  check(c, out, anonymous, omit);
  assert.throws(() => check(c, out, authenticatedRequest, omit), /credential-use profile/);
  assert.throws(() => check(c, out, anonymous, adapter), /credential-use profile/);
});
test('cross-origin credentials remain forbidden under either profile', () => {
  const c = corpusCase('12-cross-origin-redirect');
  for (const policy of ['connection-bearer', 'omit']) {
    const profile = { ...adapter, credentialPolicy: policy };
    const net = { requests: [{ authorization: policy === 'connection-bearer' ? 'Bearer ' + token : null }], redirected: [{ authorization: 'Bearer ' + token }] };
    assert.throws(() => check(c, refused(), net, profile), /cross-origin credential leak/);
  }
});
