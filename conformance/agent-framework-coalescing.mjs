// Wire/Host adapter. Expected outcomes live in the independent corpus/runner.
import { createHash } from 'node:crypto';
import { measureReplacementTiming } from './coalescing-timing.mjs';
import { fork } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const pause = ms => new Promise(done => setTimeout(done, ms));
async function until(predicate, label, ms = 5000) {
  const end = Date.now() + ms;
  while (!predicate()) { if (Date.now() > end) throw new Error('Fixture timeout: ' + label); await pause(5); }
}
const workerFile = fileURLToPath(new URL('./coalescing-host-worker.mjs', import.meta.url));
const textBlock = text => text ? [{ type: 'text', text }] : [];
export const TIMESTAMP = '2026-01-01T00:00:00Z';

// This is the same peer response handler used by the live WebSocket fixture.
// Each overlapping request owns its entry across awaits and completion order.
export async function respondToRender({ renders, server, params, plan: given, held, reply, replyError, send }) {
  // A plan may answer each subject differently (RFC-006 vector 20a): `byKey`
  // overrides the plan for a render request carrying that `key`.
  const plan = given.byKey && Object.hasOwn(given.byKey, params?.key) ? { ...given, ...given.byKey[params.key] } : given;
  const entry = { server, params };
  renders.push(entry);
  if (plan.mode === 'held') held.push({ reply, params });
  else if (plan.mode === 'error') replyError({ code: -32000, message: 'fixture renderer error' });
  else if (plan.mode === 'inference-request') {
    const response = await send(server, 'inference/request', { featureSet: 'doc', messages: [] });
    entry.inferenceResponse = response;
    reply({ content: textBlock(plan.text) });
  } else if (plan.mode === 'notice-summary') reply({ content: textBlock('DROPPED=' + params.dropped) });
  else reply({ content: plan.mode === 'empty' ? [] : textBlock(plan.text) });
}

