import test from 'node:test';
import assert from 'node:assert/strict';
import { checkReplacementTiming, checkOrdinaryTiming } from './coalescing-timing.mjs';
import { check, runScenario } from './check-event-coalescing.mjs';

const scheduler = { running: true, quiesced: false, gateQuiesced: false };
const request = (at, content) => ({ recipient: 'agent', observedAt: at, assemblyStartedAt: at - 2, messages: [{ content: [{ type: 'text', text: content }] }] });
function run(start, count, deliveredAt) {
  const admissions = Array.from({ length: count }, (_, i) => ({
    sentAt: start + 100 * i, acceptedAt: start + 100 * i + 2, content: 'CURRENT_' + i + '_END',
    receipt: { accepted: true, coalesce: { outcome: i ? 'replaced' : 'first' } },
    binding: 'binding', wire: { server: 'editor', method: 'push/event', params: { featureSet: 'doc', coalesce: { key: 'K' } } },
    decision: { matchedPolicy: 'subject', behavior: 'debounce:300', timestamp: start + 100 * i },
  }));
  return { recipient: 'agent', policyName: 'subject', admissions, trafficEndedAt: start + count * 100 + 2,
    states: Array.from({ length: count + 2 }, () => ({ ...scheduler })),
    requests: [request(deliveredAt, admissions.at(-1).content)], gateEvents: [] };
}
function replacement() {
  return {
    kind: 'replacement-stream', quietMs: 300, clock: { resolutionMs: 1, schedulerLagMs: 60 },
    policy: { kind: 'finite-bound', boundMs: 250 },
    control: run(1000, 1, 1310), sustained: run(2000, 3, 2300),
  };
}
test('timing requires actual current-content requests and a sustained eligible cadence', () => {
  checkReplacementTiming(replacement());
  const noRequest = replacement(); noRequest.sustained.requests = []; noRequest.firstDeliveryMs = 5;
  assert.throws(() => checkReplacementTiming(noRequest), /delivery control/);
  const stale = replacement(); stale.sustained.requests[0].messages = ['CURRENT_0_END'];
  assert.throws(() => checkReplacementTiming(stale), /superseded/);
  const gap = replacement(); gap.sustained.admissions[1].acceptedAt = 2500;
  assert.throws(() => checkReplacementTiming(gap), /cadence/);
  const different = replacement(); different.sustained.admissions[1].wire.params.coalesce.key = 'other';
  assert.throws(() => checkReplacementTiming(different), /same subject/);
  const skipped = replacement(); skipped.sustained.admissions[1].decision.behavior = 'skip';
  assert.throws(() => checkReplacementTiming(skipped), /eligibility/);
});
test('negative and nonfinite delivery elapsed values are invalid observations', () => {
  const control = replacement();
  control.control.requests[0].observedAt = 999; control.control.requests[0].assemblyStartedAt = 999;
  assert.throws(() => checkReplacementTiming(control), /negative/);
  for (const observedAt of [-1, NaN, Infinity, -Infinity]) {
    const t = replacement(); t.sustained.requests[0].observedAt = observedAt;
    assert.throws(() => checkReplacementTiming(t), /timestamp|elapsed/);
  }
});
test('policy absence is a source-supported Host failure, not a finite-run inference', () => {
  const t = replacement();
  t.policy = { kind: 'missing-required-bound', sourceVerified: true, sourceHashes: { gate: 'a', framework: 'b', coalescer: 'c' } };
  assert.throws(() => checkReplacementTiming(t), error => error.code === 'ERR_ASSERTION' && /no finite/.test(error.message));
  t.policy.sourceVerified = false;
  assert.throws(() => checkReplacementTiming(t), error => error.code !== 'ERR_ASSERTION' && /provenance/.test(error.message));
});
test('paused delivery and a campaign shorter than the bound cannot establish timing conformance', () => {
  const paused = replacement(); paused.sustained.states[1].quiesced = true;
  assert.throws(() => checkReplacementTiming(paused), /paused/);
  const short = replacement(); short.policy.boundMs = 1000;
  assert.throws(() => checkReplacementTiming(short), /span/);
});
function paired() {
  const phase = start => ({
    quietMs: 200, ordinaryPolicy: 'ordinary', scheduler: { running: true, quiesced: false, gateQuiesced: false },
    ordinaryAdmission: { recipient: 'agent', receipt: { accepted: true }, decisionAt: start, content: 'ORDINARY', wire: { method: 'push/event', params: { eventId: 'ordinary-' + start, payload: { content: [{ type: 'text', text: 'ORDINARY' }] } } } },
    gateEvents: [{ kind: 'ordinary-debounce', policyName: 'ordinary', eventId: 'ordinary-' + start, observedAt: start + 205 }],
    ordinaryWakeIndex: 0, requests: [request(start + 210, 'ORDINARY')],
  });
  const baseline = phase(1000), combined = phase(2000);
  combined.requests.unshift(request(2110, 'CURRENT_2_END ORDINARY'));
  combined.requests[1] = request(2210, 'CURRENT_2_END ORDINARY');
  combined.gateEvents.push({ kind: 'coalesced-postponement-bound', observedAt: 2100, requestIndex: 0 });
  combined.boundWakeIndex = 1; combined.currentSubjectContent = 'CURRENT_2_END';
  combined.subjectQuietMs = 300;
  combined.subjectRun = run(1800, 3, 2110);
  combined.subjectRun.requests = combined.requests;
  return { kind: 'ordinary-debounce-pair', baseline, combined, clock: { resolutionMs: 1, schedulerLagMs: 20 } };
}
test('ordinary timing follows its own cause, not early content in a different request', () => {
  checkOrdinaryTiming(paired());
  for (const at of [2100, 2300]) {
    const t = paired(); t.combined.gateEvents[0].observedAt = at;
    assert.throws(() => checkOrdinaryTiming(t), /shortened or extended|still pending/);
  }
});
test('fabricated delivery timestamps cannot replace the paired causal/request witnesses', () => {
  const t = paired(); t.combined.requests = []; t.combined.subjectRun.requests = []; t.ordinaryDeliveryMs = 200;
  assert.throws(() => checkOrdinaryTiming(t), /delivery control|never reached/);
  const cause = paired(); cause.combined.gateEvents[1].kind = 'unrelated';
  assert.throws(() => checkOrdinaryTiming(cause), /bound firing/);
  const stale = paired(); stale.combined.requests[0].messages = ['OLD'];
  assert.throws(() => checkOrdinaryTiming(stale), /current-content|current subject/);
  for (const at of [-1, NaN, Infinity]) {
    const bad = paired(); bad.combined.gateEvents[0].observedAt = at;
    assert.throws(() => checkOrdinaryTiming(bad), /negative|identified/);
  }
});
test('hard-capacity and ordinary-admission preconditions need observations', () => {
  const out = { contexts: {}, requests: [], capacity: { hard: true, limit: 2, occupied: 2 }, reply: { accepted: true } };
  check({ path: 'capacity', capacitySaturated: true }, out, new Map(), {});
  check({ path: 'reply', ordinaryAdmission: true }, out, new Map(), {});
  out.capacity.occupied = 1;
  assert.throws(() => check({ path: 'capacity', capacitySaturated: true }, out, new Map(), {}), /saturation/);
  out.reply.accepted = false;
  assert.throws(() => check({ path: 'reply', ordinaryAdmission: true }, out, new Map(), {}), /precondition/);
});
test('conditional profile choice, missing mechanism, and absent fixture controls remain distinct', async () => {
  const adapter = { profile: { capabilities: [], preconditions: {
    soft: { status: 'inapplicable', reason: 'soft target only' },
    bound: { status: 'blocked', reason: 'missing required bound' },
  } }, open() { throw new Error('should not open'); } };
  const entry = { id: 'fixture', kind: 'host' };
  const v = requires => ({ name: 'test', requires, steps: [{ id: 's0', op: 'observe' }] });
  assert.equal((await runScenario(adapter, entry, v(['soft']))).status, 'inapplicable');
  assert.equal((await runScenario(adapter, entry, v(['bound', 'clock']))).status, 'blocked');
  assert.equal((await runScenario(adapter, entry, v(['clock']))).status, 'unexercised');
});

