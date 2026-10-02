import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

export function expand(value, origin, caseId = value?.id) {
  if (typeof value === 'string') {
    if (value.includes('$CASE')) assert.ok(typeof caseId === 'string' && caseId.length > 0, 'case namespace requires a case id');
    return value.replaceAll('$ORIGIN', origin).replaceAll('$CASE', encodeURIComponent(caseId ?? ''));
  }
  if (Array.isArray(value)) return value.map(x => expand(x, origin, caseId));
  if (value && typeof value === 'object') {
    if ('$repeat' in value) {
      assert.equal(typeof value.$repeat, 'string');
      assert.ok(Number.isSafeInteger(value.count) && value.count >= 0 && value.count <= 2 ** 21);
      return value.$repeat.repeat(value.count);
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, origin, caseId)]));
  }
  return value;
}

async function listen(server) {
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  return 'http://127.0.0.1:' + server.address().port;
}

// All network endpoints are loopback. The second server is a cross-origin trap.
export async function fixture(response = {}) {
  const requests = [], redirected = [];
  let chunksSent = 0, streamClosed = false;
  const timers = new Set();
  const target = createServer((req, res) => {
    redirected.push({ authorization: req.headers.authorization ?? null });
    res.end('redirect target');
  });
  const targetOrigin = await listen(target);
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization ?? null });
    if (response.redirect) {
      res.writeHead(302, { location: targetOrigin + '/target' });
      res.end();
    } else if (response.stream) {
      const { chunks, chunkBytes, intervalMs } = response.stream;
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const timer = setInterval(() => {
        chunksSent++;
        res.write(Buffer.alloc(chunkBytes, 120));
        if (chunksSent === chunks) { clearInterval(timer); timers.delete(timer); res.end(); }
      }, intervalMs);
      timers.add(timer);
      res.on('close', () => {
        streamClosed = true;
        clearInterval(timer);
        timers.delete(timer);
      });
    } else {
      const body = Buffer.from(response.bodyBase64 ?? '', 'base64');
      const headers = { 'content-type': response.contentType ?? 'application/octet-stream' };
      if (response.gzip) headers['content-encoding'] = 'gzip';
      res.writeHead(200, headers);
      res.end(response.gzip ? gzipSync(body) : body);
    }
  });
  let origin;
  try { origin = await listen(server); }
  catch (error) { target.close(); throw error; }
  return {
    origin, requests, redirected,
    get chunksSent() { return chunksSent; },
    get streamClosed() { return streamClosed; },
    async settle() { await new Promise(done => setTimeout(done, 30)); },
    async close() {
      for (const timer of timers) clearInterval(timer);
      await Promise.all([server, target].map(s => new Promise(done => {
        s.close(done); s.closeAllConnections();
      })));
    },
  };
}

// Inspect values as the model receives them, rather than JSON escape sequences.
export function semanticStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(semanticStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(semanticStrings);
  return [];
}

