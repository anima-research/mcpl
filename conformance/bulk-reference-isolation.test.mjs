// Real-Host regression: reuse the origin deliberately, not probabilistically.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAdapter } from './agent-framework-bulk-references.mjs';
import { expand, fixture, checkObservation } from './check-bulk-references.mjs';

test('distinct cases cannot inherit a cached fetch when the origin is reused', async () => {
  assert.ok(process.env.MCPL_FRAMEWORK, 'Set MCPL_FRAMEWORK to the isolated Framework checkout');
  const vectors = JSON.parse(await readFile(new URL('./bulk-reference-vectors.json', import.meta.url), 'utf8'));
  const adapter = await createAdapter(process.env.MCPL_FRAMEWORK);
  const first = vectors.cases.find(c => c.id === '03-verified-never');
  const second = vectors.cases.find(c => c.id === '05-digest-mismatch');
  const network = await fixture(first.response);
  try {
    const observed = [];
    for (const raw of [first, second]) {
      network.requests.length = 0;
      const c = expand(raw, network.origin);
      const out = await adapter.observe(c, { origin: network.origin, token: vectors.fixtures.token });
      await network.settle();
      checkObservation(c, out, network, adapter);
      assert.equal(network.requests.length, 1, 'each case must exercise its own fetch');
      observed.push(out);
    }
    assert.equal(observed[0].outcome.ok, true);
    assert.equal(observed[1].outcome.ok, false);
    assert.equal(observed[1].saves.length, 0);
    assert.notEqual(observed[0].records[0].refId, observed[1].records[0].refId);
    assert.notEqual(observed[0].records[0].testimony.uri, observed[1].records[0].testimony.uri);
  } finally { await network.close(); }
});
