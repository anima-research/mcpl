import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertCorpusCoverage, main } from "./check-tool-classes.mjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const corpus = () => JSON.parse(readFileSync(new URL("./tool-class-vectors.json", import.meta.url), "utf8"));
const vector = (value, number) => value.vectors.find(entry => entry.rfcVector === number);
test("the complete frozen corpus validates before Host startup", () => assertCorpusCoverage(corpus()));
test("a missing model-surface class cannot silently reduce coverage", () => {
  const value = corpus();
  vector(value, 9).stages.pop();
  assert.throws(() => assertCorpusCoverage(value), /each known class/);
});
test("a duplicate class cannot stand in for an omitted class", () => {
  const value = corpus();
  const stages = vector(value, 9).stages;
  stages[1].tool._meta = structuredClone(stages[0].tool._meta);
  assert.throws(() => assertCorpusCoverage(value), /each known class/);
});
test("a model-surface stage with two classes doesn't count as one class's coverage", () => {
  const value = corpus();
  vector(value, 9).stages[0].tool._meta["mcpl/class"].push("files");
  assert.throws(() => assertCorpusCoverage(value), /each exercise one class/);
});
test("the reserved-prefix case needs the priority-only control", () => {
  const value = corpus();
  const reserved = vector(value, 11);
  reserved.stages = reserved.stages.filter(stage => Object.hasOwn(stage.tool._meta, "mcpl/class"));
  assert.throws(() => assertCorpusCoverage(value), /priority-only/);
});
test("each part of the priority-only control is required", () => {
  const changes = [
    stage => { stage.tool._meta["mcpl/class"] = ["shell"]; },
    stage => { delete stage.tool._meta["mcpl/priority"]; },
    stage => { stage.expect.classes = ["shell"]; },
    stage => { stage.expect.source = "server"; },
    stage => { stage.expect.input = "sent"; },
  ];
  for (const change of changes) {
    const value = corpus();
    change(vector(value, 11).stages[2]);
    assert.throws(() => assertCorpusCoverage(value), /priority-only/, String(change));
  }
});
test("a missing RFC case cannot pass", () => {
  const value = corpus();
  value.vectors.pop();
  assert.throws(() => assertCorpusCoverage(value), /exactly one vector/);
  const repeated = corpus();
  repeated.vectors[1].rfcVector = 1;
  assert.throws(() => assertCorpusCoverage(repeated), /exactly one vector/);
});
test("a dropped stage cannot pass", () => {
  for (const [number, index] of [[1, 0], [5, 0], [5, 1], [8, 1], [8, 2], [11, 0], [11, 1]]) {
    const value = corpus();
    vector(value, number).stages.splice(index, 1);
    assert.throws(() => assertCorpusCoverage(value), /documented stages/, "case " + number + " stage " + (index + 1));
  }
});
test("a stage repeating the previous stage's definition cannot pass", () => {
  for (const part of ["description", "inputSchema"]) {
    const value = corpus();
    const stages = vector(value, 8).stages;
    stages[1].tool[part] = structuredClone(stages[0].tool[part]);
    assert.throws(() => assertCorpusCoverage(value), /differ from the stage before it/, part);
  }
});
test("the profile, vocabulary and case ids are checked", () => {
  const profile = corpus();
  profile.profile = "rfc-008-revision-1";
  assert.throws(() => assertCorpusCoverage(profile));
  const vocabulary = corpus();
  vocabulary.vocabulary.pop();
  assert.throws(() => assertCorpusCoverage(vocabulary), /ten classes/);
  const ids = corpus();
  ids.vectors[1].id = ids.vectors[0].id;
  assert.throws(() => assertCorpusCoverage(ids), /unique case ids/);
});
test("origin and input treatment take known values", () => {
  const origin = corpus();
  vector(origin, 1).origin = "Server";
  assert.throws(() => assertCorpusCoverage(origin), /origin is server or host/);
  const relisted = corpus();
  vector(relisted, 8).origin = "host";
  assert.throws(() => assertCorpusCoverage(relisted), /host-origin case has one stage/);
  const input = corpus();
  vector(input, 2).stages[0].expect.input = "witheld";
  assert.throws(() => assertCorpusCoverage(input), /sent or withheld/);
});
test("CLI coverage validation runs before importing an adapter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-class-coverage-"));
  try {
    const value = corpus();
    vector(value, 9).stages.pop();
    const file = join(directory, "incomplete.json");
    await writeFile(file, JSON.stringify(value));
    await assert.rejects(main(["--host", "/nonexistent-host", "--adapter", join(directory, "nonexistent.mjs"), "--vectors", file]), /each known class/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("reordering the vocabulary and case 9's stages keeps the documented coverage", () => {
  const value = corpus();
  value.vocabulary.reverse();
  vector(value, 9).stages.reverse();
  assertCorpusCoverage(value);
});

// The checker's per-stage comparisons, run against a stand-in Host that reports the
// expected outcomes with one fault at a time.
const standIn = fileURLToPath(new URL("./tool-class-stand-in.mjs", import.meta.url));
async function check(fault) {
  const log = console.log;
  console.log = () => {};
  try { await main(["--host", fault, "--adapter", standIn]); } finally { console.log = log; }
}
test("a Host reporting every expected outcome passes, in any class order", async () => {
  await check("none");
  await check("reversed");
});
test("each kind of wrong observation fails its stage, and the other stages still run", async () => {
  const faults = {
    "unknown-class": /rfc008-01-declared stage 1 effective class contains only known classes/,
    descriptor: /rfc008-01-declared stage 1 descriptor class membership/,
    source: /rfc008-06-override stage 1 class source/,
    description: /rfc008-09-model-surface stage 3 description/,
    schema: /rfc008-09-model-surface stage 4 serialized schema/,
    sent: /rfc008-05-union stage 3 arguments must be absent/,
    withheld: /rfc008-01-declared stage 1 allowed input must be present/,
    suppressed: /rfc008-02-unclassed stage 1 must emit metadata/,
    unprojected: /rfc008-07-host-built-in stage 1 model observed/,
  };
  for (const [fault, pattern] of Object.entries(faults)) {
    await assert.rejects(check(fault), error => pattern.test(error.message) && /25 of 26 stages passed/.test(error.message), fault);
  }
  await assert.rejects(check("dropped"), error => /rfc008-08-relist stage count/.test(error.message) && /23 of 26 stages passed/.test(error.message));
});
