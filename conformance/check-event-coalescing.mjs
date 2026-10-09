import assert from 'node:assert/strict';
import { checkReplacementTiming, checkOrdinaryTiming } from './coalescing-timing.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const json = value => JSON.stringify(value);
export function at(value, path) {
  for (const part of path.split('.')) value = value?.[part];
  return value;
}
export function view(observation) {
  return {
    ...observation,
    requestText: json(observation.requests.at(-1)?.messages ?? []),
    allRequestText: json(observation.requests.map(request => request.messages)),
    allContextText: json(observation.contexts),
  };
}
export function validateCheck(expectation) {
  const keys = expectation.audienceFrom ? ['audienceFrom', 'original', 'replacement'] : expectation.event ? ['event', 'metadata'] : expectation.model ? ['model', 'requestCount', 'order', 'includes', 'excludes', 'counts'] :
    ['path', 'eq', 'oneOf', 'gte', 'between', 'exactlyOneOf', 'includes', 'excludes', 'counts', 'order', 'recoveryContent', 'recoveryFrom', 'everyIncludes', 'sameAs', 'lteProfile', 'timing', 'capacitySaturated', 'ordinaryAdmission'];
  for (const key of Object.keys(expectation)) if (!keys.includes(key)) throw new Error('Unknown expectation operator: ' + key);
  if (expectation.recoveryContent && !expectation.recoveryFrom) throw new Error('Recovery content must be linked to its receipt');
  if (Object.keys(expectation).length < 2) throw new Error('Expectation must assert a property');
}

export function check(check, observation, history, profile) {
  validateCheck(check);
  const out = view(observation);
  if (check.audienceFrom) {
    assert.ok(history.has(check.audienceFrom), 'missing original audience observation');
    const originalContexts = history.get(check.audienceFrom).contexts;
    const recipients = new Set(Object.keys(originalContexts).filter(name => json(originalContexts[name]).includes(check.original)));
    assert.ok(recipients.size > 0, 'original delivery must establish at least one recipient');
    for (const name of new Set([...Object.keys(originalContexts), ...Object.keys(out.contexts)])) {
      const content = json(out.contexts[name] ?? []);
      assert.ok(!content.includes(check.original), 'unread original survives in ' + name);
      if (recipients.has(name)) assert.ok(content.includes(check.replacement), 'replacement missing from original recipient ' + name);
      else assert.ok(!content.includes(check.replacement), 'replacement widened audience to ' + name);
    }
    return;
  }
  if (check.event) {
    const messages = Object.values(out.contexts).flat().filter(message => message.metadata?.eventId === check.event);
    assert.ok(messages.length, 'no stored occurrence for event ' + check.event);
    for (const message of messages) for (const [field, value] of Object.entries(check.metadata)) assert.deepEqual(message.metadata?.[field], value);
    return;
  }
  if (check.model) {
    const requests = out.requests.filter(request => request.model === check.model);
    if ('requestCount' in check) assert.equal(requests.length, check.requestCount, 'provider request count for ' + check.model);
    const { model, requestCount, ...constraints } = check;
    if (Object.keys(constraints).length) {
      assert.ok(requests.length, 'no observed provider request for ' + model);
      checkValue(json(requests.at(-1).messages), constraints);
    }
    return;
  }
  const actual = at(out, check.path);
  if (check.timing) {
    if (check.timing === 'replacement') return checkReplacementTiming(actual);
    if (check.timing === 'ordinary-preserved') return checkOrdinaryTiming(actual);
    throw new Error('Unknown timing contract');
  }
  if (check.capacitySaturated) {
    if (actual?.hard !== true || !Number.isSafeInteger(actual.limit) || actual.limit < 0 || !Number.isSafeInteger(actual.occupied) || actual.occupied < actual.limit) throw new Error('Hard capacity saturation was not observed');
    return;
  }
  if (check.ordinaryAdmission) {
    if (actual?.accepted !== true) throw new Error('Ordinary admission control did not establish the capacity-test precondition');
    return;
  }
  if ('sameAs' in check) {
    const [step, ...path] = check.sameAs.split('.');
    assert.ok(history.has(step), 'missing comparison step: ' + step);
    assert.deepEqual(actual, at(view(history.get(step)), path.join('.')));
    return;
  }
  if ('lteProfile' in check) {
    assert.ok(Number.isFinite(profile[check.lteProfile]), 'profile must supply the required bound');
    assert.ok(actual <= profile[check.lteProfile]);
    return;
  }
  if (check.recoveryContent) {
    const [step, ...path] = check.recoveryFrom.split('.');
    assert.ok(history.has(step), 'missing recovery receipt');
    const outcome = at(history.get(step), path.join('.'));
    assert.ok(['replaced', 'appended'].includes(outcome), 'invalid recovery receipt outcome');
    const [first, second] = check.recoveryContent;
    checkValue(actual, { counts: { [first]: outcome === 'appended' ? 1 : 0, [second]: 1 }, ...(outcome === 'appended' ? { order: [first, second] } : {}) });
    return;
  }
  checkValue(actual, check);
}
function checkValue(actual, expected) {
  if ('eq' in expected) assert.deepEqual(actual, expected.eq);
  if ('oneOf' in expected) assert.ok(expected.oneOf.some(value => json(value) === json(actual)), 'no permitted outcome matched: ' + json(actual));
  if ('between' in expected) assert.ok(Number.isFinite(actual) && actual >= expected.between[0] && actual <= expected.between[1], 'outside permitted interval');
  if ('gte' in expected) assert.ok(actual >= expected.gte, 'below minimum: ' + actual);
  if ('includes' in expected || 'excludes' in expected || 'counts' in expected || 'order' in expected || 'recoveryContent' in expected || 'exactlyOneOf' in expected) {
    assert.notEqual(actual, undefined, 'missing observed value');
    const text = typeof actual === 'string' ? actual : json(actual);
    for (const value of expected.includes ?? []) assert.ok(text.includes(value), 'missing ' + value);
    for (const value of expected.excludes ?? []) assert.ok(!text.includes(value), 'unexpected ' + value);
    for (const [value, count] of Object.entries(expected.counts ?? {})) assert.equal(text.split(value).length - 1, count, 'occurrence count: ' + value);
    let position = -1;
    for (const value of expected.order ?? []) {
      const next = text.indexOf(value, position + 1);
      assert.ok(next > position, 'missing or out-of-order ' + value);
      position = next;
    }
    if (expected.exactlyOneOf) {
      assert.equal(expected.exactlyOneOf.reduce((total, value) => total + text.split(value).length - 1, 0), 1, 'exactly one permitted materialization');
    }

  }
  if ('everyIncludes' in expected) {
    assert.ok(Array.isArray(actual) && actual.length > 0);
    for (const value of actual) assert.ok(json(value).includes(expected.everyIncludes), 'recipient omitted materialized content');
  }
}

