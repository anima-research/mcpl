// Run with bun run conformance/check-input-streams.mjs (or node).
// Inputs and expected outcomes are checked-in data, independent of the model.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { InputStreamHost, advertised } from "./input-stream-reference.mjs";

export function assertSubset(actual, expected, path = "state") {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected) && Object.keys(expected).length > 0) {
    assert.ok(actual !== null && typeof actual === "object", path);
    for (const [key, value] of Object.entries(expected)) {
      assert.ok(Object.hasOwn(actual, key), path + "." + key + " exists");
      assertSubset(actual[key], value, path + "." + key);
    }
  } else assert.deepEqual(actual, expected, path);
}

const path = process.argv[2] ?? fileURLToPath(new URL("./input-stream-vectors.json", import.meta.url));
const vectors = JSON.parse(await readFile(path, "utf8"));
assert.equal(vectors.profile, "rfc-009-text-input");
let assertions = 0;
const names = new Set();
for (const vector of vectors.advertisements) {
  assert.ok(!names.has(vector.name), "Duplicate vector name");
  names.add(vector.name);
  assert.deepEqual(advertised(vector.input), vector.expect, vector.name);
  assertions++;
}
for (const trace of vectors.traces) {
  assert.ok(!names.has(trace.name), "Duplicate vector name");
  names.add(trace.name);
  assert.ok(trace.steps.length > 0, trace.name);
  const host = new InputStreamHost({ ...vectors.defaults, ...trace.config });
  for (const [index, step] of trace.steps.entries()) {
    const label = trace.name + " step " + (index + 1);
    try {
      if (step.control) host.control(step.control);
      if (step.prepare) host.prepare(step.prepare);
      if (step.method) {
        assert.ok(step.method.startsWith("channels/input/"), label);
        assert.ok(Object.hasOwn(step, "expect"), label + " has expected receipt");
        assert.deepEqual(host.request(step.method.slice("channels/input/".length), step.params), step.expect, label);
        assertions++;
      }
      if (step.expectState) {
        assertSubset(host.snapshot(), step.expectState, label);
        assertions++;
      }
    } catch (error) {
      error.message = label + ": " + error.message;
      throw error;
    }
  }
}
console.log("INPUT STREAM CONFORMANCE OK (" + vectors.advertisements.length
  + " advertisement vectors, " + vectors.traces.length + " traces, " + assertions + " assertions)");
