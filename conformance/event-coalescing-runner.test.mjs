// Synthetic observations exercise the checker, not a substitute coalescing Host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { check, validateCheck, runScenario } from './check-event-coalescing.mjs';

const observed = () => ({
  contexts: { agent: [{ content: [{ type: 'text', text: 'NEW' }], metadata: { eventId: 'edit', messageId: 'M' } }] },
  requests: [{ model: 'fixture-agent', messages: [{ content: [{ type: 'text', text: 'FIRST SECOND' }] }] }],
  modelCalls: 1, renders: [], reply: { result: { accepted: true, coalesce: { outcome: 'appended' } } },
});
const expect = (e, out = observed(), history = new Map()) => check(e, out, history, {});
test('both permitted outcomes pass while an invented outcome fails', () => {
  const e = { path: 'reply.result.coalesce.outcome', oneOf: ['appended', 'replaced'] };
  expect(e);
  const out = observed(); out.reply.result.coalesce.outcome = 'replaced'; expect(e, out);
  out.reply.result.coalesce.outcome = 'noted'; assert.throws(() => expect(e, out));
});
test('receipt comparison uses the observed earlier result', () => {
  const before = observed(), after = observed();
  expect({ path: 'reply.result', sameAs: 'accepted.reply.result' }, after, new Map([['accepted', before]]));
  after.reply.result.accepted = false;
  assert.throws(() => expect({ path: 'reply.result', sameAs: 'accepted.reply.result' }, after, new Map([['accepted', before]])));
});
test('duplicate and reversed recovered occurrences fail', () => {
  const e = { path: 'requestText', recoveryContent: ['FIRST', 'SECOND'] };
  expect(e);
  const out = observed(); out.requests[0].messages = ['SECOND']; expect(e, out);
  out.requests[0].messages = ['FIRST FIRST SECOND']; assert.throws(() => expect(e, out), /duplicate/);
  out.requests[0].messages = ['SECOND FIRST']; assert.throws(() => expect(e, out), /order/);
});
test('private or superseded content in any provider request fails', () => {
  const e = { path: 'allRequestText', excludes: ['PRIVATE_DATA'] };
  expect(e);
  const out = observed();
  out.requests.unshift({ model: 'fixture-agent', messages: ['PRIVATE_DATA'] });
  assert.throws(() => expect(e, out), /unexpected/);
});
test('provider content counts and order have independent failures', () => {
  expect({ path: 'requestText', counts: { FIRST: 1 }, order: ['FIRST', 'SECOND'] });
  assert.throws(() => expect({ path: 'requestText', counts: { FIRST: 2 } }));
  assert.throws(() => expect({ path: 'requestText', order: ['SECOND', 'FIRST'] }));
});
test('reply identity is checked on all stored copies of the event', () => {
  expect({ event: 'edit', metadata: { messageId: 'M' } });
  const out = observed(); out.contexts.b = [{ metadata: { eventId: 'edit', messageId: 'wrong' } }];
  assert.throws(() => expect({ event: 'edit', metadata: { messageId: 'M' } }, out));
});
test('model-specific baseline checks cannot pass on another recipient', () => {
  expect({ model: 'fixture-agent', order: ['FIRST', 'SECOND'] });
  assert.throws(() => expect({ model: 'fixture-b', order: ['FIRST', 'SECOND'] }), /no observed/);
});
test('unknown or empty expectation operators are fixture errors', () => {
  assert.throws(() => validateCheck({ path: 'modelCalls', equals: 1 }), /Unknown/);
  assert.throws(() => validateCheck({ path: 'modelCalls' }), /must assert/);
});
function fakeAdapter(step) {
  let closed = false, opened = false;
  return {
    profile: { capabilities: [] }, get closed() { return closed; }, get opened() { return opened; },
    async open() { opened = true; return { step, async close() { closed = true; } }; },
  };
}
const entry = { id: 'fixture', kind: 'host', contract: 'Synthetic checker regression' };
const variant = { name: 'test', requires: [], setup: {}, steps: [{ id: 's0', op: 'observe', checks: [{ path: 'modelCalls', eq: 0 }] }] };
test('a Host assertion failure is separate from execution failure and cleans up', async () => {
  const adapter = fakeAdapter(async () => observed());
  const result = await runScenario(adapter, entry, variant);
  assert.equal(result.status, 'fail');
  assert.equal(result.failures.length, 1);
  assert.equal(result.executionError, undefined);
  assert.equal(adapter.closed, true);
});
test('transport or fixture failure cannot be reported as a conformance failure', async () => {
  const adapter = fakeAdapter(async () => { throw new Error('wire timeout'); });
  const result = await runScenario(adapter, entry, variant);
  assert.equal(result.status, 'execution-error');
  assert.equal(result.failures.length, 0);
  assert.equal(adapter.closed, true);
});
test('missing profile preconditions are unexercised, not passes', async () => {
  const adapter = fakeAdapter(async () => observed());
  const result = await runScenario(adapter, entry, { ...variant, requires: ['alternate-window'] });
  assert.equal(result.status, 'unexercised');
  assert.deepEqual(result.missing, ['alternate-window']);
  assert.equal(adapter.opened, false);
});
test('supporting evidence and audit observations stay distinct from a full-case pass', async () => {
  const v = { ...variant, steps: [{ id: 's0', op: 'observe' }], evidenceBoundary: 'Narrower than the principal scenario.' };
  assert.equal((await runScenario(fakeAdapter(async () => observed()), entry, v)).status, 'supporting-pass');
  assert.equal((await runScenario(fakeAdapter(async () => observed()), { ...entry, kind: 'advisory' }, v)).status, 'observed');
});
test('exactly one recovered materialization permits either form, never both or duplicate', () => {
  const e = { path: 'requestText', exactlyOneOf: ['FALLBACK', 'RENDERED'] };
  const out = observed();
  for (const text of ['FALLBACK', 'RENDERED']) { out.requests[0].messages = [text]; expect(e, out); }
  for (const text of ['FALLBACK RENDERED', 'RENDERED RENDERED', '']) {
    out.requests[0].messages = [text]; assert.throws(() => expect(e, out));
  }
});
