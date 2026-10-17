// Run with bun run conformance/check-input-streams.mjs (or node).
// Inputs and expected outcomes are checked-in data, independent of the model.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { InputStreamHost, advertised } from "./input-stream-reference.mjs";

// A failure names what differed, not only where. Unlike JSON, inspect shows
// undefined, NaN and the whole of a long value, so unequal values print apart.
const shown = value => inspect(value, { depth: null, maxArrayLength: null, maxStringLength: null, breakLength: Infinity });
function assertEqual(actual, expected, label) {
  assert.deepEqual(actual, expected, label + ": expected " + shown(expected) + ", got " + shown(actual));
}
const plainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

export function assertSubset(actual, expected, path = "state") {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected) && Object.keys(expected).length > 0) {
    assert.ok(plainObject(actual), path + ": expected an object, got " + shown(actual));
    for (const [key, value] of Object.entries(expected)) {
      assert.ok(Object.hasOwn(actual, key), path + "." + key + " exists");
      assertSubset(actual[key], value, path + "." + key);
    }
  } else assertEqual(actual, expected, path);
}

// The corpus's shape, so a misspelt key fails rather than skipping its check.
// The model refuses a setting or control member it doesn't know.
const CORPUS_KEYS = ["profile", "description", "defaults", "advertisements", "traces"];
const VECTOR_KEYS = ["name", "input", "expect"];
const TRACE_KEYS = ["name", "description", "config", "steps"];
const STEP_KEYS = ["control", "prepare", "method", "params", "expect", "expectState"];
function assertKeys(value, keys, what, required = []) {
  assert.ok(plainObject(value), what + " is an object");
  for (const key of Object.keys(value)) assert.ok(keys.includes(key), what + " has unknown member " + key);
  for (const key of required) assert.ok(Object.hasOwn(value, key), what + " has " + key);
}
// A failure inside a trace or a step names it. A new error, since a thrown
// error's printed stack keeps the message it was made with.
function within(label, run) {
  try {
    return run();
  } catch (error) {
    throw new Error(label + ": " + error.message, { cause: error });
  }
}

const path = process.argv[2] ?? fileURLToPath(new URL("./input-stream-vectors.json", import.meta.url));
const vectors = JSON.parse(await readFile(path, "utf8"));
let assertions = 0;
let apiChecks = 0;
assertKeys(vectors, CORPUS_KEYS, "the corpus");
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
    /Invalid fixture configuration: maxDurationMs$/, "invalid duration: " + label);
  apiChecks++;
  assertions++;
}
// Every setting is checked, so a value the model can't use is refused here rather
// than surfacing as a TypeError from a later request, and a setting given as null
// is refused rather than replaced by its default.
const invalidSettings = [
  ["maxStreams", 0], ["maxStreams", 1.5], ["maxStreams", NaN], ["maxStreams", "16"],
  ["now", -1], ["now", 1.5], ["now", NaN], ["now", 253402300800000],
  ["transportEpoch", ""], ["serverPrincipal", ""], ["ready", "no"], ["advertisement", []],
  ["grants", "channels.incoming"],
  ["channels", { "voice:lobby": { identity: "channel-lobby", generation: 1, direction: "inbound", permitted: true } }],
  ["maxChars", 0], ["maxUpdateHz", 0], ["mode", "bogus"], ["finalAccepted", "yes"],
  ...["now", "transportEpoch", "serverPrincipal", "ready", "advertisement", "grants", "channels",
    "maxChars", "maxUpdateHz", "maxDurationMs", "maxStreams", "mode", "finalAccepted"].map(key => [key, null]),
];
for (const [key, value] of invalidSettings) {
  assert.throws(() => new InputStreamHost({ [key]: value }), new RegExp("Invalid fixture configuration: " + key + "$"),
    "invalid setting: " + key + " " + shown(value));
  apiChecks++;
  assertions++;
}
// A setting the model doesn't know is refused rather than ignored.
assert.throws(() => new InputStreamHost({ maxChar: 100 }),
  /Invalid fixture configuration: unknown setting maxChar$/, "an unknown setting is refused");
apiChecks++;
assertions++;
// A control step's changes are held to the same rules, and a member a control
// step can't change is refused rather than ignored.
for (const key of ["now", "ready", "grants", "channels", "finalAccepted", "serverPrincipal", "transportEpoch", "mode"]) {
  assert.throws(() => new InputStreamHost().control({ [key]: null }),
    new RegExp("Invalid fixture control: " + key + "$"), "a control step's null " + key + " is refused");
  apiChecks++;
  assertions++;
}
for (const [change, reason] of [[{ maxStreams: 1 }, "unknown member maxStreams"], [[], "not an object"]]) {
  assert.throws(() => new InputStreamHost().control(change),
    new RegExp("Invalid fixture control: " + reason + "$"), "a control step " + shown(change) + " is refused");
  apiChecks++;
  assertions++;
}
const openParams = {
  streamId: "s", channelId: "voice:lobby", messageId: "m", sender: { id: "alice" },
  contentType: "text/plain", startedAt: 900, expiresAt: 5000,
};
const leaseParams = {
  streamId: "s", transportEpoch: "epoch-1", leaseId: "lease-1",
  channelId: "voice:lobby", senderId: "alice", contentType: "text/plain",
  startedAt: 900, expiresAt: 5000,
};
// A lease keeps the mode its receipt announced, so broadening the Host's mode
// afterwards doesn't make a volatile lease's snapshot one it may prepare.
const broadened = new InputStreamHost();
assert.equal(broadened.request("open", openParams).result.mode, "volatile");
assertions++;
assert.deepEqual(broadened.request("update", { ...leaseParams, revision: 1, text: "red" }),
  { result: { accepted: true, status: "updated", revision: 1 } });
