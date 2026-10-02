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
// Parsed JSON has no inherited members. This separate API-level check pins the
// helper's explicit-own-member rule when called directly from JavaScript.
assert.deepEqual(advertised({ channels: Object.assign(
  Object.create({ inputStreaming: true }), { incoming: true },
) }), { incoming: true, streaming: false }, "inherited member is not advertisement");
let assertions = 1;
let apiChecks = 1;
// Host fixture configuration is not producer wire input. Reject invalid durations
// before an open could return an expired, fractional, or non-finite deadline.
const invalidDurations = [
  ["zero", 0], ["negative", -1], ["fractional", 0.5], ["NaN", NaN],
  ["positive infinity", Infinity], ["negative infinity", -Infinity],
  ["unsafe integer", Number.MAX_SAFE_INTEGER + 1], ["string", "1000"],
  ["true", true], ["false", false], ["object", {}], ["array", []],
];
for (const [label, maxDurationMs] of invalidDurations) {
  assert.throws(() => new InputStreamHost({ maxDurationMs }),
    /Invalid fixture configuration/, "invalid duration: " + label);
  apiChecks++;
  assertions++;
}
const openParams = {
  streamId: "s", channelId: "voice:lobby", messageId: "m", sender: { id: "alice" },
  contentType: "text/plain", startedAt: 900, expiresAt: 5000,
};
const shortLease = new InputStreamHost({ maxDurationMs: 1 });
assert.deepEqual(shortLease.request("open", openParams), { result: {
  accepted: true, streamId: "s", transportEpoch: "epoch-1", leaseId: "lease-1",
  expiresAt: 1001, maxUpdateHz: 10, maxChars: 100, mode: "volatile",
} }, "minimum integer duration opens a future lease");
assert.deepEqual(shortLease.request("complete", {
  streamId: "s", transportEpoch: "epoch-1", leaseId: "lease-1",
  channelId: "voice:lobby", senderId: "alice", contentType: "text/plain",
  startedAt: 900, expiresAt: 1001, revision: 1, text: "",
}), { result: {
  accepted: true, status: "completed", messageId: "m", revision: 1,
  contentDigest: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
} }, "minimum integer duration permits completion before expiry");
apiChecks++;
assertions += 2;
assert.equal(new InputStreamHost({ maxDurationMs: Number.MAX_SAFE_INTEGER })
  .request("open", openParams).result.expiresAt, 5000,
  "maximum safe integer duration remains capped by the requested deadline");
apiChecks++;
assertions++;
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
  + " advertisement vectors, " + vectors.traces.length + " traces, " + apiChecks + " API checks, " + assertions + " assertions)");
