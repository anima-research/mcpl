import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const corpusPath = resolve(here, 'bulk-reference-vectors.json');
const localPayloadPath = resolve(here, 'bulk-reference-11-file-refused.wav');
const localPayloadURL = pathToFileURL(localPayloadPath).href;
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const pause = ms => new Promise(done => setTimeout(done, ms));

// $ORIGIN is the case's loopback origin, $CASE its URL-encoded id, and $LOCAL_PAYLOAD
// the file URL of the small payload beside this corpus that the refused file: case
// names. The payload's name carries that case's id, so its URI needs no query.
export function expand(value, origin, caseId = value?.id) {
  if (typeof value === 'string') {
    if (value.includes('$CASE')) assert.ok(typeof caseId === 'string' && caseId.length > 0, 'case namespace requires a case id');
    return value.replaceAll('$ORIGIN', () => origin)
      .replaceAll('$CASE', () => encodeURIComponent(caseId ?? ''))
      .replaceAll('$LOCAL_PAYLOAD', () => localPayloadURL);
  }
  if (Array.isArray(value)) return value.map(x => expand(x, origin, caseId));
  if (value && typeof value === 'object') {
    if ('$repeat' in value) {
      assert.deepEqual(Object.keys(value).sort(), ['$repeat', 'count'], '$repeat takes only count beside it');
      assert.equal(typeof value.$repeat, 'string', '$repeat unit must be a string');
      assert.ok(Number.isSafeInteger(value.count) && value.count >= 0 && value.count <= 2 ** 21, '$repeat count must be an integer from 0 to 2^21');
      return expand(value.$repeat, origin, caseId).repeat(value.count);
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
  let chunksSent = 0, streamClosed = false, current = response ?? {};
  const timers = new Set();
  const target = createServer((req, res) => {
    redirected.push({ authorization: req.headers.authorization ?? null });
    res.end('redirect target');
  });
  const targetOrigin = await listen(target);
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization ?? null });
    if (current.redirect) {
      res.writeHead(302, { location: targetOrigin + '/target' });
      res.end();
    } else if (current.stream) {
      const { chunks, chunkBytes, intervalMs } = current.stream;
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const timer = setInterval(() => {
        chunksSent++;
        res.write(Buffer.alloc(chunkBytes, 120));
        if (chunksSent === chunks) { clearInterval(timer); timers.delete(timer); res.end(); }
      }, intervalMs);
      timers.add(timer);
      // Observe the transport: Bun 1.3.x can omit ServerResponse.close on client abort.
      req.socket.once('close', () => {
        streamClosed = true;
        clearInterval(timer);
        timers.delete(timer);
      });
    } else {
      const body = Buffer.from(current.bodyBase64 ?? '', 'base64');
      const headers = { 'content-type': current.contentType ?? 'application/octet-stream' };
      if (current.gzip) headers['content-encoding'] = 'gzip';
      res.writeHead(200, headers);
      res.end(current.gzip ? gzipSync(body) : body);
    }
  });
  let origin;
  try { origin = await listen(server); }
  catch (error) { target.close(); throw error; }
  return {
    origin, requests, redirected,
    get chunksSent() { return chunksSent; },
    get streamClosed() { return streamClosed; },
    // Serve another case's own response from the same origin.
    respond(next) { current = next ?? {}; },
    // Wait for the stream's close event when an abort is expected, then for a quiet
    // window with no new request; a deadline bounds both.
    async settle({ closed = false, quietMs = 100, deadlineMs = 5000 } = {}) {
      const deadline = Date.now() + deadlineMs;
      while (closed && !streamClosed && Date.now() < deadline) await pause(5);
      let seen = requests.length + redirected.length, quietSince = Date.now();
      while (Date.now() - quietSince < quietMs && Date.now() < deadline) {
        await pause(10);
        const now = requests.length + redirected.length;
        if (now !== seen) { seen = now; quietSince = Date.now(); }
      }
    },
    async close() {
      for (const timer of timers) clearInterval(timer);
      await Promise.all([server, target].map(s => new Promise(done => {
        s.close(done); s.closeAllConnections();
      })));
    },
  };
}

