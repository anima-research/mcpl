// Child process: real Framework and storage; only model transport is synthetic.
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = process.argv[2];
const load = relative => import(pathToFileURL(resolve(root, relative)).href);
const { AgentFramework } = await load('src/framework.ts');
const { MockMembrane, MockYieldingStream, createMockResponse } = await load('test/helpers/mock-membrane.ts');
const { CapabilityGrant } = await load('src/mcpl/capability-grant.ts');
const require = createRequire(resolve(root, 'package.json'));
let framework, membrane, failModel = false, modelFailures = 0, trace = [];
const ok = () => createMockResponse([{ type: 'text', text: 'FIXTURE_MODEL_REPLY' }]);

function snapshot() {
  const contexts = {};
  for (const [name, agent] of framework.agents) contexts[name] = agent.getContextManager().getAllMessages();
  const servers = {};
  for (const [id, config] of framework.mcplServerConfigs) {
    const connection = framework.mcplServerRegistry.getServer(id);
    servers[id] = {
      binding: framework.coalescingBinding(id), connected: connection?.isConnected ?? false,
      policyEstablished: connection?.policyEstablished ?? false, grant: connection?.grant.effectiveList().sort() ?? [],
      operatorPolicy: { url: config.url, enabledFeatureSets: config.enabledFeatureSets, disabledCapabilities: config.disabledCapabilities ?? [] },
      enabledFeatures: Object.fromEntries(['doc', 'other'].map(name => [name, framework.featureSetManager.isEnabled(id, name)])),
    };
  }
  return { contexts, servers, requests: membrane.calls.map(call => ({ model: call.config?.model, messages: call.messages })),
    trace, modelFailures, agents: Object.keys(contexts) };
}

process.on('message', async message => {
  const { id, operation, value } = message;
  try {
    let result;
    if (operation === 'create') {
      membrane = new MockMembrane();
      membrane.streamYielding = request => {
        membrane.calls.push(request);
        if (failModel) { failModel = false; modelFailures++; throw new Error('fixture model failure after assembly'); }
        return new MockYieldingStream([ok()]);
      };
      membrane.complete = async request => {
        membrane.calls.push(request);
        return createMockResponse([{ type: 'text', text: 'FIXTURE_SUMMARY' }]);
      };
      const agents = (value.agents ?? ['agent']).map(name => ({ name, model: 'fixture-' + name, systemPrompt: 'Conformance fixture.' }));
      if (value.compression) {
        const { AutobiographicalStrategy } = require('@animalabs/context-manager');
        agents[0].strategy = new AutobiographicalStrategy({
          adaptiveResolution: true, foldingStrategy: 'kv-stable', recentWindowTokens: 1000,
          targetChunkTokens: 300, kvStableReachTokens: 300, autoTickOnNewMessage: false,
          compressionModel: 'fixture-summarizer',
        });
      }
      framework = await AgentFramework.create({
        storePath: value.storePath, membrane: membrane.asMembrane(), agents, modules: [],
        ...(value.errorPolicy === 'no-retry' ? { errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) } } : {}),
        ...(value.gate ? { gate: { config: value.gate } } : {}),
        ...(value.conversations ? { conversations: value.conversations } : {}),
        mcplServers: value.servers,
      });
      const originalTrace = framework.emitTrace.bind(framework);
      framework.emitTrace = event => { trace.push(event); originalTrace(event); };
      result = snapshot();
    } else if (operation === 'snapshot') result = snapshot();
    else if (operation === 'run') {
      try { await framework.runUntilIdle(); result = { ...snapshot(), runError: null }; }
      catch (error) { result = { ...snapshot(), runError: String(error) }; }
    } else if (operation === 'queueInference') {
      framework.pendingRequests.push({ agentName: value.agent ?? 'agent', reason: 'conformance:assembly', source: 'host', timestamp: Date.now() });
      result = snapshot();
    }
    else if (operation === 'channelTool') {
      result = { ...snapshot(), toolResult: await framework.channelRegistry.handleChannelToolCall(value.name, { channelId: value.channel, serverId: value.server }) };
    }
    else if (operation === 'suppressWake') {
      framework.pendingRequests = framework.pendingRequests.filter(request => request.agentName !== value.agent);
      result = snapshot();
    }
    else if (operation === 'failNextModel') { failModel = true; result = snapshot(); }
    else if (operation === 'grant') {
      framework.mcplServerRegistry.getServer(value.server).establishGrant(new CapabilityGrant(new Set(value.leaves), []));
      result = snapshot();
    } else if (operation === 'disableFeature') {
      framework.featureSetManager.disable(value.server, [value.featureSet]);
      result = snapshot();
    } else if (operation === 'reassign') {
      const config = framework.mcplServerConfigs.get(value.server);
      await framework.restartMcplServer(value.server, { ...config, url: config.url + '/reassigned' });
      result = snapshot();
    } else if (operation === 'compress') {
      const cm = framework.getAgent('agent').getContextManager();
      for (let i = 0; i < 30; i++) cm.addMessage('user', [{ type: 'text', text: 'fixture_filler_' + i + ' ' + 'lorem ipsum '.repeat(40) }]);
      for (let i = 0; i < 12; i++) await cm.tick();
      result = { ...snapshot(), summaryLevel: cm.getMaxSummaryLevel() };
    } else if (operation === 'stop') { await framework.stop(); result = { stopped: true }; }
    else throw new Error('Unknown worker operation: ' + operation);
    process.send({ id, result });
  } catch (error) { process.send({ id, error: String(error?.stack ?? error) }); }
});
process.send({ ready: true });
