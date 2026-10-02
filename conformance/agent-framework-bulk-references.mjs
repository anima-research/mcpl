// Adapter only: the runner owns fixtures and assertions.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

export async function createAdapter(root) {
  const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
  if (dirty) throw new Error('Framework checkout has tracked changes; use an isolated clean revision');
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
    const handler = new PushHandler(manager, value => { event = value; }, () => {},
      text => { wake = text; return true; });
    await handler.handlePushEvent('fixture', {
      featureSet: 'fixture', eventId: 'fixture-event', payload: { content: blocks },
      timestamp: '2026-01-01T00:00:00Z',
    });
    if (!event) throw new Error('PushHandler did not queue the fixture');
    return { push: event.content, wake, history: toolResultDataToHistoryString(blocks) };
  };
  const lookupViaTool = refId => new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('fetch_reference dispatch did not return')), 1000);
    // Execute the actual tool dispatch, substituting only event/trace sinks.
    AgentFramework.prototype.dispatchFetchReferenceToolCall.call({
      emitTrace() {},
      pushEvent(event) { clearTimeout(timer); done(event.result); },
    }, 'fixture', { name: 'fetch_reference', id: 'lookup', input: { ref_id: refId } });
  });
  return {
    identity: { implementation: 'Agent Framework', revision, dependencies,
      scope: 'classification, PushHandler wake/queue content, persisted tool history, registry, fetch_reference dispatch, ReferenceFetcher' },
    // This adapter's tested display policy, not a protocol-wide limit.
    maxViewChars: 2048,
    displayProfile: { fieldChars: { name: 120, mimeType: 120 }, truncationMarkers: ['…'] },
    async observe(input, environment) {
      const { operation, blocks } = input;
      const parsed = blocks.map(refs.classifyBlock);
      if (operation === 'registry') {
        const registry = refs.referenceRegistry;
        const first = registry.register(parsed[0].testimony, 'fixture');
        const firstId = first.refId;
        const stableId = registry.register(parsed[0].testimony, 'fixture').refId;
        const ids = [firstId];
        for (let i = 0; i < input.registrations; i++) {
          ids.push(registry.register({ ...parsed[0].testimony, uri: environment.origin + '/eviction/' + i }, 'fixture').refId);
        }
        const fresh = registry.register(parsed[0].testimony, 'fixture');
        ids.push(fresh.refId);
        return { firstId, stableId, ids, fresh, evicted: registry.get(firstId) ?? null,
          unknown: registry.get('ref_unknown_fixture') ?? null,
          evictedError: await lookupViaTool(firstId), unknownError: await lookupViaTool('ref_unknown_fixture') };
      }
      const before = await render(blocks);
      const records = parsed.filter(p => p.kind === 'reference').map(p => refs.referenceRegistry.register(p.testimony, 'fixture'));
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
      const outcome = await fetcher.fetch(records[0], { maxBytes: input.maxBytes, timeoutMs: 3000 });
      const after = await render(blocks);
      return { parsed, before, after, records, outcome, saves };
    },
  };
}
