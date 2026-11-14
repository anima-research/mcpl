// Adapter to Agent Framework's actual ingestion, re-list handling, class listing,
// model-facing request and argument policy.
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
async function until(predicate, describe, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await pause();
  }
  throw Error("Timed out: " + describe());
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
const definition = tool => tool && JSON.stringify([tool.description, tool.inputSchema]);

// waitMs bounds each wait for the Host to register a stage's listing.
export async function loadHost(root, { waitMs = 10000 } = {}) {
  root = resolve(root);
  const load = relative => import(pathToFileURL(join(root, relative)).href);
  const { AgentFramework } = await load("src/framework.ts");
  const { MockMembrane } = await load("test/helpers/mock-membrane.ts");
  const { CapabilityGrant } = await load("src/mcpl/capability-grant.ts");
  const { openingFor, parseToolObserveParams } = await load("src/mcpl/tool-lifecycle.ts");
  const revision = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // Untracked files count: the Host could import any file that isn't ignored.
  const dirty = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).trim() !== "";
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
      let failure;
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
        // The observer, its grants, its filter and the inputs narrowing below are the
        // fixture's. The tool's class metadata is the Host's.
        const observer = {
          id: "observer",
          grant: new CapabilityGrant(new Set(["toolLifecycle.observe", "toolLifecycle.inputs"]), []),
          toolObserveFilter: parsed.rules,
        };
        const observations = [];
        let diagnosticOffset = 0;
        let previous;
        for (const [index, stage] of vector.stages.entries()) {
          if (index > 0) {
            if (hostTool) throw Error("Host-tool re-list is outside this adapter's fixture contract");
            await replaceListing(listingPath, index, stage.tool);
          }
          // Each stage's description and schema are its own, so the Host has applied this
          // stage's listing once the tool appears or its registered definition changes.
          // The Host replaces its tools and their declared classes together.
          const registered = () => framework.getAllTools().find(tool => tool.name === stage.modelName);
          await until(() => registered() !== undefined && definition(registered()) !== previous,
            () => "the Host applying stage " + (index + 1) + "'s listing of " + stage.modelName + "; the Host shows "
              + (registered() ? JSON.stringify(registered()).slice(0, 600) : "no tool by that name"), waitMs);
          previous = definition(registered());
          const descriptor = framework.describeToolForLifecycle(stage.modelName);
          // The Host's own operator listing of the tools this agent is shown, each with
          // its effective class and the source that decided it (RFC-008 §6).
          const listed = framework.listToolClasses("probe").find(entry => entry.tool === stage.modelName);
          // The request the Host would send the model, after its permission and
          // presentation filters. Nothing is sent and no inference runs.
          const request = await framework.previewActivation("probe");
          const model = (request.tools ?? []).find(tool => tool.name === stage.modelName);
          const opening = openingFor(observer, { observe: {}, inputs: vector.inputsPolicy }, {
            toolCallId: "fixture-call-" + index, inferenceId: "fixture-inference",
            conversationId: "probe", tool: stage.modelName,
            ...descriptor, input: clone(vector.input),
          }, "started");
          // The hints are SHOULD-level observations, not invented policy. Each window
          // ends where the next one begins.
          const end = diagnostics.length;
          observations.push({
            descriptor: clone(descriptor),
            effective: listed && { classes: clone(listed.class), source: listed.source },
            model: clone(model), opening: clone(opening),
            diagnostics: diagnostics.slice(diagnosticOffset, end),
          });
          diagnosticOffset = end;
        }
        return observations;
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        const tail = diagnostics.slice(-6).map(line => line.slice(0, 600)).join("\n");
        const events = (await readLog(logPath).catch(() => [])).slice(-6);
        failure.message += "\nHost diagnostic tail:\n" + (tail || "(none)")
          + "\nProvider event tail: " + JSON.stringify(events).slice(0, 2000);
        throw failure;
      } finally {
        // A failure while cleaning up is added to the stage's failure, never put in its place.
        let cleanup;
        try { await framework?.stop(); } catch (error) { cleanup = error; }
        console.error = originalError;
        try { await rm(directory, { recursive: true, force: true }); } catch (error) { cleanup ??= error; }
        if (cleanup !== undefined) {
          if (failure === undefined) throw cleanup;
          failure.message += "\nCleanup also failed: " + (cleanup instanceof Error ? cleanup.message : String(cleanup));
        }
      }
    },
  };
}
