// Portable vector assertions; behavior comes from the separately loaded Host.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// These guards freeze the documented evidence, not another Host policy.
const VOCABULARY = ["comms", "memory", "notes", "files", "shell", "web", "computer", "media", "body", "control"];
// Stages per RFC-008 §10 case. Case 5 adds a files-only control and a shell-only tool
// outside the files narrowing, case 8 re-lists twice, case 9 covers each class, and
// case 11 adds a class beside the priority slot and a priority-only tool.
const STAGES = { 1: 1, 2: 1, 3: 1, 4: 1, 5: 3, 6: 1, 7: 1, 8: 3, 9: 10, 10: 1, 11: 3 };
export function assertCorpusCoverage(vectors) {
  assert.equal(vectors.profile, "rfc-008-revision-2");
  assert.deepEqual([...vectors.vocabulary].sort(), [...VOCABULARY].sort(), "the RFC's ten classes");
  assert.equal(new Set(vectors.vectors.map(vector => vector.id)).size, vectors.vectors.length, "unique case ids");
  const numbers = vectors.vectors.map(vector => vector.rfcVector).sort((a, b) => a - b);
  assert.deepEqual(numbers, Array.from({ length: 11 }, (_, index) => index + 1), "exactly one vector for each RFC-008 case");
  for (const vector of vectors.vectors) {
    assert.ok(["server", "host"].includes(vector.origin), vector.id + " origin is server or host");
    // Only a provider's listing is replaced at a later stage.
    if (vector.origin === "host") assert.equal(vector.stages.length, 1, vector.id + ": a host-origin case has one stage");
    for (const [index, stage] of vector.stages.entries()) {
      assert.ok(["sent", "withheld"].includes(stage.expect.input), vector.id + " expected input treatment is sent or withheld");
      // An adapter knows a re-list has landed when the tool's definition changes, and a
      // stale projection shows only if each stage's text is its own.
      const previous = vector.stages[index - 1];
      if (previous) {
        assert.ok(stage.tool.description !== previous.tool.description
          && JSON.stringify(stage.tool.inputSchema) !== JSON.stringify(previous.tool.inputSchema),
          vector.id + " stage " + (index + 1) + "'s description and schema differ from the stage before it");
      }
    }
  }
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
  for (const vector of vectors.vectors) {
    assert.equal(vector.stages.length, STAGES[vector.rfcVector], vector.id + " has its documented stages");
  }
}

function sameClasses(actual, expected, vocabulary, label) {
  assert.ok(Array.isArray(actual), label + " is an array");
  assert.ok(actual.every(value => typeof value === "string" && vocabulary.includes(value)), label + " contains only known classes");
  assert.deepEqual([...new Set(actual)].sort(), [...new Set(expected)].sort(), label + " membership");
}

function checkStage(result, stage, vector, vocabulary, label) {
  for (const key of ["descriptor", "effective", "model"]) assert.ok(result?.[key], label + " " + key + " observed");
  sameClasses(result.descriptor.class, stage.expect.classes, vocabulary, label + " descriptor class");
  sameClasses(result.effective.classes, stage.expect.classes, vocabulary, label + " effective class");
  assert.equal(result.effective.source, stage.expect.source, label + " class source");
  assert.equal(result.model.description, stage.tool.description, label + " description");
  assert.equal(JSON.stringify(result.model.inputSchema), JSON.stringify(stage.tool.inputSchema), label + " serialized schema");
  assert.ok(result.opening, label + " must emit metadata, not silently suppress");
  if (stage.expect.input === "sent") {
    assert.ok(Object.hasOwn(result.opening, "input"), label + " allowed input must be present");
    assert.deepEqual(result.opening.input, vector.input, label + " allowed argument values");
    assert.equal(Object.hasOwn(result.opening, "inputWithheld"), false, label + " no withheld marker");
  } else {
    assert.equal(Object.hasOwn(result.opening, "input"), false, label + " arguments must be absent");
    assert.equal(result.opening.inputWithheld, true, label + " withheld marker");
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: { host: { type: "string" }, adapter: { type: "string" }, vectors: { type: "string" } },
    allowPositionals: false,
  });
  if (!values.host) throw Error("Usage: bun run conformance/check-tool-classes.mjs --host /path/to/agent-framework [--adapter ./adapter.mjs] [--vectors ./vectors.json]");
  const corpusPath = values.vectors ? resolve(values.vectors) : fileURLToPath(new URL("./tool-class-vectors.json", import.meta.url));
  const corpus = await readFile(corpusPath, "utf8");
  const vectors = JSON.parse(corpus);
  assertCorpusCoverage(vectors);
  const adapterPath = values.adapter ? resolve(values.adapter) : fileURLToPath(new URL("./agent-framework-tool-classes.mjs", import.meta.url));
  const { loadHost } = await import(pathToFileURL(adapterPath).href);
  const host = await loadHost(values.host);
  console.log("Corpus: " + corpusPath + " (sha256 " + createHash("sha256").update(corpus).digest("hex") + ")");
  console.log("Adapter: " + adapterPath);
  console.log("Host evidence: " + JSON.stringify(host.info));
  const reference = vectors.referenceHost?.revision;
  console.log((host.info?.revision === reference ? "The Host is" : "The Host is not") + " the corpus's reference revision " + reference);
  const failures = [];
  const diagnostics = [];
  let stages = 0;
  let passed = 0;
  // Every stage is checked, so a failing run reports everything that failed.
  for (const vector of vectors.vectors) {
    stages += vector.stages.length;
    let observed;
    try {
      observed = await host.observe(vector);
      assert.equal(observed.length, vector.stages.length, vector.id + " stage count");
    } catch (error) {
      failures.push(vector.id + ": " + error.message);
      console.log("FAIL " + vector.id + ": " + error.message.split("\n")[0]);
      continue;
    }
    const before = failures.length;
    for (const [index, stage] of vector.stages.entries()) {
      const result = observed[index];
      try {
        checkStage(result, stage, vector, vectors.vocabulary, vector.id + " stage " + (index + 1));
        passed++;
      } catch (error) {
        failures.push(error.message);
      }
      if (stage.diagnosticHint) {
        diagnostics.push({
          vector: vector.id, stage: index + 1, hint: stage.diagnosticHint,
          observed: (result?.diagnostics ?? []).some(line => line.includes(stage.diagnosticHint)),
        });
      }
    }
    console.log((failures.length > before ? "FAIL " : "PASS ") + vector.id + " (" + vector.stages.length + " stage(s))");
  }
  console.log("SHOULD diagnostics: " + JSON.stringify(diagnostics));
  if (failures.length > 0) {
    throw Error("TOOL CLASS CONFORMANCE FAILED (" + passed + " of " + stages + " stages passed)\n" + failures.join("\n"));
  }
  console.log("TOOL CLASS CONFORMANCE OK (" + vectors.vectors.length + " RFC cases, " + stages + " stages)");
}

// Real paths on both sides, so a run through a symbolic link still runs.
const real = path => { try { return realpathSync(path); } catch { return null; } };
if (process.argv[1] && real(resolve(process.argv[1])) === real(fileURLToPath(import.meta.url))) await main();
