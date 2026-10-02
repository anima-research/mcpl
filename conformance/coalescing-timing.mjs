import assert from 'node:assert/strict';

// Invalid measurements are execution errors, not Host conformance verdicts.
function measured(condition, reason) {
  if (!condition) throw new Error('Timing evidence incomplete: ' + reason);
}
const finite = value => typeof value === 'number' && Number.isFinite(value);
const text = request => JSON.stringify(request.messages);

function validateRun(run, quietMs, clock, sustained) {
  measured(Array.isArray(run.admissions) && run.admissions.length > 0, 'no admitted occurrences');
  measured(Array.isArray(run.requests) && Array.isArray(run.gateEvents), 'missing raw request/gate observations');
  measured(run.states.length === run.admissions.length + 2, 'missing initial, admission, or final scheduler readouts');
  for (const state of run.states) measured(state.running === true && state.quiesced === false && state.gateQuiesced === false, 'delivery was stopped or paused');
  let subjectIdentity;
  for (const [i, admission] of run.admissions.entries()) {
    if (sustained) {
      const params = admission.wire?.params, member = params?.coalesce;
      measured(admission.wire?.method === 'push/event' && typeof member?.key === 'string' && member.key.length > 0 && member.deferred !== true && member.retract !== true, 'traffic was not plain coalesced updates');
      measured(typeof admission.binding === 'string' && admission.binding.length > 0, 'missing observed binding');
      const identity = JSON.stringify([admission.wire.server, admission.binding, member.channelId === undefined ? 'featureSet' : 'channel', member.channelId ?? params.featureSet, member.key]);
      subjectIdentity ??= identity;
      measured(identity === subjectIdentity, 'updates did not address the same subject');
      measured(['first', 'replaced', 'appended'].includes(admission.receipt?.coalesce?.outcome), 'coalescing admission was not witnessed');
    }
    measured(finite(admission.sentAt) && finite(admission.acceptedAt) && admission.acceptedAt >= admission.sentAt, 'invalid admission timestamps');
    measured(admission.receipt?.accepted === true, 'occurrence was not admitted');
    measured(admission.decision?.matchedPolicy === run.policyName && admission.decision?.behavior === 'debounce:' + quietMs, 'wake eligibility was not witnessed');
    measured(finite(admission.decision.timestamp), 'missing actual gate decision timestamp');
    if (i) {
      const prior = run.admissions[i - 1];
      const gap = admission.decision.timestamp - prior.decision.timestamp;
      measured(admission.sentAt >= prior.acceptedAt - clock.resolutionMs && gap >= 0 && (!sustained || gap < quietMs), 'replacement cadence did not remain faster than quiet');
    }
  }
  for (const request of run.requests) {
    measured(finite(request.observedAt) && finite(request.assemblyStartedAt), 'request lacks provider/assembly timestamps');
    measured(request.observedAt >= request.assemblyStartedAt && request.assemblyStartedAt >= run.admissions[0].sentAt - clock.resolutionMs, 'negative request elapsed time');
    const definitelyAdmitted = run.admissions.filter(a => a.acceptedAt < request.assemblyStartedAt - clock.resolutionMs);
    const latestRequired = definitelyAdmitted.at(-1) ?? run.admissions[0];
    const possiblyAdmitted = run.admissions.filter(a => a.sentAt <= request.observedAt + clock.resolutionMs);
    const latestVisible = [...possiblyAdmitted].reverse().find(a => text(request).includes(a.content));
    assert.ok(latestVisible, 'observed provider request contains no current subject content');
    assert.ok(run.admissions.indexOf(latestVisible) >= run.admissions.indexOf(latestRequired), 'provider request contains a superseded revision');
  }
  measured(finite(run.trafficEndedAt) && run.trafficEndedAt >= run.admissions.at(-1).acceptedAt, 'invalid end of sustained traffic');
  measured(run.requests.length > 0, 'positive after-quiet delivery control did not run');
  assert.ok(text(run.requests.at(-1)).includes(run.admissions.at(-1).content), 'latest revision missing after quiet');
}

