import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertCorpusCoverage, main } from "./check-tool-classes.mjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const corpus = () => JSON.parse(readFileSync(new URL("./tool-class-vectors.json", import.meta.url), "utf8"));
test("the complete frozen corpus validates before Host startup", () => assertCorpusCoverage(corpus()));
test("a missing model-surface class cannot silently reduce coverage", () => {
  const value = corpus();
  value.vectors.find(vector => vector.rfcVector === 9).stages.pop();
  assert.throws(() => assertCorpusCoverage(value), /each known class/);
});
test("a duplicate class cannot stand in for an omitted class", () => {
  const value = corpus();
  const stages = value.vectors.find(vector => vector.rfcVector === 9).stages;
  stages[1] = structuredClone(stages[0]);
  assert.throws(() => assertCorpusCoverage(value), /each known class/);
});
test("the reserved-prefix case needs the priority-only control", () => {
  const value = corpus();
  const reserved = value.vectors.find(vector => vector.rfcVector === 11);
  reserved.stages = reserved.stages.filter(stage => Object.hasOwn(stage.tool._meta, "mcpl/class"));
  assert.throws(() => assertCorpusCoverage(value), /priority-only/);
});
test("a missing RFC case or an empty stage list cannot pass", () => {
  const value = corpus();
  value.vectors.pop();
  assert.throws(() => assertCorpusCoverage(value), /exactly one vector/);
  const empty = corpus();
  empty.vectors[0].stages = [];
  assert.throws(() => assertCorpusCoverage(empty), /must have stages/);
});
test("CLI coverage validation runs before importing an adapter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tool-class-coverage-"));
  try {
    const value = corpus();
    value.vectors.find(vector => vector.rfcVector === 9).stages.pop();
    const file = join(directory, "incomplete.json");
    await writeFile(file, JSON.stringify(value));
    await assert.rejects(main(["--host", "/nonexistent-host", "--adapter", join(directory, "nonexistent.mjs"), "--vectors", file]), /each known class/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("class-order variations keep the documented coverage", () => {
  const value = corpus();
  value.vocabulary.reverse();
  value.vectors.find(vector => vector.rfcVector === 9).stages.reverse();
  assertCorpusCoverage(value);
});
