// Portable vector assertions; behavior comes from the separately loaded Host.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { host: { type: "string" }, adapter: { type: "string" }, vectors: { type: "string" } },
  allowPositionals: false,
});
if (!values.host) throw Error("Usage: bun run conformance/check-tool-classes.mjs --host /path/to/agent-framework [--adapter ./adapter.mjs] [--vectors ./vectors.json]");
const vectors = JSON.parse(await readFile(values.vectors ?? new URL("./tool-class-vectors.json", import.meta.url), "utf8"));
assert.equal(vectors.profile, "rfc-008-revision-2");
const numbers = vectors.vectors.map(vector => vector.rfcVector).sort((a, b) => a - b);
assert.deepEqual(numbers, Array.from({ length: 11 }, (_, index) => index + 1), "exactly one vector for each RFC-008 case");
const adapterURL = values.adapter ? pathToFileURL(resolve(values.adapter)) : new URL("./agent-framework-tool-classes.mjs", import.meta.url);
const { loadHost } = await import(adapterURL.href);
const host = await loadHost(values.host);
console.log("Host evidence: " + JSON.stringify(host.info));
let stages = 0;
const diagnostics = [];
for (const vector of vectors.vectors) {
  assert.ok(vector.stages.length > 0, vector.id + " must have at least one stage");
  const observed = await host.observe(vector);
  assert.equal(observed.length, vector.stages.length, vector.id + " stage count");
  for (const [index, stage] of vector.stages.entries()) {
    const result = observed[index];
    const label = vector.id + " stage " + (index + 1);
    assert.deepEqual(result.descriptor.class, stage.expect.classes, label + " descriptor class");
    assert.deepEqual(result.effective, { classes: stage.expect.classes, source: stage.expect.source }, label + " class/source");
    assert.equal(result.model.name, stage.modelName, label + " projected name");
    assert.equal(result.model.description, stage.tool.description, label + " description bytes");
    assert.equal(JSON.stringify(result.model.inputSchema), JSON.stringify(stage.tool.inputSchema), label + " schema bytes");
    assert.ok(result.opening, label + " must emit metadata, not silently suppress");
    assert.equal(result.opening.phase, "started", label + " phase");
    assert.deepEqual(result.opening.class, stage.expect.classes, label + " reported classes");
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