export async function createAdapter(root) {
  const require = createRequire(resolve(root, 'package.json'));
  const { WebSocketServer } = require('ws');
  const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()) throw new Error('Use a clean Framework checkout');
  const dependencies = {};
  for (const name of ['@animalabs/chronicle', '@animalabs/context-manager', '@animalabs/membrane', 'ws']) {
    dependencies[name] = JSON.parse(await readFile(resolve(root, 'node_modules', name, 'package.json'), 'utf8')).version;
  }
  const inspected = {
    'src/gate/event-gate.ts': '6d1aafbff71f2954828e6ae9bca7f8512e994fe8d31a20a18fc15bab243495d3',
    'src/framework.ts': '9f7e02d34f33c52b2b49a8138b79dbbd5fdf32dbda976932c82b241b906d817b',
    'src/mcpl/push-coalescer.ts': 'cd9470ebe2d9db172a7fe53965912f479b459e5825e5e88568147c72f7192aba',
  };
  const sourceHashes = {};
  for (const path of Object.keys(inspected)) sourceHashes[path] = createHash('sha256').update(await readFile(resolve(root, path))).digest('hex');
  const sourceVerified = Object.entries(inspected).every(([path, hash]) => sourceHashes[path] === hash);
  const postponement = { kind: sourceVerified ? 'missing-required-bound' : 'unassessed-source', sourceVerified, sourceHashes, sourceRevision: revision,
    basis: 'Inspected reset-only EventGate.handleDebounce and Framework/coalescer wake paths; no finite replacement-postponement mechanism. A finite live probe corroborates behavior but cannot prove infinite starvation.' };
  const adapter = {
    identity: { implementation: 'Agent Framework', revision, dependencies, runtime: 'Bun ' + process.versions.bun },
    profile: {
      initialHistory: 'none', recovery: 'conservative', contextConsumption: 'shared',
      noticeRetention: 64, retryWindowMs: 3600000, renderTimeoutMs: 5000,
      postponement,
      preconditions: sourceVerified ? {
        'hard-subject-limit': { status: 'inapplicable', reason: 'Only idle subjects are pruned above a soft target; live subjects have no hard admission cap.' },
        'per-context-consumption': { status: 'inapplicable', reason: 'This Host uses conservative shared consumption, an allowed policy.' },
        'unadvertised-channel-scoped-push': { status: 'inapplicable', reason: 'This Host profile advertises channelScopedPush; the absent-leaf condition does not apply.' },
        'finite-wake-postponement-bound': { status: 'blocked', reason: 'Blocked by the missing mandatory bound recorded in case 36.' },
      } : {},
      capabilities: ['timing-observation', 'wire', 'multi-server', 'compression', 'process-restart', 'process-kill', 'held-render', 'debounce', 'initial-history-none', 'untracked-history-unknown', 'conservative-recovery', 'retain-64-notices'],
    },
    async open(setup = {}) {
      const directory = await mkdtemp(join(tmpdir(), 'mcpl-rfc006-'));
      const servers = new Map(), renders = [], published = [], hostCaps = [], held = [];
      let renderPlan = { mode: 'immediate', text: 'RENDERED' };
      let child, ready = false, sequence = 1, wireSequence = 1000, running = null;
      let latest = { contexts: {}, requests: [], trace: [] }, priorRequests = [], diagnostics = '';
      const pending = new Map(), replies = new Map();
      const serverIds = setup.servers ?? ['editor'];
      const send = (server, method, params) => new Promise((done, reject) => {
        const id = wireSequence++;
        const timer = setTimeout(() => { replies.delete(id); reject(new Error('Fixture timeout: wire reply ' + method)); }, 8000);
        replies.set(id, message => { clearTimeout(timer); done(message); });
        servers.get(server).socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
      for (const server of serverIds) {
        const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
        await once(wss, 'listening');
        const entry = { wss, socket: null, online: true, connections: 0, policyUpdates: 0 };
        servers.set(server, entry);
        wss.on('connection', socket => {
          if (!entry.online) { socket.close(); return; }
          entry.socket = socket; entry.connections++;
          socket.on('message', async bytes => {
            const message = JSON.parse(String(bytes));
            if (!message.method) { replies.get(message.id)?.(message); replies.delete(message.id); return; }
            const reply = result => { if (socket.readyState === 1) socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })); };
            if (message.method === 'initialize') {
              hostCaps.push({ server, capabilities: message.params.capabilities.experimental.mcpl });
              reply({ protocolVersion: '2024-11-05', capabilities: { tools: {}, experimental: { mcpl: {
                version: '0.5', pushEvents: true, inferenceRequest: true,
                channels: { incoming: true, register: true, lifecycle: true, publish: true },
                featureSets: Object.fromEntries(['doc', 'other'].map(name => [name, { description: name, uses: ['pushEvents'] }])),
              } } }, serverInfo: { name: server, version: 'fixture' } });
            } else if (message.method === 'tools/list') reply({ tools: [] });
            else if (message.method === 'featureSets/update') { entry.policyUpdates++; reply({ accepted: true }); }
            else if (message.method === 'channels/publish') { published.push(message.params); reply({ delivered: true }); }
            else if (message.method === 'channels/open') reply({ channel: { id: message.params.channelId, type: 'discord', label: message.params.channelId } });
            else if (message.method === 'channels/close') reply({ closed: true });
            else if (message.method === 'push/render') {
              await respondToRender({ renders, server, params: message.params, plan: { ...renderPlan }, held, reply, send,
                replyError: error => socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, error })),
              });
            } else if (message.id !== undefined) reply({});
          });
        });
      }
      const config = {
        storePath: join(directory, 'store'), agents: setup.agents, compression: setup.compression, background: setup.background,
        gate: setup.gate, conversations: setup.conversations, errorPolicy: setup.errorPolicy,
        servers: [...servers].map(([id, entry]) => ({
          id, url: 'ws://127.0.0.1:' + entry.wss.address().port, enabledFeatureSets: ['doc', 'other'],
          reconnect: true, reconnectIntervalMs: 20,
        })),
      };
      function rpc(operation, value) {
        return new Promise((done, reject) => {
          const id = sequence++, timer = setTimeout(() => { pending.delete(id); reject(new Error('Fixture timeout: worker ' + operation)); }, 15000);
          pending.set(id, message => { clearTimeout(timer); message.error ? reject(new Error(message.error)) : done(message.result); });
          child.send({ id, operation, value });
        });
      }
      async function launch() {
        ready = false;
        child = fork(workerFile, [root], { cwd: directory, execPath: process.execPath, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        child.stdout.on('data', data => { diagnostics = (diagnostics + data).slice(-16000); });
        child.stderr.on('data', data => { diagnostics = (diagnostics + data).slice(-16000); });
        child.on('message', message => {
          if (message.ready) ready = true;
          else { pending.get(message.id)?.(message); pending.delete(message.id); }
        });
        child.on('exit', () => {
          for (const finish of pending.values()) finish({ error: 'Host worker exited' });
          pending.clear();
        });
        await until(() => ready, 'worker ready');
        latest = await rpc('create', config);
      }
      async function stopChild(kill = false) {
        if (!child || child.exitCode !== null || child.signalCode) return;
        if (!kill) await rpc('stop');
        const exit = once(child, 'exit'); child.kill(kill ? 'SIGKILL' : 'SIGTERM'); await exit;
      }
      async function snapshot(reply) {
        latest = await rpc('snapshot');
        return structuredClone({ ...latest, requests: [...priorRequests, ...latest.requests], reply, renders, published, hostCaps,
          modelCalls: priorRequests.length + latest.requests.length, diagnostics });
      }
      try { await launch(); } catch (error) {
        await stopChild(true);
        for (const { wss } of servers.values()) { for (const socket of wss.clients) socket.terminate(); await new Promise(done => wss.close(done)); }
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      const session = {
        async step(step) {
          let reply;
          const server = step.server ?? 'editor';
          if (step.op === 'continuousReplacements') {
            const timing = await measureReplacementTiming(session, () => adapter.open(setup), step, postponement);
            return { ...await snapshot(), timing };
          }
          else if (step.op === 'send') reply = await send(server, step.method, step.params);
          else if (step.op === 'register') reply = await send(server, 'channels/register', { channels: [{ id: step.channel ?? 'chat', type: 'discord', label: step.channel ?? 'chat', metadata: { channelType: 'guild_text' } }] });
          else if (step.op === 'render') renderPlan = step.plan;
          else if (step.op === 'turn') {
            latest = await rpc('run');
            const runError = latest.runError;
            const out = await snapshot(reply);
            out.runError = runError;
            return out;
          } else if (step.op === 'assemble') {
            await rpc('queueInference', { agent: step.agent });
            latest = await rpc('run');
            const runError = latest.runError;
            return { ...await snapshot(reply), runError };
          } else if (step.op === 'queueInference') await rpc('queueInference', { agent: step.agent });
          else if (step.op === 'channelTool') {
            const result = await rpc('channelTool', { server, channel: step.channel ?? 'chat', name: step.name });
            return { ...await snapshot(reply), toolResult: result.toolResult };
          } else if (step.op === 'startTurn') { running = rpc('run'); running.catch(() => {}); }
          else if (step.op === 'waitRender') await until(() => renders.length >= step.count, 'render request');
          else if (step.op === 'releaseRender') {
            const batch = held.shift();
            if (!batch) throw new Error('No held render to release');
            batch.reply({ content: textBlock(step.text) });
          } else if (step.op === 'joinTurn') {
            if (!running) throw new Error('No running turn');
            latest = await running; running = null;
            const runError = latest.runError;
            return { ...await snapshot(reply), runError };
          } else if (step.op === 'wait') await pause(step.ms);
          else if (step.op === 'restart' || step.op === 'kill') {
            latest = await rpc('snapshot'); priorRequests.push(...latest.requests);
            await stopChild(step.op === 'kill');
            if (running) { running.catch(() => {}); running = null; }
            await launch();
          } else if (step.op === 'disconnect') { servers.get(server).online = false; servers.get(server).socket.terminate(); }
          else if (step.op === 'reconnect') {
            const entry = servers.get(server), count = entry.policyUpdates;
            entry.online = true;
            await until(() => entry.policyUpdates > count, 'renegotiated transport');
            await pause(100);
          } else if (step.op === 'reassign') { latest = await rpc('reassign', { server }); await pause(100); }
          else if (step.op === 'grant') latest = await rpc('grant', { server, leaves: step.leaves });
          else if (step.op === 'disableFeature') latest = await rpc('disableFeature', { server, featureSet: step.featureSet ?? 'doc' });
          else if (step.op === 'compress') {
            latest = await rpc('compress');
            const level = latest.summaryLevel;
            return { ...await snapshot(reply), summaryLevel: level };
          } else if (step.op === 'suppressWake') await rpc('suppressWake', { agent: step.agent });
          else if (step.op === 'failNextModel') await rpc('failNextModel');
          else if (step.op === 'observe') { /* snapshot below */ }
          else throw new Error('Unknown adapter operation: ' + step.op);
          return snapshot(reply);
        },
        async close() {
          for (const batch of held) batch.reply({ content: [] });
          let failure;
          try { if (running) await running; } catch (error) { failure = error; }
          try { await stopChild(); } catch (error) { failure ??= error; await stopChild(true); }
          finally {
            for (const { wss } of servers.values()) { for (const socket of wss.clients) socket.terminate(); await new Promise(done => wss.close(done)); }
            await rm(directory, { recursive: true, force: true });
          }
          if (failure) throw failure;
        },
      };
      return session;
    },
  };
  return adapter;
}