export async function runScenario(adapter, entry, variant) {
  const missing = variant.requires.filter(capability => !adapter.profile.capabilities.includes(capability));
  if (missing.length) {
    const reasons = missing.map(capability => ({ capability, ...(adapter.profile.preconditions?.[capability] ?? { status: 'unexercised', reason: 'This adapter does not construct the stated precondition.' }) }));
    const status = reasons.some(reason => reason.status === 'blocked') ? 'blocked' : reasons.every(reason => reason.status === 'inapplicable') ? 'inapplicable' : 'unexercised';
    return { case: entry.id, variant: variant.name, kind: entry.kind, status, missing, reasons, contract: entry.contract };
  }
  const history = new Map(), failures = [], observations = [];
  let session, executionError, priorRequests = 0;
  try {
    session = await adapter.open(variant.setup);
    for (const step of variant.steps) {
      let observed;
      try { observed = await session.step(step); }
      catch (error) { executionError = { step: step.id, operation: step.op, error: String(error?.stack ?? error) }; break; }
      observed = structuredClone(observed);
      history.set(step.id, observed);
      if (entry.kind === 'advisory' || step.op === 'observe' || step.checks?.length || ['assemble', 'turn', 'joinTurn'].includes(step.op)) observations.push({ step: step.id, observed });
      let witnessedFailure = false;
      if (step.expectedModelFailureSince) {
        const before = history.get(step.expectedModelFailureSince);
        witnessedFailure = !!before && Number.isSafeInteger(observed.modelFailures) && observed.modelFailures > before.modelFailures;
        if (!witnessedFailure) executionError = { step: step.id, operation: step.op, error: 'Expected model failure was not observed after its setup' };
      }
      if (['assemble', 'turn', 'joinTurn'].includes(step.op)) {
        if (!Object.hasOwn(observed, 'runError')) executionError ??= { step: step.id, operation: step.op, error: 'Missing Host-drive completion observation' };
        else if (observed.runError && !witnessedFailure) executionError ??= { step: step.id, operation: step.op, error: String(observed.runError) };
      }
      if (step.op === 'assemble' && observed.requests.length <= priorRequests) executionError ??= { step: step.id, operation: step.op, error: 'Requested assembly produced no new provider request' };
      priorRequests = observed.requests.length;
      if (executionError) break;
      for (const expectation of step.checks ?? []) {
        try { check(expectation, observed, history, adapter.profile); }
        catch (error) {
          if (error.code === 'ERR_ASSERTION') failures.push({ step: step.id, expectation, error: error.message });
          else { executionError = { step: step.id, operation: 'check', error: String(error?.stack ?? error) }; break; }
        }
      }
      if (executionError) break;
    }
  } catch (error) { executionError = { error: String(error?.stack ?? error) }; }
  finally {
    try { await session?.close(); }
    catch (error) { executionError ??= { operation: 'cleanup', error: String(error?.stack ?? error) }; }
  }
  return {
    case: entry.id, variant: variant.name, kind: entry.kind,
    status: executionError ? 'execution-error' : failures.length ? 'fail' : entry.kind === 'advisory' ? 'observed' : variant.evidenceBoundary ? 'supporting-pass' : 'pass',
    ...(variant.evidenceBoundary ? { evidenceBoundary: variant.evidenceBoundary } : {}),
    failures, ...(executionError ? { executionError } : {}), observations,
  };
}

