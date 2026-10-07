// Portable vector assertions; behavior comes from the separately loaded Host.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// These guards freeze the documented evidence, not another Host policy.
const VOCABULARY = ["comms", "memory", "notes", "files", "shell", "web", "computer", "media", "body", "control"];
export function assertCorpusCoverage(vectors) {
  assert.equal(vectors.profile, "rfc-008-revision-2");
  assert.deepEqual([...vectors.vocabulary].sort(), [...VOCABULARY].sort(), "the RFC's ten classes");
  assert.equal(new Set(vectors.vectors.map(vector => vector.id)).size, vectors.vectors.length, "unique case ids");
  const numbers = vectors.vectors.map(vector => vector.rfcVector).sort((a, b) => a - b);
  assert.deepEqual(numbers, Array.from({ length: 11 }, (_, index) => index + 1), "exactly one vector for each RFC-008 case");
  for (const vector of vectors.vectors) assert.ok(vector.stages.length > 0, vector.id + " must have stages");
  const surface = vectors.vectors.find(vector => vector.rfcVector === 9);
  const singleClasses = surface.stages.map(stage => {
    const declared = stage.tool._meta?.["mcpl/class"];
    assert.ok(Array.isArray(declared) && declared.length === 1, "model-surface stages each exercise one class");
    return declared[0];
  });
  assert.deepEqual(singleClasses.sort(), [...VOCABULARY].sort(), "model-surface case covers each known class exactly once");
  const reserved = vectors.vectors.find(vector => vector.rfcVector === 11);
  assert.ok(reserved.stages.some(stage => {
    const meta = stage.tool._meta ?? {};
    return Object.hasOwn(meta, "mcpl/priority") && !Object.hasOwn(meta, "mcpl/class")
      && stage.expect.classes.length === 0 && stage.expect.source === "none" && stage.expect.input === "withheld";
  }), "reserved-prefix case exercises a priority-only unclassed tool");
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: { host: { type: "string" }, adapter: { type: "string" }, vectors: { type: "string" } },
    allowPositionals: false,
  });
  if (!values.host) throw Error("Usage: bun run conformance/check-tool-classes.mjs --host /path/to/agent-framework [--adapter ./adapter.mjs] [--vectors ./vectors.json]");
  const vectors = JSON.parse(await readFile(values.vectors ?? new URL("./tool-class-vectors.json", import.meta.url), "utf8"));
  assertCorpusCoverage(vectors);
  const adapterURL = values.adapter ? pathToFileURL(resolve(values.adapter)) : new URL("./agent-framework-tool-classes.mjs", import.meta.url);
  const { loadHost } = await import(adapterURL.href);
  const host = await loadHost(values.host);
  console.log("Host evidence: " + JSON.stringify(host.info));
  function sameClasses(actual, expected, label) {
    assert.ok(Array.isArray(actual), label + " is an array");
    assert.ok(actual.every(value => typeof value === "string" && vectors.vocabulary.includes(value)), label + " contains only known classes");
    assert.deepEqual([...new Set(actual)].sort(), [...new Set(expected)].sort(), label + " membership");
  }
  let stages = 0;
  const diagnostics = [];
  for (const vector of vectors.vectors) {
    assert.ok(vector.stages.length > 0, vector.id + " must have at least one stage");
    const observed = await host.observe(vector);
    assert.equal(observed.length, vector.stages.length, vector.id + " stage count");
    for (const [index, stage] of vector.stages.entries()) {
      const result = observed[index];
      const label = vector.id + " stage " + (index + 1);
      sameClasses(result.descriptor.class, stage.expect.classes, label + " descriptor class");
      sameClasses(result.effective.classes, stage.expect.classes, label + " effective class");
      assert.equal(result.effective.source, stage.expect.source, label + " class source");
      assert.equal(result.model.name, stage.modelName, label + " projected name");
      assert.equal(result.model.description, stage.tool.description, label + " description bytes");
      assert.equal(JSON.stringify(result.model.inputSchema), JSON.stringify(stage.tool.inputSchema), label + " schema bytes");
      assert.ok(result.opening, label + " must emit metadata, not silently suppress");
      assert.equal(result.opening.phase, "started", label + " phase");
      sameClasses(result.opening.class, stage.expect.classes, label + " reported classes");
      if (stage.expect.input === "sent") {
        assert.ok(Object.hasOwn(result.opening, "input"), label + " allowed input must be present");
        assert.deepEqual(result.opening.input, vector.input, label + " allowed argument values");
        assert.equal(Object.hasOwn(result.opening, "inputWithheld"), false, label + " no withheld marker");
      } else {
        assert.equal(stage.expect.input, "withheld", label + " known expected input treatment");
        assert.equal(Object.hasOwn(result.opening, "input"), false, label + " arguments must be absent");
        assert.equal(result.opening.inputWithheld, true, label + " withheld marker");
      }
      if (index > 0 && vector.origin === "server") {
        assert.ok(result.listedRevisions.includes(index), label + " provider served the announced re-list");
      }
      if (stage.diagnosticHint) {
        diagnostics.push({
          vector: vector.id, stage: index + 1, hint: stage.diagnosticHint,
          observed: result.diagnostics.some(line => line.includes(stage.diagnosticHint)),
        });
      }
      stages++;
    }
    console.log("PASS " + vector.id + " (" + vector.stages.length + " stage(s))");
  }
  console.log("SHOULD diagnostics: " + JSON.stringify(diagnostics));
  console.log("TOOL CLASS CONFORMANCE OK (" + vectors.vectors.length + " RFC cases, " + stages + " stages)");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
