// Run with bun run conformance/check-input-streams.mjs (or node).
// Inputs and expected outcomes are checked-in data, independent of the model.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { InputStreamHost, advertised } from "./input-stream-reference.mjs";

// A failure names what differed, not only where.
const shown = value => {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.length > 2000 ? text.slice(0, 2000) + "..." : text;
};
function assertEqual(actual, expected, label) {
  assert.deepEqual(actual, expected, label + ": expected " + shown(expected) + ", got " + shown(actual));
}

export function assertSubset(actual, expected, path = "state") {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected) && Object.keys(expected).length > 0) {
    assert.ok(actual !== null && typeof actual === "object", path + ": expected an object, got " + shown(actual));
    for (const [key, value] of Object.entries(expected)) {
      assert.ok(Object.hasOwn(actual, key), path + "." + key + " exists");
      assertSubset(actual[key], value, path + "." + key);
    }
  } else assertEqual(actual, expected, path);
}

// The corpus's shape, so a misspelt key fails rather than skipping its check.
const TRACE_KEYS = ["name", "description", "config", "steps"];
const STEP_KEYS = ["control", "prepare", "method", "params", "expect", "expectState"];
const CONTROL_KEYS = ["now", "ready", "grants", "channels", "finalAccepted", "serverPrincipal", "transportEpoch", "mode"];
const plainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
function assertKeys(value, keys, label) {
  assert.ok(plainObject(value), label + " is an object");
  for (const key of Object.keys(value)) assert.ok(keys.includes(key), label + ": unknown member " + key);
}

const path = process.argv[2] ?? fileURLToPath(new URL("./input-stream-vectors.json", import.meta.url));
const vectors = JSON.parse(await readFile(path, "utf8"));
let assertions = 0;
let apiChecks = 0;
assert.equal(vectors.profile, "rfc-009-text-input");
assertions++;
assert.ok(Array.isArray(vectors.advertisements) && vectors.advertisements.length > 0, "the corpus has advertisement vectors");
assert.ok(Array.isArray(vectors.traces) && vectors.traces.length > 0, "the corpus has traces");
// Parsed JSON has no inherited members. This separate API-level check pins the
// helper's explicit-own-member rule when called directly from JavaScript.
assert.deepEqual(advertised({ channels: Object.assign(
  Object.create({ inputStreaming: true }), { incoming: true },
) }), { incoming: true, streaming: false }, "inherited member is not advertisement");
apiChecks++;
assertions++;
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
// Every setting is checked, so a value the model can't use is refused here rather
// than surfacing as a TypeError from a later request, and a setting given as null
// is refused rather than replaced by its default.
const invalidSettings = [
  ["maxStreams", 0], ["maxStreams", 1.5], ["maxStreams", NaN], ["maxStreams", "16"],
  ["now", -1], ["now", 1.5], ["now", NaN], ["now", 253402300800000],
  ["grants", "channels.incoming"],
  ["channels", { "voice:lobby": { identity: "channel-lobby", generation: 1, direction: "inbound", permitted: true } }],
  ...["now", "transportEpoch", "serverPrincipal", "ready", "advertisement", "grants", "channels",
    "maxChars", "maxUpdateHz", "maxDurationMs", "maxStreams", "mode", "finalAccepted"].map(key => [key, null]),
];
for (const [key, value] of invalidSettings) {
  assert.throws(() => new InputStreamHost({ [key]: value }), /Invalid fixture configuration/,
    "invalid setting: " + key + " " + (plainObject(value) ? shown(value) : String(value)));
  apiChecks++;
  assertions++;
}
// A control step's changes are held to the same rules.
assert.throws(() => new InputStreamHost().control({ grants: null }),
  /Invalid fixture control: grants/, "a control step's null grant is refused");
apiChecks++;
assertions++;
const openParams = {
  streamId: "s", channelId: "voice:lobby", messageId: "m", sender: { id: "alice" },
  contentType: "text/plain", startedAt: 900, expiresAt: 5000,
};
// A lease keeps the mode its receipt announced, so broadening the Host's mode
// afterwards doesn't make a volatile lease's snapshot one it may prepare.
const broadened = new InputStreamHost();
assert.equal(broadened.request("open", openParams).result.mode, "volatile");
assert.deepEqual(broadened.request("update", {
  streamId: "s", transportEpoch: "epoch-1", leaseId: "lease-1",
  channelId: "voice:lobby", senderId: "alice", contentType: "text/plain",
  startedAt: 900, expiresAt: 5000, revision: 1, text: "red",
}), { result: { accepted: true, status: "updated", revision: 1 } });
broadened.control({ mode: "prepare" });
assert.throws(() => broadened.prepare("s"), /no permitted snapshot/,
  "a lease opened as volatile isn't prepared after the mode broadens");
apiChecks++;
assertions += 3;
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
  assert.ok(!names.has(vector.name), "Duplicate vector name: " + vector.name);
  names.add(vector.name);
  assertEqual(advertised(vector.input), vector.expect, vector.name);
  assertions++;
}
const defaultKeys = Object.keys(vectors.defaults);
for (const trace of vectors.traces) {
  assertKeys(trace, TRACE_KEYS, "trace " + trace.name);
  assert.ok(!names.has(trace.name), "Duplicate vector name: " + trace.name);
  names.add(trace.name);
  if (Object.hasOwn(trace, "config")) assertKeys(trace.config, defaultKeys, trace.name + " config");
  assert.ok(Array.isArray(trace.steps) && trace.steps.some(step => Object.hasOwn(step, "method")),
    trace.name + " sends at least one request");
  const host = new InputStreamHost({ ...vectors.defaults, ...trace.config });
  for (const [index, step] of trace.steps.entries()) {
    const label = trace.name + " step " + (index + 1);
    try {
      assertKeys(step, STEP_KEYS, label);
      if (Object.hasOwn(step, "control")) {
        assertKeys(step.control, CONTROL_KEYS, label + " control");
        host.control(step.control);
      }
      if (Object.hasOwn(step, "prepare")) host.prepare(step.prepare);
      if (Object.hasOwn(step, "method")) {
        assert.ok(typeof step.method === "string" && step.method.startsWith("channels/input/"), label + " names an input method");
        assert.ok(Object.hasOwn(step, "params"), label + " has params");
        assert.ok(Object.hasOwn(step, "expect"), label + " has expected receipt");
        assertEqual(host.request(step.method.slice("channels/input/".length), step.params), step.expect, "receipt");
        assertions++;
      } else {
        assert.ok(!Object.hasOwn(step, "params") && !Object.hasOwn(step, "expect"), label + ": params or expect without a method");
      }
      if (Object.hasOwn(step, "expectState")) {
        assert.ok(plainObject(step.expectState), label + " expectState is an object");
        assertSubset(host.snapshot(), step.expectState, "state");
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