// Inspect values as the model receives them, rather than JSON escape sequences.
// Object keys count, since a Host can put a value in a key.
export function semanticStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(semanticStrings);
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, v]) => [key, ...semanticStrings(v)]);
  return [];
}

// The corpus's shape, frozen: the cases per RFC row, and the expectation keys the checker reads.
const CASES_PER_ROW = { 1: 4, 2: 3, 3: 1, 4: 2, 5: 1, 6: 1, 7: 2, 8: 2, 9: 3, 10: 1, 11: 2, 12: 1, 13: 1, 14: 1, 15: 3, 16: 1, 17: 11, 18: 2, 19: 2, 20: 1 };
const STAGE_KEYS = ['stub', 'hidden', 'includes', 'stubOrInlineBase64', 'displayField', 'cleanLabel'];
const EXPECT_KEYS = [...STAGE_KEYS, 'kind', 'missingFields', 'ok', 'requests', 'redirectSafe', 'decodedBase64',
  'savedMime', 'digestVerified', 'storageFromId', 'abortStream', 'unchanged', 'before', 'after'];
// A rejected string value of at least this many UTF-16 code units is looked for
// by its first ones, as RFC-005 says: a run this long doesn't occur in a lane by
// chance, where a number or a shorter string could.
const REJECTED_RUN = 16;
// Control and bidi characters a display label must not carry (row 18). These are
// characters: an escaped form is plain text. The checker can't tell a Host's own
// such characters from the label's, so in a case that checks labels any of them
// in a view fails it.
const UNSAFE_LABEL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
// A tab or line break also lays out a Host's own text, so it doesn't count alone.
// A label's own one is looked for as the label's three ASCII letters or digits on
// each side of it, joined by any run of tabs or line breaks, so a Host that keeps
// the break in another form is found too. A case that checks labels must give
// each such break those characters: they're the same whatever a Host does with
// the label's other characters, and a Host's own break is unlikely to fall
// exactly between them. Breaks at a label's ends can't be told from a Host's.
const LABEL_CONTEXT = 3;
export function labelBreaks(blocks, id) {
  const patterns = [];
  for (const block of blocks) {
    if (typeof block.name !== 'string') continue;
    for (const match of block.name.matchAll(/[\t\n\r\u2028\u2029]/g)) {
      const at = match.index;
      const before = at >= LABEL_CONTEXT ? block.name.slice(at - LABEL_CONTEXT, at) : '';
      const after = block.name.slice(at + 1, at + 1 + LABEL_CONTEXT);
      assert.ok(/^[A-Za-z0-9]{3}$/.test(before) && /^[A-Za-z0-9]{3}$/.test(after),
        id + ": a label's tab or line break has " + LABEL_CONTEXT + ' ASCII letters or digits on each side');
      patterns.push(new RegExp(before + '[\\t\\n\\r\\u2028\\u2029]+' + after));
    }
  }
  return patterns;
}

