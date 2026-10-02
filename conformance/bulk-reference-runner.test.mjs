// These are harness regression tests, not another Host implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { expand, checkObservation } from './check-bulk-references.mjs';

const adapter = { maxViewChars: 256 };
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
function check(c = vector, out = observation(), net = network) { checkObservation(c, out, net, adapter); }

test('compact vectors expand strings and preserve numeric boundaries', () => {
  assert.deepEqual(expand({ uri: '$ORIGIN/file', big: { $repeat: 'a', count: 1048576 }, max: 9007199254740991 }, 'http://loopback'),
    { uri: 'http://loopback/file', big: 'a'.repeat(1048576), max: 9007199254740991 });
  assert.throws(() => expand({ $repeat: 'a', count: -1 }, ''), /false|true|assert/i);
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
test('partial bytes from a refused fetch cannot pass', () => {
  const c = { ...vector, operation: 'fetch', expect: { ...vector.expect, ok: false, requests: 0 } };
  const out = { ...observation(), outcome: { ok: false }, saves: [{ name: 'partial' }] };
  assert.throws(() => check(c, out), /partial/);
});
test('cross-origin forwarding of a connection credential cannot pass', () => {
  const c = { ...vector, operation: 'fetch', expect: { ...vector.expect, redirectSafe: true } };
  const out = { ...observation(), outcome: { ok: false }, saves: [] };
  const net = { requests: [{ authorization: 'Bearer fixture-secret' }], redirected: [{ authorization: 'Bearer fixture-secret' }] };
  assert.throws(() => check(c, out, net), /credential leak/);
});
test('a continued stream must close before its producer finishes', () => {
  const c = { ...vector, operation: 'fetch', response: { stream: { chunks: 64 } }, expect: { ...vector.expect, abortStream: true } };
  const out = { ...observation(), outcome: { ok: false }, saves: [] };
  assert.throws(() => check(c, out, { ...network, streamClosed: true, chunksSent: 64 }), /buffer/);
});
test('both permitted verified-ref presentations pass', () => {
  const c = { ...vector, operation: 'render', expect: { stubOrInlineBase64: 'cGF5bG9hZA==' } };
  check(c);
  const out = observation();
  out.before = { push: [{ type: 'text', text: 'payload' }], wake: 'payload', history: 'payload' };
  check(c, out);
});
test('an evicted-id alias or an undefined tool error cannot pass', () => {
  const c = { operation: 'registry', blocks: [{ uri: 'https://example.invalid/a' }], expect: {} };
  const error = { success: false, isError: true, error: 'unknown reference' };
  const out = {
    firstId: 'old', stableId: 'old', ids: ['old', 'new'], fresh: { refId: 'new', testimony: { uri: c.blocks[0].uri } },
    evicted: null, unknown: null, evictedError: error, unknownError: error,
  };
  check(c, out);
  assert.throws(() => check(c, { ...out, fresh: { ...out.fresh, refId: 'old' } }), /reused/);
  assert.throws(() => check(c, { ...out, unknownError: { success: true } }));
});