export function checkObservation(c, out, network, adapter) {
  const e = c.expect;
  if (c.operation === 'registry') {
    assert.equal(out.stableId, out.firstId, 'registration keeps a live reference stable');
    assert.equal(out.evicted, null, 'evicted reference must be a defined miss');
    assert.equal(out.unknown, null, 'unknown reference must be a defined miss');
    for (const error of [out.evictedError, out.unknownError]) {
      assert.equal(error.success, false);
      assert.equal(error.isError, true);
      assert.match(error.error, /unknown reference/i);
    }
    assert.notEqual(out.fresh.refId, out.firstId, 'evicted id must not be reused');
    assert.equal(new Set(out.ids).size, out.ids.length, 'each new record must have a distinct id');
    assert.equal(out.fresh.testimony.uri, c.blocks[0].uri);
    return;
  }
  assert.ok(out.before && typeof out.before.history === 'string' && typeof out.before.wake === 'string' && Array.isArray(out.before.push), 'adapter must observe both model-facing conversion paths');
  if (c.operation === 'fetch') assert.ok(out.after && typeof out.after.history === 'string' && typeof out.after.wake === 'string' && Array.isArray(out.after.push), 'fetch must observe post-fetch model views');
  const views = [['before', out.before], ...(out.after ? [['after', out.after]] : [])];
  for (const [stage, view] of views) {
    const visible = { ...e, ...e[stage], hidden: [...(e.hidden ?? []), ...(e[stage]?.hidden ?? [])] };
    for (const text of [semanticStrings(view.push).join(''), view.wake, view.history]) {
      assert.ok(text.length <= adapter.maxViewChars, 'view exceeds declared Host display bound');
      for (const forbidden of visible.hidden ?? []) assert.ok(!text.includes(forbidden), 'model-visible forbidden value: ' + forbidden);
      for (const included of visible.includes ?? []) assert.ok(text.includes(included), 'missing text: ' + included);
      if (visible.stub) {
        assert.ok(out.records.length > 0, 'reference record absent');
        for (const record of out.records) assert.ok(text.includes(record.refId), 'stub must identify its Host record');
      }
      if (visible.stubOrInlineBase64) {
        const inline = Buffer.from(visible.stubOrInlineBase64, 'base64').toString('utf8');
        assert.ok(out.records.some(record => text.includes(record.refId)) || text.includes(inline) || text.includes(visible.stubOrInlineBase64), 'verified ref may inline or retain its stub');
      }
      if (visible.displayField) {
        // This case uses a schema-valid ASCII label. Its shortening threshold
        // and recognized marks belong to the declared Host profile, not MCPL.
        const profile = adapter.displayProfile;
        assert.ok(profile && Number.isSafeInteger(profile.fieldChars[visible.displayField]) && profile.fieldChars[visible.displayField] > 0, 'missing Host field display limit');
        const original = c.blocks[0][visible.displayField];
        if (original.length > profile.fieldChars[visible.displayField]) {
          assert.ok(profile.truncationMarkers.some(mark => text.includes(mark)), 'display truncation must be marked according to the declared Host profile');
        }
      }
      if (visible.cleanLabel) assert.ok(!/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(text), 'unsafe display-label characters');
    }
  }
  if (e.kind) assert.equal(out.parsed[0].kind, e.kind);
  for (const field of e.missingFields ?? []) {
    const parsed = out.parsed.find(p => p.kind === 'reference');
    assert.ok(parsed, 'optional invalidity must keep the reference');
    assert.equal(parsed.testimony[field], undefined, field + ' must be absent, not truncated or coerced');
    assert.equal(parsed.testimony.disposition, 'never', 'subtractive disposition survives');
  }
  if (c.operation === 'render') {
    assert.equal(network.requests.length, 0, 'receipt/rendering alone must not dereference');
    return;
  }
  assert.equal(c.operation, 'fetch');
  assert.ok(out.outcome && Array.isArray(out.saves), 'fetch observation missing');
  if ('ok' in e) assert.equal(out.outcome.ok, e.ok, out.outcome.error ?? 'unexpected successful fetch');
  if ('requests' in e) assert.equal(network.requests.length, e.requests, 'request count');
  // §19.6.1 permits applying the connection credential; a Host may omit it.
  // This fixture is public, so credential use is an explicit tested profile.
  if (network.requests.length) {
    assert.ok(['connection-bearer', 'omit'].includes(adapter.credentialPolicy), 'declare the Host credential-use policy');
    const authorization = adapter.credentialPolicy === 'connection-bearer' ? 'Bearer fixture-secret' : null;
    for (const request of network.requests) assert.equal(request.authorization, authorization, 'same-origin credential-use profile');
  }
  if (e.redirectSafe) {
    assert.equal(network.requests.length, 1, 'initial redirect response must be exercised');
    assert.ok(network.redirected.length <= 1, 'redirect traversal must be bounded');
    for (const request of network.redirected) assert.equal(request.authorization, null, 'cross-origin credential leak');
    if (!network.redirected.length) assert.equal(out.outcome.ok, false, 'refused traversal cannot succeed');
  }
  if (!out.outcome.ok) {
    assert.equal(out.saves.length, 0, 'failed fetch must not present partial or mismatched bytes');
    assert.equal(out.records[0].fetchedPath, undefined);
    assert.equal(out.records[0].verifiedBytes, undefined);
  } else {
    assert.equal(out.saves.length, 1, 'successful fetch must materialize once');
    const saved = out.saves[0], record = out.records[0];
    const bytes = Buffer.from(saved.base64, 'base64');
    assert.equal(out.outcome.bytes, bytes.length);
    assert.equal(record.verifiedBytes, bytes.length);
    assert.equal(record.fetchedPath, out.outcome.path);
    if (e.decodedBase64) assert.equal(saved.base64, e.decodedBase64, 'saved bytes must be decoded identity octets');
    if (e.savedMime) {
      assert.equal(record.verifiedMimeType, e.savedMime);
      assert.equal(out.outcome.mimeType, e.savedMime);
      assert.equal(saved.mimeType, e.savedMime);
    }
    if (e.digestVerified) {
      assert.equal(record.digestVerified, true);
      assert.equal(out.outcome.digestVerified, true);
    }
    if (e.storageFromId) {
      assert.ok(saved.name.startsWith(record.refId + '.'), 'storage name must come from reference id');
      assert.ok(!saved.name.includes('/') && !saved.name.includes('\\'), 'storage name cannot contain a path');
      assert.ok(!saved.name.includes(c.blocks[0].name), 'server label must not be a storage component');
    }
  }
  if (e.abortStream) {
    assert.ok(network.streamClosed, 'stream must close on abort');
    assert.ok(network.chunksSent > 0 && network.chunksSent < c.response.stream.chunks, 'must abort a continuing stream, not buffer it to completion');
  }
  if (e.unchanged) assert.deepEqual(out.after, out.before, 'locally refused fetch must leave stub unchanged');
}

