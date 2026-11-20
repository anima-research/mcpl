// Real-Host evidence: one stage's warning cannot become the next stage's warning,
// and a listing the Host never applies fails with the Host's evidence attached.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadHost } from "./agent-framework-tool-classes.mjs";

// The adapter's own waits allow 10 s; Bun would otherwise stop a test at 5 s.
const LONG = { timeout: 60000 };
const corpus = async () => JSON.parse(await readFile(new URL("./tool-class-vectors.json", import.meta.url), "utf8"));
const framework = () => {
  assert.ok(process.env.MCPL_FRAMEWORK, "Set MCPL_FRAMEWORK to a clean Agent Framework checkout");
  return process.env.MCPL_FRAMEWORK;
};

test("diagnostics are local to the stage that triggered them", LONG, async () => {
  const vector = structuredClone((await corpus()).vectors.find(value => value.rfcVector === 3));
  const second = structuredClone(vector.stages[0]);
  second.tool.description += "\nSecond stage.";
  second.tool._meta = { "mcpl/class": ["shell", "photon"] };
  second.expect = { classes: ["shell"], source: "server", input: "sent" };
  second.diagnosticHint = "photon";
  vector.stages.push(second);
  const host = await loadHost(framework());
  const observed = await host.observe(vector);
  assert.equal(observed.length, 2);
  assert.ok(observed[0].diagnostics.some(line => line.includes("quantum")), "the first stage's unknown class warning exists");
  assert.deepEqual(observed[1].descriptor.class, ["shell"], "the second listing was actually ingested");
  assert.ok(observed[1].diagnostics.some(line => line.includes("photon")), "the second stage's own warning is captured there");
  assert.equal(observed[1].diagnostics.some(line => line.includes("quantum")), false, "the first warning must not be attributed to the second stage");
  assert.equal(observed[0].diagnostics.some(line => line.includes("photon")), false, "the second warning must not be attributed to the first stage");
});

test("a listing the Host never applies fails with the Host's and the provider's evidence", LONG, async () => {
  const vector = structuredClone((await corpus()).vectors.find(value => value.rfcVector === 1));
  vector.stages[0].modelName = "s--absent";
  const host = await loadHost(framework(), { waitMs: 500 });
  await assert.rejects(host.observe(vector), error =>
    /Timed out: the Host applying stage 1's listing of s--absent; the Host shows no tool by that name/.test(error.message)
    && /Host diagnostic tail:/.test(error.message)
    && /Provider event tail: \[.*"event":"listed"/.test(error.message));
});
