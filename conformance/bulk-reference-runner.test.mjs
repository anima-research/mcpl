// These are harness regression tests, not another Host implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
});
test('the refused file: case names a payload a Host could read whole', () => {
  const ceiling = structuredClone(corpus); ceiling.cases.find(c => c.id === '11-file-refused').maxBytes = 8;
  assert.throws(() => assertCorpus(ceiling), /11-file-refused: the local payload must be readable whole/);
  const declared = structuredClone(corpus); declared.cases.find(c => c.id === '11-file-refused').blocks[0].sizeBytes = 12;
  assert.throws(() => assertCorpus(declared), /11-file-refused: the local payload must be readable whole/);
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
});
test('partial bytes from a refused fetch cannot pass', () => {
  const c = { ...vector, operation: 'fetch', expect: { ...vector.expect, ok: false, requests: 0 } };
  const out = { ...refused(), saves: [{ name: 'partial' }] };
  assert.throws(() => check(c, out), /partial/);
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
  // Each of these errors is wrong in one way only.
  for (const wrong of [{ ...error, success: true }, { ...error, isError: false }, { ...error, error: 'not found' }]) {
    assert.throws(() => check(c, { ...out, unknownError: wrong }), JSON.stringify(wrong));
  }
  assert.throws(() => check(c, { ...out, evictedError: { ...error, error: 'unknown reference https://example.invalid/a' } }), /forbidden value #1 in the evicted lookup error/);
});
for (const lane of ['push', 'wake', 'history']) {
  test('raw control and bidi characters are checked in ' + lane + ' values', () => {
    const c = { ...vector, expect: { ...vector.expect, cleanLabel: true } };
    for (const value of ['\u0000', '\u0007', '\u0085', '\u202e', '\u061c']) {
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
  const label = 'a'.repeat(255);
  const c = { ...vector, blocks: [{ ...vector.blocks[0], name: label }], expect: { ...vector.expect, displayField: 'name' } };
  const render = text => {
    const out = observation();
    out.before = { push: [{ type: 'text', text }], wake: text, history: text };
    return out;
  };
  for (const marker of ['…', '[truncated]']) {
    const profile = { ...adapter, maxViewChars: 1024, displayProfile: { fieldChars: { name: 120 }, truncationMarkers: [marker] } };
    check(c, render('[ref_fixture] ' + 'a'.repeat(119) + marker), network, profile);
    check(c, render('[ref_fixture] ' + 'a'.repeat(120) + marker), network, profile);
    assert.throws(() => check(c, render('[ref_fixture] ' + 'a'.repeat(120)), network, profile), /must be marked/);
    // The mark belongs at the end of the label as shown, not elsewhere.
    assert.throws(() => check(c, render('[ref_fixture] ' + 'a'.repeat(100) + ' x' + marker), network, profile), /must be marked/);
    assert.throws(() => check(c, render('[ref_fixture] ' + label + marker), network, profile), /past the declared display limit/);
  }
  const wider = { ...adapter, maxViewChars: 1024, displayProfile: { fieldChars: { name: 255 }, truncationMarkers: ['[truncated]'] } };
  check(c, render('[ref_fixture] ' + label), network, wider);
  assert.throws(() => check(c, render('[ref_fixture] ' + 'a'.repeat(200) + '[truncated]'), network, wider), /shown whole/);
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
test('a tab or line break is unsafe only when the label holds one', () => {
  const c = { ...vector, expect: { ...vector.expect, cleanLabel: true } };
  const laidOut = observation(); laidOut.before.history += '\n\t(attachment)\r\n';
  check(c, laidOut);
  const named = { ...c, blocks: [{ ...c.blocks[0], name: 'two\nlines' }] };
  assert.throws(() => check(named, laidOut), /unsafe display-label characters in before history/);
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
