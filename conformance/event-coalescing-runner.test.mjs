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
test('recovery receipt and content must choose the same permitted branch', () => {
  const e = { path: 'requestText', recoveryContent: ['FIRST', 'SECOND'], recoveryFrom: 'receipt.reply.result.coalesce.outcome' };
  const appended = observed(), replaced = observed(); replaced.reply.result.coalesce.outcome = 'replaced';
  const withReceipt = (out, receipt) => expect(e, out, new Map([['receipt', receipt]]));
  withReceipt(observed(), appended);
  const out = observed(); out.requests[0].messages = ['SECOND']; withReceipt(out, replaced);
  assert.throws(() => withReceipt(out, appended), /FIRST/);
  out.requests[0].messages = ['FIRST SECOND']; assert.throws(() => withReceipt(out, replaced), /FIRST/);
  out.requests[0].messages = ['FIRST FIRST SECOND']; assert.throws(() => withReceipt(out, appended));
  out.requests[0].messages = ['SECOND FIRST']; assert.throws(() => withReceipt(out, appended), /order/);
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
test('replacement stays in original recipients, including when a nonrecipient already exists', () => {
  const earlier = observed();
  earlier.contexts = { a: [{ content: ['FIRST'] }], b: [] };
  const history = new Map([['audience', earlier]]);
  const e = { audienceFrom: 'audience', original: 'FIRST', replacement: 'EDIT' };
  const current = observed(); current.contexts = { a: [{ content: ['EDIT'] }], b: [], newEmptyContext: [] };
  expect(e, current, history);
  current.contexts = { a: [], b: [{ content: ['EDIT'] }] };
  assert.throws(() => expect(e, current, history), /original recipient/);
  current.contexts = { a: [{ content: ['EDIT'] }], b: [{ content: ['EDIT'] }] };
  assert.throws(() => expect(e, current, history), /widened/);
});
test('two model requests must reach two designated recipients, not duplicate one', () => {
  const out = observed(); out.requests.push({ model: 'fixture-b', messages: ['RENDERED'] });
  expect({ model: 'fixture-agent', requestCount: 1 }, out);
  expect({ model: 'fixture-b', requestCount: 1, includes: ['RENDERED'] }, out);
  out.requests[1].model = 'fixture-agent';
  assert.throws(() => expect({ model: 'fixture-agent', requestCount: 1 }, out));
  assert.throws(() => expect({ model: 'fixture-b', requestCount: 1 }, out));
});
test('an explicitly unread recipient must have zero earlier requests', () => {
  const out = observed();
  expect({ model: 'fixture-agent', requestCount: 1 }, out);
  expect({ model: 'fixture-b', requestCount: 0 }, out);
  out.requests[0].model = 'fixture-b';
  assert.throws(() => expect({ model: 'fixture-b', requestCount: 0 }, out));
});
test('an exclusion-only assembly cannot pass without a new provider request', async () => {
  const out = { ...observed(), requests: [], modelCalls: 0, runError: null };
  const v = { ...variant, steps: [{ id: 'assembly', op: 'assemble', checks: [{ path: 'requestText', excludes: ['WITHDRAWN'] }] }] };
  const result = await runScenario(fakeAdapter(async () => out), entry, v);
  assert.equal(result.status, 'execution-error');
  assert.match(result.executionError.error, /no new provider request/);
});
test('unexpected drive errors cannot be hidden behind successful content exclusions', async () => {
  const out = { ...observed(), runError: 'injected assembly error' };
  const v = { ...variant, steps: [{ id: 'assembly', op: 'assemble', checks: [{ path: 'requestText', excludes: ['WITHDRAWN'] }] }] };
  const result = await runScenario(fakeAdapter(async () => out), entry, v);
  assert.equal(result.status, 'execution-error');
  assert.match(result.executionError.error, /injected/);
});
test('the expected model-failure scenario needs a failing request containing its input', async () => {
  let calls = 0;
  const v = { ...variant, steps: [
    { id: 'armed', op: 'failNextModel' },
    { id: 'run', op: 'turn', expectedModelFailureSince: 'armed', checks: [{ path: 'requestText', includes: ['FIRST'] }] },
  ] };
  const adapter = fakeAdapter(async () => ++calls === 1
    ? { ...observed(), requests: [], modelFailures: 0 }
    : { ...observed(), modelFailures: 1, runError: 'expected fixture model failure' });
  assert.equal((await runScenario(adapter, entry, v)).status, 'pass');
  const noFailure = fakeAdapter(async () => ({ ...observed(), modelFailures: 0, runError: null }));
  assert.equal((await runScenario(noFailure, entry, v)).status, 'execution-error');
});
test('advisory runs retain readouts even when the step has no mandatory assertion', async () => {
  const v = { ...variant, steps: [{ id: 'audit', op: 'observe' }] };
  const result = await runScenario(fakeAdapter(async () => ({ ...observed(), trace: [{ type: 'fixture-audit' }] })), { ...entry, kind: 'advisory' }, v);
  assert.equal(result.status, 'observed');
  assert.deepEqual(result.observations[0].observed.trace, [{ type: 'fixture-audit' }]);
});