export async function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--framework', '--adapter', '--ajv', '--report'].includes(argv[i]) || !argv[i + 1]) {
      throw new Error('Usage: bun run conformance/check-bulk-references.mjs --framework PATH --ajv PATH [--adapter PATH] [--report PATH]');
    }
    options[argv[i].slice(2)] = argv[i + 1];
  }
  assert.ok(options.framework && options.ajv, '--framework and --ajv are required');
  const { default: Ajv } = await import(pathToFileURL(resolve(options.ajv)).href);
  const ajv = new Ajv({ strict: true, strictRequired: false, allErrors: true });
  const spec = await readFile(resolve(here, '../SPEC.md'), 'utf8');
  const schema = JSON.parse(spec.split('### B.1 ContentBlock')[1].split('```jsonc\n')[1].split('```')[0]);
  const validate = ajv.compile(schema);
  const legacy = await readJson(resolve(here, 'bulk-reference-legacy-schema.json'));
  const validateLegacy = ajv.compile(legacy.schema);
  const vectors = await readJson(resolve(here, 'bulk-reference-vectors.json'));
  assert.equal(vectors.format, 'mcpl-bulk-references-1');
  assert.equal(new Set(vectors.cases.map(c => c.id)).size, vectors.cases.length, 'duplicate case ids');
  assert.deepEqual([...new Set(vectors.cases.map(c => c.rfc))].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
  const module = await import(pathToFileURL(resolve(options.adapter ?? resolve(here, 'agent-framework-bulk-references.mjs'))).href);
  const adapter = await module.createAdapter(resolve(options.framework));
  assert.ok(Number.isSafeInteger(adapter.maxViewChars) && adapter.maxViewChars > 0);
  assert.ok(Array.isArray(adapter.displayProfile?.truncationMarkers) && adapter.displayProfile.truncationMarkers.length > 0 && adapter.displayProfile.truncationMarkers.every(mark => typeof mark === 'string' && mark.length > 0), 'adapter must declare nonempty truncation markers');
  assert.ok(['connection-bearer', 'omit'].includes(adapter.credentialPolicy), 'adapter must declare credentialPolicy');
  const ajvPackage = await readJson(resolve(dirname(options.ajv), '../package.json'));
  const suiteFiles = ['bulk-reference-vectors.json', 'bulk-reference-legacy-schema.json', 'check-bulk-references.mjs'];
  const suiteHashes = {};
  for (const file of suiteFiles) suiteHashes[file] = createHash('sha256').update(await readFile(resolve(here, file))).digest('hex');
  suiteHashes['SPEC.md'] = createHash('sha256').update(spec).digest('hex');
  suiteHashes['adapter'] = createHash('sha256').update(await readFile(resolve(options.adapter ?? resolve(here, 'agent-framework-bulk-references.mjs')))).digest('hex');
  const report = {
    suiteHashes,
    suiteWorktreeDirty: execFileSync('git', ['-C', here, 'status', '--porcelain'], { encoding: 'utf8' }).trim() !== '',
    vectorRevision: execFileSync('git', ['-C', here, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    runtime: process.version, bun: process.versions.bun ?? null,
    validator: { name: 'Ajv', version: ajvPackage.version, strict: true, strictRequired: false, schema: 'SPEC.md Appendix B.1' },
    legacySchemaRevision: legacy.sourceRevision, host: adapter.identity, displayProfile: adapter.displayProfile, credentialPolicy: adapter.credentialPolicy, results: [],
  };
  for (const raw of vectors.cases) {
    const network = await fixture(raw.response);
    const c = expand(raw, network.origin);
    try {
      const schemaResults = c.blocks.map(block => validate(block));
      const result = { id: c.id, rfc: c.rfc, schema: null, host: null };
      try {
        assert.deepEqual(schemaResults, c.schemaValid, 'strict emitter-schema acceptance');
        if (c.legacySchemaValid !== undefined) assert.equal(validateLegacy(c.blocks[0]), c.legacySchemaValid);
        if (c.knownEmbeddedCredential) {
          assert.equal(new URL(c.blocks[0].uri).searchParams.get('token'), c.knownEmbeddedCredential);
          assert.equal(c.emitterConformant, false);
          result.emitter = 'known embedded-credential fixture violates §19.6.1; JSON Schema alone accepts it';
        }
        result.schema = 'pass';
      } catch (error) { result.schema = 'fail'; result.schemaError = error.message; }
      try {
        const observation = await adapter.observe(c, { origin: network.origin, token: vectors.fixtures.token });
        await network.settle();
        checkObservation(c, observation, network, adapter);
        result.host = 'pass';
      } catch (error) { result.host = 'fail'; result.hostError = error.message; }
      report.results.push(result);
      console.log((result.schema === 'pass' && result.host === 'pass' ? 'PASS ' : 'FAIL ') + c.id + (result.schemaError ? '\n  schema: ' + result.schemaError : '') + (result.hostError ? '\n  host: ' + result.hostError : ''));
    } finally { await network.close(); }
  }
  report.schemaPassed = report.results.filter(r => r.schema === 'pass').length;
  report.hostPassed = report.results.filter(r => r.host === 'pass').length;
  console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
  if (options.report) await writeFile(options.report, JSON.stringify(report, null, 2) + '\n');
  return report.results.some(r => r.schema === 'fail' || r.host === 'fail') ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