export async function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--framework', '--adapter', '--report', '--case'].includes(argv[i]) || !argv[i + 1]) throw new Error('Usage: bun run conformance/check-event-coalescing.mjs --framework PATH [--adapter PATH] [--report PATH] [--case 1,2,43]');
    options[argv[i].slice(2)] = argv[i + 1];
  }
  assert.ok(options.framework, '--framework is required');
  const bytes = await readFile(resolve(here, 'event-coalescing-vectors.json'));
  const vectors = JSON.parse(bytes);
  assert.equal(vectors.format, 'mcpl-event-coalescing-1');
  const source = await readFile(resolve(here, '../RFC-006-event-coalescing.md'), 'utf8');
  const section = source.split('## 14. Conformance vectors\n')[1].split('## 15.')[0];
  const matches = [...section.matchAll(/^(\d+[a-z]?)\. \*\*/gm)];
  const ids = matches.map(match => match[1]);
  for (const [index, match] of matches.entries()) {
    const contract = section.slice(match.index, matches[index + 1]?.index ?? section.length).split('\n\n')[0];
    const normalize = text => text.replace(/\s+/g, ' ').trim();
    assert.equal(normalize(vectors.cases[index].contract), normalize(contract), 'source contract drift for row ' + match[1]);
  }
  assert.deepEqual(vectors.cases.map(entry => entry.id), ids, 'every labeled RFC vector must occur once, in order');
  assert.equal(ids.length, 65);
  for (const entry of vectors.cases) for (const variant of entry.variants) {
    assert.equal(new Set(variant.steps.map(step => step.id)).size, variant.steps.length, 'duplicate step ids');
    assert.ok(variant.steps.length > 0);
    for (const step of variant.steps) for (const expectation of step.checks ?? []) validateCheck(expectation);
  }
  const selected = options.case?.split(',');
  if (selected) for (const id of selected) assert.ok(ids.includes(id), 'unknown selected case: ' + id);
  const adapterPath = resolve(options.adapter ?? resolve(here, 'agent-framework-coalescing.mjs'));
  const { createAdapter } = await import(pathToFileURL(adapterPath).href);
  const adapter = await createAdapter(resolve(options.framework));
  const hashes = {};
  for (const file of ['event-coalescing-vectors.json', 'check-event-coalescing.mjs', 'coalescing-host-worker.mjs', 'coalescing-timing.mjs']) hashes[file] = createHash('sha256').update(await readFile(resolve(here, file))).digest('hex');
  hashes['RFC-006-event-coalescing.md'] = createHash('sha256').update(source).digest('hex');
  hashes.adapter = createHash('sha256').update(await readFile(adapterPath)).digest('hex');
  const report = {
    revision: execFileSync('git', ['-C', here, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['-C', here, 'status', '--porcelain'], { encoding: 'utf8' }).trim() !== '',
    hashes, host: adapter.identity, profile: adapter.profile, selected: selected ?? ids, results: [],
  };
  for (const entry of vectors.cases) {
    if (selected && !selected.includes(entry.id)) continue;
    for (const variant of entry.variants) {
      const result = await runScenario(adapter, entry, variant);
      report.results.push(result);
      console.log(result.status.toUpperCase() + ' ' + entry.id + '/' + variant.name + ' [' + entry.kind + ']');
      for (const failure of result.failures ?? []) console.log('  ' + failure.step + ': ' + failure.error.slice(0, 600));
      if (result.executionError) console.log('  ' + result.executionError.error.slice(0, 1200));
    }
  }
  report.summary = Object.fromEntries(['pass', 'supporting-pass', 'fail', 'inapplicable', 'blocked', 'unexercised', 'observed', 'execution-error'].map(status => [status, report.results.filter(result => result.status === status).length]));
  report.byKind = Object.fromEntries(['host', 'server-fixture', 'advisory'].map(kind => [kind, Object.fromEntries(Object.keys(report.summary).map(status => [status, report.results.filter(result => result.kind === kind && result.status === status).length]))]));
  console.log(json(report.summary));
  console.log(json(report.byKind));
  if (options.report) await writeFile(options.report, JSON.stringify(report, null, 2) + '\n');
  // Unexercised cases are incomplete evidence, never an all-green conformance result.
  return report.results.some(result => ['fail', 'blocked', 'unexercised', 'execution-error'].includes(result.status)) ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
