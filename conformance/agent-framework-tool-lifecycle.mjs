// Real Framework adapter. Only model responses and remote tools are synthetic.
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { format } from "node:util";
const fixture = fileURLToPath(
  new URL("./tool-lifecycle-peer.mjs", import.meta.url),
);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(test, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await test()) return;
    await sleep(10);
  }
  throw Error("Timed out: " + label);
}
const logAt = async (path) =>
  existsSync(path)
    ? (await readFile(path, "utf8")).split("\n").filter(Boolean).map(JSON.parse)
    : [];
const splitTool = (tool) =>
  tool.startsWith("host--")
    ? [null, tool.slice(6)]
    : tool.includes("--")
      ? [tool.split("--").slice(0, -1).join("--"), tool.split("--").at(-1)]
      : [null, tool];
export function expandInput(input) {
  if (input?.$fixture === "object-utf8-bytes") {
    const overhead = Buffer.byteLength(JSON.stringify({ data: "" }));
    return { data: "x".repeat(input.bytes - overhead) };
  }
  return structuredClone(input);
}
export async function loadHost(root) {
  root = resolve(root);
  const load = (path) => import(pathToFileURL(join(root, path)).href);
  const { AgentFramework } = await load("src/framework.ts");
  const { MockMembrane, createMockResponse } = await load(
    "test/helpers/mock-membrane.ts",
  );
  const { computeGrant } = await load("src/mcpl/capability-grant.ts");
  const {
    parseToolObserveParams,
    TOOL_OBSERVE_LIMITS,
    DEFAULT_MAX_INPUT_BYTES,
  } = await load("src/mcpl/tool-lifecycle.ts");
  const dependencies = {};
  for (const name of [
    "@animalabs/chronicle",
    "@animalabs/context-manager",
    "@animalabs/membrane",
  ]) {
    dependencies[name] = JSON.parse(
      await readFile(join(root, "node_modules", name, "package.json"), "utf8"),
    ).version;
  }
  const git = (args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  return {
    info: {
      implementation: "Agent Framework",
      revision: git(["rev-parse", "HEAD"]),
      dirty: !!git(["status", "--porcelain", "--untracked-files=no"]),
      runtime: "Bun " + Bun.version,
      dependencies,
      capabilities: { approvalGate: false, providerIdReuse: true },
      limits: TOOL_OBSERVE_LIMITS,
      inputBound: DEFAULT_MAX_INPUT_BYTES,
      boundaries: [
        "Scripted model transport and MCPL tools; real Chronicle store, Framework dispatch/results/abort and stdio observer.",
        "Operator grant changes use computeGrant + real connection.establishGrant; policy-change negotiation itself is outside this adapter.",
        "Subagent uses createEphemeralAgent/runEphemeralToCompletion, with its own context.",
        "Approval-gate cases are not applicable: this Host never emits pending.",
      ],
    },
    parse: (params) => parseToolObserveParams(params),
    async observe(vector) {
      const directory = await mkdtemp(join(tmpdir(), "mcpl-rfc007-"));
      const originalCwd = process.cwd();
      process.chdir(directory); // contain the Host\'s relative failure log
      const diagnostics = [],
        hostCalls = [],
        responses = [],
        grants = [],
        traces = [];
      const saved = {
        error: console.error,
        log: console.log,
        warn: console.warn,
      };
      for (const level of Object.keys(saved))
        console[level] = (...args) => diagnostics.push(format(...args));
      let framework, ephemeral;
      const configs = new Map(),
        logs = new Map(),
        allCalls = vector.actions
          .filter((a) => a.op === "call")
          .flatMap((a) => a.calls);
      const callsByKey = new Map(allCalls.map((c) => [c.key, c]));
      const connections = new Map();
      let activeConversation, streamBefore;
      let ephemeralRun;
      try {
        const serverIds = new Set([
          ...vector.observers.map((o) => o.id),
          ...vector.tools.map((t) => splitTool(t.name)[0]).filter(Boolean),
        ]);
        for (const id of serverIds) {
          const observer = vector.observers.find((o) => o.id === id);
          const path = join(directory, id + ".json"),
            log = join(directory, id + ".jsonl");
          logs.set(id, log);
          await writeFile(
            path,
            JSON.stringify({
              log,
              observer: !!observer,
              featureSets: observer?.featureSets,
              tools: vector.tools
                .filter((t) => splitTool(t.name)[0] === id)
                .map((t) => ({
                  name: splitTool(t.name)[1],
                  description: "Synthetic conformance tool",
                  inputSchema: { type: "object", additionalProperties: true },
                  _meta: { "mcpl/class": t.classes },
                })),
              calls: allCalls.filter((c) => splitTool(c.tool)[0] === id),
            }),
          );
          configs.set(id, {
            id,
            toolPrefix: id,
            command: process.execPath,
            args: [fixture],
            env: { MCPL_FIXTURE: path },
            ...observer?.policy,
          });
        }
        const membrane = new MockMembrane();
        const hostTools = vector.tools.filter((t) => !splitTool(t.name)[0]);
        let hostCallIndex = 0;
        const module = {
          name: "host",
          async start() {},
          async stop() {},
          getTools: () =>
            hostTools.map((t) => ({
              name: splitTool(t.name)[1],
              description: "Synthetic host tool",
              inputSchema: { type: "object" },
            })),
          async handleToolCall(call) {
            const planned = allCalls.filter((c) => !splitTool(c.tool)[0])[
              hostCallIndex++
            ];
            if (!planned || splitTool(planned.tool)[1] !== call.name)
              throw Error("Unexpected host-tool call");
            hostCalls.push({
              event: "call",
              key: planned.key,
              params: { name: call.name, arguments: call.input },
            });
            hostCalls.push({ event: "result", key: planned.key });
            return {
              success: !planned.isError,
              isError: !!planned.isError,
              data: planned.resultText ?? "synthetic-result",
            };
          },
          async onProcess(event) {
            if (event.type === "external-message")
              return {
                addMessages: [
                  {
                    participant: "User",
                    content: [
                      { type: "text", text: "Run the synthetic scenario." },
                    ],
                  },
                ],
                requestInference: event.targetAgents,
              };
            return {};
          },
        };
        const agentConfig = (name) => ({
          name,
          model: "synthetic-no-network",
          systemPrompt: "Conformance fixture.",
        });
        framework = await AgentFramework.create({
          storePath: join(directory, "host.chronicle"),
          membrane: membrane.asMembrane(),
          agents: [agentConfig("conv_1"), agentConfig("conv_2")],
          modules: [module],
          hostToolClasses: Object.fromEntries(
            hostTools.map((t) => [t.name, t.classes]),
          ),
          mcplServers: [...configs.values()],
        });
        framework.onTrace((event) => traces.push(event));
        await framework.start();
        for (const id of serverIds) {
          const connection = framework.mcplServerRegistry.getServer(id);
          if (!connection?.policyEstablished)
            throw Error("Initial policy not established: " + id);
          connections.set(id, connection);
          grants.push({
            server: id,
            stage: "initial",
            paths: connection.grant.effectiveList(),
          });
        }
        await until(
          () =>
            vector.tools.every((t) =>
              framework.getAllTools().some((x) => x.name === t.name),
            ),
          "tool ingestion",
        );
        const barrier = async () => {
          for (const conn of connections.values())
            if (conn.isConnected) await conn.sendRequest("fixture/barrier", {});
        };
        const waitTurn = async () => {
          if (ephemeralRun) {
            await ephemeralRun;
            ephemeralRun = null;
          } else
            await until(
              () =>
                membrane.lastStream !== streamBefore &&
                framework.getAgent(activeConversation)?.state.status ===
                  "idle" &&
                !framework.activeTurnTokens.has(activeConversation),
              "turn settled",
            );
          await barrier();
        };
        for (const action of vector.actions) {
          const observer = action.observer ?? "obs";
          switch (action.op) {
            case "observe": {
              const params =
                action.params?.$fixture === "rules-over-limit"
                  ? {
                      rules: Array.from(
                        { length: TOOL_OBSERVE_LIMITS.rules + 1 },
                        () => ({ match: {} }),
                      ),
                    }
                  : action.params;
              const result = await connections
                .get(observer)
                .sendRequest("fixture/control", {
                  op: "observe",
                  ...(Object.hasOwn(action, "params") ? { params } : {}),
                });
              responses.push({
                action: vector.actions.indexOf(action),
                server: observer,
                response: result,
              });
              break;
            }
            case "call": {
              activeConversation = action.conversation;
              streamBefore = membrane.lastStream;
              membrane.pushResponse(
                createMockResponse(
                  action.calls.map((call) => ({
                    type: "tool_use",
                    id: call.modelId ?? "call_" + call.key,
                    name: call.tool,
                    input: expandInput(call.input),
                  })),
                  "tool_use",
                ),
              );
              membrane.pushResponse(
                createMockResponse([{ type: "text", text: "Done." }]),
              );
              if (
                vector.subagent &&
                activeConversation === vector.subagent.name
              ) {
                ephemeral = await framework.createEphemeralAgent(
                  agentConfig(activeConversation),
                );
                ephemeralRun = framework.runEphemeralToCompletion(
                  ephemeral.agent,
                  ephemeral.contextManager,
                  {
                    startupTimeoutMs: 15000,
                    idleTimeoutMs: 15000,
                    idlePollMs: 100,
                  },
                );
                // Attach a handler now, retaining the rejected promise for waitTurn.
                ephemeralRun.catch(() => {});
              } else
                framework.pushEvent({
                  type: "external-message",
                  source: "conformance",
                  content: [{ type: "text", text: "go" }],
                  metadata: {},
                  triggerInference: true,
                  targetAgents: [activeConversation],
                });
              await until(async () => {
                const seen = [...hostCalls];
                for (const path of logs.values())
                  seen.push(...(await logAt(path)));
                return action.calls.every((call) =>
                  seen.some((x) => x.event === "call" && x.key === call.key),
                );
              }, "provider execution witness");
              if (!action.background) await waitTurn();
              else await barrier();
              break;
            }
            case "wait":
              await waitTurn();
              break;
            case "release":
              for (const [server, conn] of connections) {
                const keys = action.keys.filter(
                  (key) => splitTool(callsByKey.get(key).tool)[0] === server,
                );
                if (keys.length)
                  await conn.sendRequest("fixture/control", {
                    op: "release",
                    keys,
                  });
              }
              break;
            case "disconnect":
              await connections
                .get(action.server)
                .sendRequest("fixture/control", { op: "disconnect" });
              await until(
                () => !connections.get(action.server).isConnected,
                "provider transport closed",
              );
              break;
            case "interrupt": {
              const cancelled = framework.abortInference(
                action.conversation,
                "RFC-007 synthetic interruption",
              );
              if (!cancelled && !action.mayBeIdle)
                throw Error("Host did not interrupt the active turn");
              break;
            }
            case "settle":
              // Late results must traverse the real process queue before the final barrier.
              await until(
                () => traces.some((t) => t.type === "tool:result_dropped"),
                "late result processed by Host",
              );
              await barrier();
              break;
            case "grant": {
              const conn = connections.get(observer);
              const config = { id: observer, ...action.policy };
              configs.set(observer, config);
              framework.mcplServerConfigs.set(observer, config);
              const grant = computeGrant(conn.capabilities, config, {
                mcpToolsAdvertised: conn.mcpToolsAdvertised,
              });
              conn.establishGrant(grant);
              grants.push({
                server: observer,
                stage: "change",
                paths: grant.effectiveList(),
              });
              break;
            }
            default:
              throw Error("Unsupported scenario operation: " + action.op);
          }
        }
        await barrier();
        for (const [server, conn] of connections)
          grants.push({
            server,
            stage: "final",
            paths: conn.grant.effectiveList(),
          });
        const peers = {};
        for (const [id, path] of logs) peers[id] = await logAt(path);
        // Framework reports invalid_uses in diagnostics rather than the wire policy.
        // Normalize the observed reason here; preserve its raw source in the report.
        const disabledFeatures = diagnostics.flatMap((line) => {
          const match =
            /^\[mcpl\] ([^/]+)\/(.+) disabled: (invalid_uses)\b/.exec(line);
          return match
            ? [
                {
                  server: match[1],
                  name: match[2],
                  reason: match[3],
                  source: line,
                },
              ]
            : [];
        });
        const diagnosticCodes = [];
        if (
          diagnostics.some((line) =>
            line.includes("granted without toolLifecycle.observe"),
          )
        )
          diagnosticCodes.push("inputs-without-observe");
        if (diagnostics.some((line) => line.includes("narrowed to NO tools")))
          diagnosticCodes.push("inputs-unnarrowed");
        return {
          diagnosticCodes,
          peers,
          hostCalls,
          responses,
          grants,
          diagnostics,
          traces,
          disabledFeatures,
        };
      } catch (error) {
        error.message += "\nHost tail:\n" + diagnostics.slice(-8).join("\n");
        throw error;
      } finally {
        try {
          await framework?.stop();
          ephemeral?.cleanup();
        } finally {
          Object.assign(console, saved);
          process.chdir(originalCwd);
          await rm(directory, { recursive: true, force: true });
        }
      }
    },
  };
}
