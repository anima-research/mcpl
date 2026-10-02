import assert from 'node:assert/strict';
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
  const keys = expectation.event ? ['event', 'metadata'] : expectation.model ? ['model', 'order'] :
    ['path', 'eq', 'oneOf', 'gte', 'between', 'exactlyOneOf', 'includes', 'excludes', 'counts', 'order', 'recoveryContent', 'everyIncludes', 'sameAs', 'lteProfile'];
  for (const key of Object.keys(expectation)) if (!keys.includes(key)) throw new Error('Unknown expectation operator: ' + key);
  if (Object.keys(expectation).length < 2) throw new Error('Expectation must assert a property');
}

export function check(check, observation, history, profile) {
  validateCheck(check);
  const out = view(observation);
  if (check.event) {
    const messages = Object.values(out.contexts).flat().filter(message => message.metadata?.eventId === check.event);
    assert.ok(messages.length, 'no stored occurrence for event ' + check.event);
    for (const message of messages) for (const [field, value] of Object.entries(check.metadata)) assert.deepEqual(message.metadata?.[field], value);
    return;
  }
  if (check.model) {
    const requests = out.requests.filter(request => request.model === check.model);
    assert.ok(requests.length, 'no observed provider request for ' + check.model);
    return checkValue(json(requests.at(-1).messages), { order: check.order });
  }
  const actual = at(out, check.path);
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
    if (expected.recoveryContent) {
      const [first, second] = expected.recoveryContent;
      assert.equal(text.split(second).length - 1, 1, 'new occurrence appears exactly once');
      const occurrences = text.split(first).length - 1;
      assert.ok(occurrences === 0 || occurrences === 1, 'recovery must not duplicate old occurrence');
      if (occurrences) assert.ok(text.indexOf(first) < text.indexOf(second), 'recovery preserves order');
    }
  }
  if ('everyIncludes' in expected) {
    assert.ok(Array.isArray(actual) && actual.length > 0);
    for (const value of actual) assert.ok(json(value).includes(expected.everyIncludes), 'recipient omitted materialized content');
  }
}

export async function runScenario(adapter, entry, variant) {
  const missing = variant.requires.filter(capability => !adapter.profile.capabilities.includes(capability));
  if (missing.length) return { case: entry.id, variant: variant.name, kind: entry.kind, status: 'unexercised', missing, contract: entry.contract };
  const history = new Map(), failures = [], observations = [];
  let session, executionError;
  try {
    session = await adapter.open(variant.setup);
    for (const step of variant.steps) {
      let observed;
      try { observed = await session.step(step); }
      catch (error) { executionError = { step: step.id, operation: step.op, error: String(error?.stack ?? error) }; break; }
      history.set(step.id, observed);
      if (step.checks?.length) observations.push({ step: step.id, observed });
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
  assert.equal(ids.length, 64);
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
  for (const file of ['event-coalescing-vectors.json', 'check-event-coalescing.mjs', 'coalescing-host-worker.mjs']) hashes[file] = createHash('sha256').update(await readFile(resolve(here, file))).digest('hex');
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
  report.summary = Object.fromEntries(['pass', 'supporting-pass', 'fail', 'unexercised', 'observed', 'execution-error'].map(status => [status, report.results.filter(result => result.status === status).length]));
  report.byKind = Object.fromEntries(['host', 'server-fixture', 'advisory'].map(kind => [kind, Object.fromEntries(Object.keys(report.summary).map(status => [status, report.results.filter(result => result.kind === kind && result.status === status).length]))]));
  console.log(json(report.summary));
  console.log(json(report.byKind));
  if (options.report) await writeFile(options.report, JSON.stringify(report, null, 2) + '\n');
  // Unexercised cases are incomplete evidence, never an all-green conformance result.
  return report.results.some(result => ['fail', 'unexercised', 'execution-error'].includes(result.status)) ? 1 : 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
