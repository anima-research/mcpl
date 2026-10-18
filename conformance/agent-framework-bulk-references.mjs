// Adapter only: the runner owns fixtures and assertions.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

export async function createAdapter(root) {
  const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  // Untracked files count: an import can resolve to any file that isn't ignored.
  // The flag overrides a configuration that hides them.
  const dirty = execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim();
  if (dirty) throw new Error('Framework checkout has changes or untracked files; use an isolated clean revision');
  const load = path => import(pathToFileURL(resolve(root, path)).href);
  const refs = await load('src/mcpl/references.ts');
  const { ReferenceFetcher } = await load('src/mcpl/reference-fetcher.ts');
  const { PushHandler } = await load('src/mcpl/push-handler.ts');
  const { FeatureSetManager } = await load('src/mcpl/feature-set-manager.ts');
  const { CapabilityGrant } = await load('src/mcpl/capability-grant.ts');
  const { toolResultDataToHistoryString } = await load('src/tool-result-history.ts');
  const { AgentFramework } = await load('src/framework.ts');
  const dependencies = {};
  for (const name of ['@animalabs/chronicle', '@animalabs/context-manager', '@animalabs/membrane']) {
    dependencies[name] = JSON.parse(await readFile(resolve(root, 'node_modules', name, 'package.json'), 'utf8')).version;
  }
  const render = async blocks => {
    const manager = new FeatureSetManager();
    manager.initializeServer('fixture', { featureSets: { fixture: { description: 'Test event', uses: ['pushEvents'] } } },
      { enabledFeatureSets: ['fixture'] }, new CapabilityGrant(new Set(['pushEvents']), []));
    let event, wake;
    // The wake predicate is the embedder's; this one records the wake text and wakes.
    const handler = new PushHandler(manager, value => { event = value; }, () => {},
      text => { wake = text; return true; });
    await handler.handlePushEvent('fixture', {
      featureSet: 'fixture', eventId: 'fixture-event', payload: { content: blocks },
      timestamp: '2026-01-01T00:00:00Z',
    });
    if (!event) throw new Error('PushHandler did not queue the fixture');
    // The history lane is the tool-history serializer applied to the blocks.
    return { push: event.content, wake, history: toolResultDataToHistoryString(blocks) };
  };
  // Run the actual fetch_reference dispatch: its registry lookup, max_bytes clamp and
  // model-visible result. This adapter supplies the event and trace sinks and, for a
  // live id, the fetcher, which it builds from the fixture's origin and token.
  const viaTool = (input, fetcher) => new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('fetch_reference dispatch did not return')), 10000);
    AgentFramework.prototype.dispatchFetchReferenceToolCall.call({
      emitTrace() {},
      pushEvent(event) { clearTimeout(timer); done(event.result); },
      getReferenceFetcher() {
        if (!fetcher) throw new Error('this lookup has no fetcher');
        return fetcher;
      },
    }, 'fixture', { name: 'fetch_reference', id: 'lookup', input });
  });
  return {
    identity: { implementation: 'Agent Framework', revision, dependencies,
      scope: 'classification, PushHandler wake text and queued content, the tool-history serializer, registry, fetch_reference dispatch, ReferenceFetcher' },
    // This adapter's tested display policy, not a protocol-wide limit. Lengths
    // count UTF-16 code units, as JavaScript's string length and this Host's
    // label truncation do.
    maxViewChars: 2048,
    credentialPolicy: 'connection-bearer',
    displayProfile: { fieldChars: { name: 120, mimeType: 120 }, truncationMarkers: ['…'] },
    // This Host's reference registry keeps at most this many records (MAX_RECORDS).
    registryQuota: 2000,
    async observe(input, environment) {
      const { operation, blocks } = input;
      const parsed = blocks.map(refs.classifyBlock);
      if (operation === 'registry') {
        const registry = refs.referenceRegistry;
        const first = registry.register(parsed[0].testimony, 'fixture');
        const firstId = first.refId;
        const stableId = registry.register(parsed[0].testimony, 'fixture').refId;
        const ids = [firstId];
        const namespace = environment.origin + '/case/' + encodeURIComponent(input.id) + '/eviction/';
        for (let i = 0; i < input.registrations; i++) {
          ids.push(registry.register({ ...parsed[0].testimony, uri: namespace + i }, 'fixture').refId);
        }
        const fresh = registry.register(parsed[0].testimony, 'fixture');
        ids.push(fresh.refId);
        const evicted = registry.get(firstId) ?? null;
        // This lookup has no fetcher to give the dispatch, so it runs only once the
        // first id is gone: a Host that kept the id fails on the eviction, not on a
        // dispatch that can't answer.
        const evictedError = evicted === null ? await viaTool({ ref_id: firstId }) : { notDispatched: 'the first id is still registered' };
        return { firstId, stableId, ids, fresh, live: registry.get(fresh.refId)?.refId ?? null,
          evicted, unknown: registry.get('ref_unknown_fixture') ?? null,
          evictedError, unknownError: await viaTool({ ref_id: 'ref_unknown_fixture' }) };
      }
      // The Framework binds a reference to the server that delivered it at receipt,
      // before its stub is built, as autoFetchReferences does for a tool result's.
      // Since 7b21471 the push lane does too: PushHandler passes the event's server
      // through convertBlock to buildReferenceStub, which registers the reference
      // with it. From 02adf27, RFC-005's measured baseline, until 7b21471, the push
      // lane registered it unbound, and the fetcher refuses an unbound record. So
      // this adapter binds each reference to the fixture's server first, whether or
      // not the revision's push lane would: rendering then finds the same record,
      // bound before and after the operation, and the fetch rows test the fetcher.
      const records = parsed.filter(p => p.kind === 'reference').map(p => refs.referenceRegistry.register(p.testimony, 'fixture'));
      const before = await render(blocks);
      if (operation === 'render') return { parsed, before, records };
      if (operation !== 'fetch') throw new Error('Unknown operation: ' + operation);
      if (records.length !== 1) throw new Error('Fetch fixture needs one reference');
      const saves = [];
      const fetcher = new ReferenceFetcher(
        () => ({ url: environment.origin, token: environment.token }),
        async (name, data, mimeType) => {
          saves.push({ name, base64: data.toString('base64'), mimeType });
          return 'scratch/refs/' + name;
        },
      );
      let outcome;
      const fetchOnce = fetcher.fetch.bind(fetcher);
      fetcher.fetch = async (...args) => (outcome = await fetchOnce(...args));
      const tool = await viaTool({ ref_id: records[0].refId, max_bytes: input.maxBytes }, fetcher);
      const after = await render(blocks);
      return { parsed, before, after, records, outcome, tool, saves };
    },
  };
}