assertions++;
broadened.control({ mode: "prepare" });
assert.throws(() => broadened.prepare("s"), /no permitted snapshot/,
  "a lease opened as volatile isn't prepared after the mode broadens");
assertions++;
apiChecks++;
// A refused control step changes nothing: neither the clock nor the lease moves.
const refused = new InputStreamHost();
refused.request("open", openParams);
assert.throws(() => refused.control({ now: 6000, serverPrincipal: "server-2" }), /A principal change requires a fresh connection$/);
assertions++;
assert.throws(() => refused.control({ mode: "final-only", transportEpoch: "epoch-1" }), /Reconnect needs a fresh epoch$/);
assertions++;
assert.deepEqual(refused.request("update", { ...leaseParams, revision: 1, text: "red" }),
  { result: { accepted: true, status: "updated", revision: 1 } }, "the lease takes an update after the refused steps");
assertions++;
apiChecks++;
const shortLease = new InputStreamHost({ maxDurationMs: 1 });
assert.deepEqual(shortLease.request("open", openParams), { result: {
  accepted: true, streamId: "s", transportEpoch: "epoch-1", leaseId: "lease-1",
  expiresAt: 1001, maxUpdateHz: 10, maxChars: 100, mode: "volatile",
} }, "minimum integer duration opens a future lease");
assertions++;
assert.deepEqual(shortLease.request("complete", {
  streamId: "s", transportEpoch: "epoch-1", leaseId: "lease-1",
  channelId: "voice:lobby", senderId: "alice", contentType: "text/plain",
  startedAt: 900, expiresAt: 1001, revision: 1, text: "",
}), { result: {
  accepted: true, status: "completed", messageId: "m", revision: 1,
  contentDigest: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
} }, "minimum integer duration permits completion before expiry");
assertions++;
apiChecks++;
assert.equal(new InputStreamHost({ maxDurationMs: Number.MAX_SAFE_INTEGER })
  .request("open", openParams).result.expiresAt, 5000,
  "maximum safe integer duration remains capped by the requested deadline");
apiChecks++;
assertions++;
const names = new Set();
for (const vector of vectors.advertisements) {
  assertKeys(vector, VECTOR_KEYS, "advertisement vector " + vector.name, VECTOR_KEYS);
  assert.ok(!names.has(vector.name), "Duplicate vector name: " + vector.name);
  names.add(vector.name);
  assertEqual(advertised(vector.input), vector.expect, vector.name);
  assertions++;
}
for (const trace of vectors.traces) {
  assertKeys(trace, TRACE_KEYS, "trace " + trace.name);
  assert.ok(!names.has(trace.name), "Duplicate vector name: " + trace.name);
  names.add(trace.name);
  const host = within(trace.name, () => {
    if (Object.hasOwn(trace, "config")) assert.ok(plainObject(trace.config), "its config is an object");
    assert.ok(Array.isArray(trace.steps) && trace.steps.some(step => plainObject(step) && Object.hasOwn(step, "method")),
      "it sends at least one request");
    return new InputStreamHost({ ...vectors.defaults, ...trace.config });
  });
  for (const [index, step] of trace.steps.entries()) within(trace.name + " step " + (index + 1), () => {
    assertKeys(step, STEP_KEYS, "the step");
    if (Object.hasOwn(step, "control")) host.control(step.control);
    if (Object.hasOwn(step, "prepare")) host.prepare(step.prepare);
    if (Object.hasOwn(step, "method")) {
      assert.ok(typeof step.method === "string" && step.method.startsWith("channels/input/"), "the step names an input method");
      assert.ok(Object.hasOwn(step, "params"), "the step has params");
      assert.ok(Object.hasOwn(step, "expect"), "the step has an expected receipt");
      assertEqual(host.request(step.method.slice("channels/input/".length), step.params), step.expect, "receipt");
      assertions++;
    } else {
      assert.ok(!Object.hasOwn(step, "params") && !Object.hasOwn(step, "expect"), "params or expect without a method");
    }
    if (Object.hasOwn(step, "expectState")) {
      assert.ok(plainObject(step.expectState), "expectState is an object");
      assertSubset(host.snapshot(), step.expectState, "state");
      assertions++;
    }
  });
}
console.log("INPUT STREAM CONFORMANCE OK (" + vectors.advertisements.length
  + " advertisement vectors, " + vectors.traces.length + " traces, " + apiChecks + " API checks, " + assertions + " assertions)");