test('equal early wake offsets do not establish an ordinary quiet-period control', () => {
  const t = paired(); t.baseline.gateEvents[0].observedAt = 1050; t.combined.gateEvents[0].observedAt = 2050;
  assert.throws(() => checkOrdinaryTiming(t), /configured quiet period/);
  const noLongerPending = paired(); noLongerPending.combined.gateEvents[0].observedAt = 2090;
  assert.throws(() => checkOrdinaryTiming(noLongerPending), /still pending/);
});
test('ordinary timing needs nonempty linked input, unique wake identity, and an unpaused gate', () => {
  for (const mutate of [
    t => { t.combined.ordinaryAdmission.content = ''; },
    t => { t.combined.ordinaryAdmission.wire.params.payload.content = [{ type: 'text', text: 'OTHER' }]; },
    t => { delete t.combined.ordinaryAdmission.wire; },
    t => { t.combined.scheduler.gateQuiesced = true; },
    t => { delete t.combined.scheduler.gateQuiesced; },
    t => { t.combined.gateEvents[0].eventId = 'another-occurrence'; },
    t => { t.combined.gateEvents.push({ ...t.combined.gateEvents[0], observedAt: 2050 }); },
  ]) {
    const t = paired(); mutate(t); assert.throws(() => checkOrdinaryTiming(t), /nonempty|wire input|paused|uniquely linked/);
  }
});