// The bytes a Host that dereferenced a local URI would read: a file: URI's file,
// or a data: URI's own payload, with the scheme as the URL parser reads it. Null
// for any other URI; empty for a local one that can't be read.
function localPayload(uri) {
  let url;
  try { url = new URL(uri); } catch { return /^[\u0000-\u0020]*(file|data):/i.test(uri) ? Buffer.alloc(0) : null; }
  if (url.protocol !== 'file:' && url.protocol !== 'data:') return null;
  try {
    if (url.protocol === 'file:') return readFileSync(fileURLToPath(url));
    // As fetch() decodes it: the percent-escapes bytewise, then, if the type says
    // so, forgiving-base64, which gives nothing for a body it can't decode.
    const text = url.href.split('#')[0].slice('data:'.length), comma = text.indexOf(',');
    if (comma < 0) return Buffer.alloc(0);
    const bytes = Buffer.from(text.slice(comma + 1).replace(/%([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
    if (!/;\s*base64\s*$/i.test(text.slice(0, comma))) return bytes;
    let base64 = bytes.toString('latin1').replace(/[\t\n\f\r ]/g, '');
    if (base64.length % 4 === 0) base64 = base64.replace(/={1,2}$/, '');
    return base64.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(base64) ? Buffer.alloc(0) : Buffer.from(base64, 'base64');
  } catch { return Buffer.alloc(0); }
}

export function assertCorpus(vectors) {
  assert.equal(vectors.format, 'mcpl-bulk-references-1');
  assert.equal(new Set(vectors.cases.map(c => c.id)).size, vectors.cases.length, 'duplicate case ids');
  const rows = {};
  for (const c of vectors.cases) rows[c.rfc] = (rows[c.rfc] ?? 0) + 1;
  assert.deepEqual(rows, CASES_PER_ROW, 'the frozen cases per RFC row');
  const uris = new Map();
  for (const c of vectors.cases) {
    for (const key of Object.keys(c.expect)) assert.ok(EXPECT_KEYS.includes(key), c.id + ': unknown expectation ' + key);
    for (const stage of ['before', 'after']) {
      for (const key of Object.keys(c.expect[stage] ?? {})) assert.ok(STAGE_KEYS.includes(key), c.id + ': unknown ' + stage + ' expectation ' + key);
    }
    for (const stub of [c.expect.stub, c.expect.before?.stub, c.expect.after?.stub]) {
      assert.ok(stub === undefined || stub === true, c.id + ': a stub expectation is true or absent');
    }
    // An inline form that decodes to nothing would be found in any view.
    for (const inline of [c.expect.stubOrInlineBase64, c.expect.before?.stubOrInlineBase64, c.expect.after?.stubOrInlineBase64]) {
      assert.ok(inline === undefined || Buffer.from(inline, 'base64').length > 0, c.id + ': stubOrInlineBase64 must decode to bytes');
    }
    // A case that expects a successful fetch declares the bytes it must save.
    if (c.operation === 'fetch' && c.expect.ok === true) {
      assert.equal(typeof c.expect.decodedBase64, 'string', c.id + ': a successful fetch declares its decodedBase64');
    }
    const blocks = expand(c.blocks, 'http://origin.invalid', c.id);
    // A label's own tab or line break can be looked for only with its context around it.
    if ([c.expect, c.expect.before, c.expect.after].some(stage => stage?.cleanLabel)) labelBreaks(blocks, c.id);
    for (const block of blocks) {
      if (typeof block.uri !== 'string') continue;
      // Process-global Host caches key references by URI, so no two cases share one.
      assert.ok(!uris.has(block.uri), c.id + ': URI shared with ' + uris.get(block.uri));
      uris.set(block.uri, c.id);
      // A Host that dereferenced a local URI and accepted its payload would read
      // it whole and succeed, so the case fails such a Host, however the corpus
      // spells the URI. Only what reaches the model, storage or the network is
      // observed.
      const local = localPayload(block.uri);
      if (local) {
        assert.ok(local.length > 0 && block.sizeBytes === local.length && c.maxBytes >= local.length,
          c.id + ': a local URI must name a payload readable whole within the case');
      }
    }
  }
}

function forbiddenForms(value) {
  // Also the JSON-escaped form, as a serialized history lane shows it.
  return [...new Set([value, JSON.stringify(value).slice(1, -1)])];
}

export function checkObservation(c, out, network, adapter, token) {
  const e = c.expect;
  // The joined text catches a value within one piece and one split across two.
  const checkHidden = (pieces, hidden, where) => {
    const text = pieces.join('');
    hidden.forEach((value, index) => {
      for (const form of forbiddenForms(value)) {
        assert.ok(!text.includes(form), 'model-visible forbidden value #' + (index + 1) + ' in ' + where);
      }
    });
  };
  // Nothing the model reads holds an unsafe label character, or the value of a
  // field rejected as invalid: rejection reaches past testimony.
  const checkLabelsAndFields = (pieces, visible, where) => {
    const text = pieces.join('');
    if (visible.cleanLabel) {
      assert.ok(!UNSAFE_LABEL.test(text), 'unsafe display-label characters in ' + where);
      for (const pattern of labelBreaks(c.blocks, c.id)) {
        assert.ok(!pattern.test(text), "a display label's tab or line break in " + where);
      }
    }
    for (const field of visible.missingFields ?? []) {
      for (const block of c.blocks) {
        if (typeof block[field] !== 'string' || block[field].length < REJECTED_RUN) continue;
        for (const form of forbiddenForms(block[field].slice(0, REJECTED_RUN))) {
          assert.ok(!text.includes(form), 'rejected ' + field + ' shown in ' + where);
        }
      }
    }
  };
  // A stage's visibility fields override the shared ones, and its hidden values add to theirs.
  const visibleAt = stage => ({ ...e, ...e[stage], hidden: [...(e.hidden ?? []), ...(e[stage]?.hidden ?? [])] });
  if (c.operation === 'registry') {
    assert.equal(out.stableId, out.firstId, 'registration keeps a live reference stable');
    assert.equal(out.live, out.fresh.refId, 'a live id resolves to its own record');
    assert.equal(out.evicted, null, 'evicted reference must be a defined miss');
    assert.equal(out.unknown, null, 'unknown reference must be a defined miss');
    for (const error of [out.evictedError, out.unknownError]) {
      assert.equal(error.success, false, 'lookup error reports failure');
      assert.equal(error.isError, true, 'lookup error is an error');
      assert.match(error.error, /unknown reference/i, 'lookup error says unknown reference');
    }
    // A lookup error is model-visible, as the views are.
    for (const [error, where] of [[out.evictedError, 'the evicted lookup error'], [out.unknownError, 'the unknown lookup error']]) {
      checkHidden([error.error], e.hidden ?? [], where);
      checkLabelsAndFields([error.error], e, where);
    }
    assert.notEqual(out.fresh.refId, out.firstId, 'evicted id must not be reused');
    assert.equal(new Set(out.ids).size, out.ids.length, 'each new record must have a distinct id');
    assert.equal(out.fresh.testimony.uri, c.blocks[0].uri, 'the fresh record is for the same URI');
    return;
  }
  assert.ok(out.before && typeof out.before.history === 'string' && typeof out.before.wake === 'string' && Array.isArray(out.before.push), 'adapter must observe both model-facing conversion paths');
  if (c.operation === 'fetch') assert.ok(out.after && typeof out.after.history === 'string' && typeof out.after.wake === 'string' && Array.isArray(out.after.push), 'fetch must observe post-fetch model views');
  const views = [['before', out.before], ...(out.after ? [['after', out.after]] : [])];
  for (const [stage, view] of views) {
    const visible = visibleAt(stage);
    const lanes = [['push', semanticStrings(view.push)], ['wake', [view.wake]], ['history', [view.history]]];
    for (const [lane, pieces] of lanes) {
      const text = pieces.join('');
      const where = stage + ' ' + lane;
      assert.ok(text.length <= adapter.maxViewChars, 'view exceeds declared Host display bound');
      checkHidden(pieces, visible.hidden, where);
      // An included text appears within one piece, not across two.
      for (const included of visible.includes ?? []) assert.ok(pieces.some(piece => piece.includes(included)), 'missing text: ' + included);
      if (visible.stub) {
        // Registering the same testimony returns the Host's record, so a stub
        // that names any other id fails here.
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
        const limit = profile?.fieldChars?.[visible.displayField];
        assert.ok(Number.isSafeInteger(limit) && limit > 0, 'missing Host field display limit');
        const label = c.blocks[0][visible.displayField];
        if (label.length > limit) {
          assert.ok(!text.includes(label.slice(0, limit + 1)), visible.displayField + ' shown past the declared display limit in ' + where);
          // The longest prefix of the label shown must end in a declared mark.
          let shown = 0;
          while (shown < limit && text.includes(label.slice(0, shown + 1))) shown++;
          assert.ok(shown > 0, visible.displayField + ' over the display limit must still be shown, shortened, in ' + where);
          assert.ok(profile.truncationMarkers.some(mark => text.includes(label.slice(0, shown) + mark)), 'display truncation must be marked according to the declared Host profile');
        } else {
          assert.ok(text.includes(label), visible.displayField + ' within the display limit must be shown whole in ' + where);
        }
      }
      checkLabelsAndFields(pieces, visible, where);
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
  // The fetch_reference result is model-visible too, as the views after the fetch are.
  assert.ok(out.tool && typeof out.tool.success === 'boolean', 'fetch must observe the fetch_reference result');
  assert.equal(out.tool.success, out.outcome.ok, 'fetch_reference reports the fetch outcome');
  const result = semanticStrings(out.tool.success ? out.tool.data : out.tool.error), after = visibleAt('after');
  checkHidden(result, after.hidden, 'the fetch_reference result');
  checkLabelsAndFields(result, after, 'the fetch_reference result');
  if ('ok' in e) assert.equal(out.outcome.ok, e.ok, 'fetch outcome ' + (out.outcome.ok ? 'succeeded' : 'failed: ' + out.outcome.error));
  if ('requests' in e) assert.equal(network.requests.length, e.requests, 'request count');
  // §19.6.1 permits applying the connection credential; a Host may omit it.
  // This fixture is public, so credential use is an explicit tested profile.
  if (network.requests.length) {
    assert.ok(['connection-bearer', 'omit'].includes(adapter.credentialPolicy), 'declare the Host credential-use policy');
    const authorization = adapter.credentialPolicy === 'connection-bearer' ? 'Bearer ' + token : null;
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
    assert.equal(out.records[0].fetchedPath, undefined, 'failed fetch leaves no fetched path');
    assert.equal(out.records[0].verifiedBytes, undefined, 'failed fetch verifies no bytes');
  } else {
    assert.equal(out.saves.length, 1, 'successful fetch must materialize once');
    const saved = out.saves[0], record = out.records[0];
    const bytes = Buffer.from(saved.base64, 'base64');
    assert.equal(out.outcome.bytes, bytes.length, 'outcome bytes match the saved bytes');
    assert.equal(record.verifiedBytes, bytes.length, 'record verifiedBytes match the saved bytes');
    assert.equal(record.fetchedPath, out.outcome.path, 'record fetchedPath is the outcome path');
    if (e.decodedBase64 !== undefined) assert.equal(saved.base64, e.decodedBase64, 'saved bytes must be decoded identity octets');
    if (e.savedMime) {
      assert.equal(record.verifiedMimeType, e.savedMime, 'record stores the observed MIME type');
      assert.equal(out.outcome.mimeType, e.savedMime, 'outcome MIME type');
      assert.equal(saved.mimeType, e.savedMime, 'saved MIME type');
    }
    if (e.digestVerified) {
      assert.equal(record.digestVerified, true, 'record digest verified');
      assert.equal(out.outcome.digestVerified, true, 'outcome digest verified');
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
  const vectors = await readJson(corpusPath);
  assertCorpus(vectors);
  const { default: Ajv } = await import(pathToFileURL(resolve(options.ajv)).href);
  const ajv = new Ajv({ strict: true, strictRequired: false, allErrors: true });
  const spec = await readFile(resolve(here, '../SPEC.md'), 'utf8');
  const schema = JSON.parse(spec.split('### B.1 ContentBlock')[1].split('```jsonc\n')[1].split('```')[0]);
  const validate = ajv.compile(schema);
  const legacy = await readJson(resolve(here, 'bulk-reference-legacy-schema.json'));
  const validateLegacy = ajv.compile(legacy.schema);
  const adapterPath = resolve(options.adapter ?? resolve(here, 'agent-framework-bulk-references.mjs'));
  const module = await import(pathToFileURL(adapterPath).href);
  const adapter = await module.createAdapter(resolve(options.framework));
  assert.ok(Number.isSafeInteger(adapter.maxViewChars) && adapter.maxViewChars > 0);
  assert.ok(Array.isArray(adapter.displayProfile?.truncationMarkers) && adapter.displayProfile.truncationMarkers.length > 0 && adapter.displayProfile.truncationMarkers.every(mark => typeof mark === 'string' && mark.length > 0), 'adapter must declare nonempty truncation markers');
  assert.ok(['connection-bearer', 'omit'].includes(adapter.credentialPolicy), 'adapter must declare credentialPolicy');
  assert.ok(Number.isSafeInteger(adapter.registryQuota) && adapter.registryQuota > 0, 'adapter must declare its registry quota');
  for (const c of vectors.cases.filter(c => c.operation === 'registry')) {
    assert.ok(Number.isSafeInteger(c.registrations) && c.registrations > adapter.registryQuota, c.id + ' must register more records than the declared registry quota');
  }
  const ajvPackage = await readJson(resolve(dirname(options.ajv), '../package.json'));
  // The suite is identified by its files' hashes, with or without a Git checkout.
  const suiteFiles = ['bulk-reference-vectors.json', 'bulk-reference-legacy-schema.json', 'bulk-reference-11-file-refused.wav', 'check-bulk-references.mjs'];
  const suiteHashes = {};
  for (const file of suiteFiles) suiteHashes[file] = createHash('sha256').update(await readFile(resolve(here, file))).digest('hex');
  suiteHashes['SPEC.md'] = createHash('sha256').update(spec).digest('hex');
  suiteHashes['adapter'] = createHash('sha256').update(await readFile(adapterPath)).digest('hex');
  // A Host that reads a file: URI's path without decoding it finds the payload
  // only where the path needs no percent-encoding, so its verdict on
  // 11-file-refused depends on where this checkout is.
  const notes = localPayloadURL.includes('%')
    ? ['11-file-refused: this checkout\'s path needs percent-encoding in a file: URL, so the case can also pass a Host that reads the URL\'s path without decoding it, when its refusal doesn\'t name the file']
    : [];
  for (const note of notes) console.log('note: ' + note);
  const report = {
    suiteHashes, notes,
    runtime: process.version, bun: process.versions.bun ?? null,
    validator: { name: 'Ajv', version: ajvPackage.version, strict: true, strictRequired: false, schema: 'SPEC.md Appendix B.1' },
    legacySchemaRevision: legacy.sourceRevision, host: adapter.identity, displayProfile: adapter.displayProfile,
    credentialPolicy: adapter.credentialPolicy, registryQuota: adapter.registryQuota, results: [],
  };
  for (const raw of vectors.cases) {
    const result = { id: raw.id, rfc: raw.rfc, schema: null, host: null };
    let network;
    try {
      network = await fixture(raw.response);
      const c = expand(raw, network.origin);
      try {
        assert.deepEqual(c.blocks.map(block => validate(block)), c.schemaValid, 'strict emitter-schema acceptance');
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
        await network.settle({ closed: Boolean(c.expect.abortStream) });
        checkObservation(c, observation, network, adapter, vectors.fixtures.token);
        result.host = 'pass';
      } catch (error) { result.host = 'fail'; result.hostError = error.message; }
    } catch (error) {
      // A case that can't be set up fails alone; the others still run.
      result.schema ??= 'fail';
      result.host = 'fail';
      result.hostError = 'setup: ' + error.message;
    } finally { await network?.close(); }
    report.results.push(result);
    console.log((result.schema === 'pass' && result.host === 'pass' ? 'PASS ' : 'FAIL ') + raw.id
      + (result.emitter ? '\n  note: ' + result.emitter : '')
      + (result.schemaError ? '\n  schema: ' + result.schemaError : '') + (result.hostError ? '\n  host: ' + result.hostError : ''));
  }
  report.schemaPassed = report.results.filter(r => r.schema === 'pass').length;
  report.hostPassed = report.results.filter(r => r.host === 'pass').length;
  console.log(JSON.stringify({ ...report, results: undefined }, null, 2));
  if (options.report) await writeFile(options.report, JSON.stringify(report, null, 2) + '\n');
  return report.results.some(r => r.schema === 'fail' || r.host === 'fail') ? 1 : 0;
}

// Real paths on both sides, so a run through a symbolic link still runs.
const real = path => { try { return realpathSync(path); } catch { return null; } };
if (process.argv[1] && real(resolve(process.argv[1])) === real(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