export function checkReplacementTiming(timing) {
  measured(timing?.kind === 'replacement-stream', 'wrong measurement kind');
  const { quietMs, clock, control, sustained, policy } = timing;
  measured(finite(quietMs) && quietMs > 0 && finite(clock?.resolutionMs) && clock.resolutionMs >= 0 &&
    finite(clock.schedulerLagMs) && clock.schedulerLagMs >= 0, 'invalid clock/lag declaration');
  validateRun(control, quietMs, clock, false);
  measured(control.admissions.length === 1 && control.requests.length === 1, 'single-occurrence control was not isolated');
  validateRun(sustained, quietMs, clock, true);
  measured(sustained.admissions.length >= 2, 'no replacements');
  const first = sustained.admissions[0];
  const elapsed = sustained.requests[0].observedAt - first.decision.timestamp;
  measured(finite(elapsed) && elapsed >= 0, 'invalid delivery elapsed time');
  if (policy?.kind === 'missing-required-bound') {
    measured(policy.sourceVerified === true && Object.keys(policy.sourceHashes ?? {}).length >= 3, 'missing inspected-source provenance');
    assert.fail('Host has no finite replacement-postponement bound in the inspected reset-only path; the bounded live run is corroborating evidence, not proof of infinite starvation');
  }
  measured(policy?.kind === 'finite-bound' && finite(policy.boundMs) && policy.boundMs >= 0, 'Host postponement policy has not been established');
  measured(sustained.trafficEndedAt - first.decision.timestamp > policy.boundMs, 'campaign did not span the declared bound');
  assert.ok(sustained.requests[0].observedAt <= sustained.trafficEndedAt, 'no actual provider request while eligible replacements continued');
  assert.ok(elapsed <= policy.boundMs + clock.schedulerLagMs + clock.resolutionMs, 'actual provider delivery exceeded the declared bound and observation allowance');
}

// Ordinary wake timing is compared with its own control, not with an unrelated
// earlier request that happens to contain the ordinary event's already-stored text.
export function checkOrdinaryTiming(timing) {
  measured(timing?.kind === 'ordinary-debounce-pair', 'wrong paired measurement kind');
  const { baseline, combined, clock } = timing;
  measured(finite(clock?.resolutionMs) && clock.resolutionMs >= 0 && finite(clock.schedulerLagMs) && clock.schedulerLagMs >= 0, 'invalid clock/lag declaration');
  function ordinary(run) {
    const a = run.ordinaryAdmission;
    measured(a?.receipt?.accepted === true && finite(a.decisionAt) && finite(run.quietMs) && run.quietMs > 0, 'ordinary admission/policy not observed');
    measured(run.scheduler?.running === true && run.scheduler.quiesced === false, 'ordinary delivery was paused');
    const wake = run.gateEvents?.[run.ordinaryWakeIndex];
    measured(wake?.policyName === run.ordinaryPolicy && wake.kind === 'ordinary-debounce' && finite(wake.observedAt), 'ordinary wake cause not identified');
    measured(wake.observedAt >= a.decisionAt, 'negative ordinary elapsed time');
    const visible = run.requests?.filter(request => text(request).includes(a.content)) ?? [];
    measured(visible.length > 0, 'ordinary content never reached a provider request');
    for (const request of visible) measured(finite(request.observedAt) && request.observedAt >= a.decisionAt - clock.resolutionMs, 'invalid ordinary-request elapsed time');
    return { offset: wake.observedAt - a.decisionAt, due: a.decisionAt + run.quietMs };
  }
  measured(combined.subjectRun && finite(combined.subjectQuietMs), 'combined run lacks subject eligibility/cadence witnesses');
  validateRun(combined.subjectRun, combined.subjectQuietMs, clock, true);
  measured(JSON.stringify(combined.subjectRun.requests) === JSON.stringify(combined.requests), 'subject and ordinary observations do not identify the same provider requests');
  const control = ordinary(baseline), treatment = ordinary(combined);
  assert.equal(combined.quietMs, baseline.quietMs, 'ordinary policy changed between paired runs');
  const boundWake = combined.gateEvents?.[combined.boundWakeIndex];
  measured(boundWake?.kind === 'coalesced-postponement-bound' && finite(boundWake.observedAt), 'coalesced bound firing not witnessed');
  measured(boundWake.observedAt >= combined.ordinaryAdmission.decisionAt && boundWake.observedAt < treatment.due, 'bound did not fire during the unrelated ordinary quiet period');
  const request = combined.requests?.[boundWake.requestIndex];
  measured(request && finite(request.observedAt) && text(request).includes(combined.currentSubjectContent), 'bound wake lacks its actual current-content provider request');
  measured(request.observedAt >= boundWake.observedAt - clock.resolutionMs && request.observedAt <= boundWake.observedAt + clock.schedulerLagMs + clock.resolutionMs, 'bound request is not temporally linked to its wake');
  assert.ok(Math.abs(treatment.offset - control.offset) <= clock.schedulerLagMs + 2 * clock.resolutionMs,
    'coalescing shortened or extended the ordinary wake deadline relative to its control');
}

