// Adapter to Agent Framework's actual ingestion, refresh, projection and policy.
// Run with Bun so the clean external checkout's TypeScript source is imported.
// The tool provider and model transport are synthetic; Chronicle uses a temporary real store.
import { mkdtemp, writeFile, rename, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { format } from "node:util";

const fixture = fileURLToPath(new URL("./tool-class-provider.mjs", import.meta.url));
const clone = value => structuredClone(value);
const pause = () => new Promise(done => setTimeout(done, 10));
async function until(predicate, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause();
  }
  throw Error("Timed out: " + label);
}
async function replaceListing(path, revision, tool) {
  const draft = path + ".next";
  await writeFile(draft, JSON.stringify({ revision, tools: [tool] }));
  await rename(draft, path);
}
async function readLog(path) {
  if (!existsSync(path)) return [];
  return (await readFile(path, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
}

export async function loadHost(root) {
  root = resolve(root);
  const load = relative => import(pathToFileURL(join(root, relative)).href);
  const { AgentFramework } = await load("src/framework.ts");
  const { MockMembrane } = await load("test/helpers/mock-membrane.ts");
  const { CapabilityGrant } = await load("src/mcpl/capability-grant.ts");
  const { openingFor, parseToolObserveParams } = await load("src/mcpl/tool-lifecycle.ts");
  const { resolveToolClass } = await load("src/mcpl/tool-classes.ts");
  const revision = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim() !== "";
  const dependencies = {};
  for (const name of ["@animalabs/chronicle", "@animalabs/context-manager", "@animalabs/membrane"]) {
    dependencies[name] = JSON.parse(await readFile(join(root, "node_modules", name, "package.json"), "utf8")).version;
  }

  return {
    info: { implementation: "Agent Framework", revision, dirty, runtime: "Bun " + Bun.version, dependencies },
    async observe(vector) {
      const directory = await mkdtemp(join(tmpdir(), "mcpl-rfc008-"));
      const listingPath = join(directory, "listing.json");
      const logPath = join(directory, "provider.jsonl");
      const diagnostics = [];
      const originalError = console.error;
      let framework;
      // Sequential execution keeps this capture local to one synthetic Host.
      console.error = (...args) => diagnostics.push(format(...args));
      try {
        await replaceListing(listingPath, 0, vector.stages[0].tool);
        const hostTool = vector.origin === "host";
        const module = {
          name: "host",
          async start() {},
          async stop() {},
          getTools: () => hostTool ? [clone(vector.stages[0].tool)] : [],
          async handleToolCall() { return { success: true, data: "synthetic" }; },
          async onProcess() { return {}; },
        };
        framework = await AgentFramework.create({
          storePath: join(directory, "host.chronicle"),
          membrane: new MockMembrane().asMembrane(),
          agents: [{ name: "probe", model: "synthetic-no-network", systemPrompt: "Conformance fixture." }],
          modules: [module],
          toolClassOverrides: vector.overrides,
          hostToolClasses: vector.hostClasses,
          mcplServers: hostTool ? [] : [{
            id: "s", toolPrefix: "s", command: process.execPath,
            args: [fixture],
            env: { MCPL_VECTOR_LISTING: listingPath, MCPL_VECTOR_LOG: logPath },
          }],
        });
        await framework.start();
        const parsed = parseToolObserveParams({ rules: [{ match: {}, input: true }] });
        if (!parsed.ok) throw Error("The Host rejected the fixture's input-requesting filter");
        const observer = {
          id: "observer",
          grant: new CapabilityGrant(new Set(["toolLifecycle.observe", "toolLifecycle.inputs"]), []),
          toolObserveFilter: parsed.rules,
        };
        const observations = [];
        for (const [index, stage] of vector.stages.entries()) {
          if (index > 0) {
            if (hostTool) throw Error("Host-tool re-list is outside this adapter's fixture contract");
            await replaceListing(listingPath, index, stage.tool);
            await until(async () =>
              (await readLog(logPath)).some(event => event.event === "listed" && event.revision === index)
              && !framework.mcplToolRefreshInFlight,
            "tools/list_changed refresh " + index);
          }
          await until(() => framework.getAllTools().some(tool => tool.name === stage.modelName),
            "registered model-facing tool " + stage.modelName);
          const descriptor = framework.describeToolForLifecycle(stage.modelName);
          // Ask the Host's resolver for source attribution, which its lifecycle
          // descriptor omits. Read the tables/cache it actually populated.
          const effective = resolveToolClass(
            stage.modelName, hostTool ? undefined : framework.mcplToolClasses.get(stage.modelName),
            { overrides: framework.toolClassOverrides, host: hostTool ? framework.hostToolClasses : [] },
          );
          const model = framework.getToolsForAgent("probe").find(tool => tool.name === stage.modelName);
          const opening = openingFor(observer, { observe: {}, inputs: vector.inputsPolicy }, {
            toolCallId: "fixture-call-" + index, inferenceId: "fixture-inference",
            conversationId: "probe", tool: stage.modelName,
            ...descriptor, input: clone(vector.input),
          }, "started");
          observations.push({
            descriptor: clone(descriptor), effective: clone(effective),
            model: clone(model), opening: clone(opening),
            // The hints are SHOULD-level observations, not invented policy.
            diagnostics: [...diagnostics],
            listedRevisions: (await readLog(logPath)).filter(event => event.event === "listed").map(event => event.revision),
          });
        }
        return observations;
      } finally {
        try { await framework?.stop(); }
        finally {
          console.error = originalError;
          await rm(directory, { recursive: true, force: true });
        }
      }
    },
  };
}