function splitRecipients() {
  const t = paired();
  t.baseline.ordinaryAdmission.recipient = 'ordinary-recipient';
  t.baseline.requests[0].recipient = 'ordinary-recipient';
  t.combined.ordinaryAdmission.recipient = 'ordinary-recipient';
  t.combined.requests[0].messages = [{ content: [{ type: 'text', text: 'CURRENT_2_END' }] }];
  t.combined.requests[1].recipient = 'ordinary-recipient';
  t.combined.requests[1].messages = [{ content: [{ type: 'text', text: 'ORDINARY' }] }];
  t.combined.subjectRun.requests = [t.combined.requests[0]];
  return t;
}
test('ordinary-only requests to another recipient are outside subject-content validation', () => {
  checkOrdinaryTiming(splitRecipients());
  const missing = splitRecipients(); missing.combined.subjectRun.requests[0].messages = ['MISSING_CURRENT'];
  assert.throws(() => checkOrdinaryTiming(missing), /current subject/);
  const stale = splitRecipients(); stale.combined.subjectRun.requests[0].messages = ['CURRENT_0_END'];
  assert.throws(() => checkOrdinaryTiming(stale), /superseded/);
});
test('partitioning cannot filter out an inconvenient request to the real subject recipient', () => {
  const t = splitRecipients();
  t.combined.requests.push({ ...request(2115, 'MISSING_CURRENT') });
  assert.throws(() => checkOrdinaryTiming(t), /every combined request/);
  t.combined.subjectRun.requests.push(t.combined.requests.at(-1));
  assert.throws(() => checkOrdinaryTiming(t), /current subject/);
});
test('another recipient cannot stand in for either subject or ordinary delivery', () => {
  const ordinary = splitRecipients(); ordinary.combined.requests[1].recipient = 'unrelated';
  assert.throws(() => checkOrdinaryTiming(ordinary), /ordinary content never reached/);
  const bound = splitRecipients(); bound.combined.requests[0].recipient = 'ordinary-recipient';
  assert.throws(() => checkOrdinaryTiming(bound), /observed recipient/);
});
