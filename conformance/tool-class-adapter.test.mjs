// Real-Host evidence: one stage's warning cannot become the next stage's warning.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadHost } from "./agent-framework-tool-classes.mjs";

test("diagnostics are local to the stage that triggered them", async () => {
  assert.ok(process.env.MCPL_FRAMEWORK, "Set MCPL_FRAMEWORK to a clean Agent Framework checkout");
  const vectors = JSON.parse(await readFile(new URL("./tool-class-vectors.json", import.meta.url), "utf8"));
  const vector = structuredClone(vectors.vectors.find(value => value.rfcVector === 3));
  const second = structuredClone(vector.stages[0]);
  second.tool._meta = { "mcpl/class": ["shell"] };
  second.expect = { classes: ["shell"], source: "server", input: "sent" };
  delete second.diagnosticHint;
  vector.stages.push(second);
  const host = await loadHost(process.env.MCPL_FRAMEWORK);
  const observed = await host.observe(vector);
  assert.equal(observed.length, 2);
  assert.ok(observed[0].diagnostics.some(line => line.includes("quantum")), "the first stage's unknown class warning exists");
  assert.deepEqual(observed[1].descriptor.class, ["shell"], "the second listing was actually ingested");
  assert.equal(observed[1].diagnostics.some(line => line.includes("quantum")), false, "the first warning must not be attributed to the second stage");
});