// Both sessions are the same real Host/profile. One gets a single occurrence;
// the other receives continuing replacements. Host event loops stay running.
export async function measureReplacementTiming(session, openControl, step, policy) {
  const quietMs = step.quietMs;
  const clock = { resolutionMs: 1, schedulerLagMs: 60 };
  async function collect(target, count, coalesced = true) {
    const initial = await target.step({ op: 'observe' });
    measured(initial.requests.length === 0, 'Host had provider activity before the timing inputs');
    const states = [initial.scheduler], admissions = [];
    let previous = initial;
    for (let i = 0; i < count; i++) {
      if (i) await new Promise(done => setTimeout(done, step.intervalMs));
      const content = 'TIMING_CURRENT_' + i + '_END';
      const sentAt = Date.now();
      const params = {
        featureSet: 'doc', eventId: 'timing-' + i, timestamp: '2026-01-01T00:00:00Z',
        tags: ['doc:wake'], ...(coalesced ? { coalesce: { key: 'timing-subject', initial: i === 0 } } : {}),
        payload: { content: [{ type: 'text', text: content }] },
      };
      const observed = await target.step({ op: 'send', method: 'push/event', params });
      const acceptedAt = Date.now();
      const decision = observed.trace.slice(previous.trace.length).find(event => event.type === 'gate:decision' && event.eventType === 'mcpl:push-event');
      admissions.push({ eventId: 'timing-' + i, coalesced, wire: { server: 'editor', method: 'push/event', params }, binding: observed.servers.editor.binding, content, sentAt, acceptedAt, receipt: observed.reply.result, decision });
      states.push(observed.scheduler);
      previous = observed;
    }
    const trafficEndedAt = Date.now();
    await new Promise(done => setTimeout(done, quietMs + clock.schedulerLagMs + 20));
    const final = await target.step({ op: 'observe' });
    states.push(final.scheduler);
    return { policyName: 'timing-subject', admissions, trafficEndedAt, states, requests: final.requests, gateEvents: final.trace.filter(event => event.type.startsWith('gate:')) };
  }
  const controlSession = await openControl();
  let control;
  try { control = await collect(controlSession, 1, false); }
  finally { await controlSession.close(); }
  const sustained = await collect(session, step.count);
  const decisions = sustained.admissions.map(admission => admission.decision.timestamp);
  const derived = { occurrences: decisions.length, eligibilitySpanMs: decisions.at(-1) - decisions[0], maxEligibilityGapMs: Math.max(...decisions.slice(1).map((time, i) => time - decisions[i])),
    requestsDuringTraffic: sustained.requests.filter(request => request.assemblyStartedAt <= sustained.trafficEndedAt).length,
    controlRequests: control.requests.length, controlRequestElapsedMs: control.requests[0]?.observedAt - control.admissions[0].decision.timestamp, finalRequests: sustained.requests.length,
    firstRequestElapsedMs: sustained.requests[0]?.observedAt - decisions[0] };
  return { kind: 'replacement-stream', quietMs, clock, policy, control, sustained, derived };
}
