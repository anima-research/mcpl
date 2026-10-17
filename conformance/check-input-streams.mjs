// Run with bun run conformance/check-input-streams.mjs (or node).
// Inputs and expected outcomes are checked-in data, independent of the model.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { InputStreamHost, advertised } from "./input-stream-reference.mjs";

// A failure names what differed, not only where. Unlike JSON, inspect shows
// undefined and NaN, so unequal values print apart.
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
assertKeys(vectors, CORPUS_KEYS, "the corpus", ["profile", "defaults", "advertisements", "traces"]);
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
  ["maxChars", 0], ["maxUpdateHz", 0], ["maxUpdateHz", Infinity], ["mode", "bogus"], ["finalAccepted", "yes"],
  ...["now", "transportEpoch", "serverPrincipal", "ready", "advertisement", "grants", "channels",
    "maxChars", "maxUpdateHz", "maxDurationMs", "maxStreams", "mode", "finalAccepted"].map(key => [key, null]),
];
for (const [key, value] of invalidSettings) {
  assert.throws(() => new InputStreamHost({ [key]: value }), new RegExp("Invalid fixture configuration: " + key + "$"),
    "invalid setting: " + key + " " + shown(value));
  apiChecks++;
  assertions++;
}
// A setting the model doesn't know, or a configuration that isn't an object, is
// refused rather than ignored.
for (const [config, reason] of [[{ maxChar: 100 }, "unknown setting maxChar"], [null, "not an object"]]) {
  assert.throws(() => new InputStreamHost(config),
    new RegExp("Invalid fixture configuration: " + reason + "$"), "a configuration " + shown(config) + " is refused");
  apiChecks++;
  assertions++;
}
// A control step's changes are held to the same rules, and a member a control
// step can't change is refused rather than ignored.
const invalidControls = [["now", -1], ["ready", "no"], ["grants", "channels.incoming"],
  ["channels", { "voice:lobby": { identity: "channel-lobby", generation: 1, direction: "inbound", permitted: true } }],
  ["finalAccepted", "yes"], ["serverPrincipal", ""], ["transportEpoch", ""], ["mode", "bogus"]];
for (const [key, value] of [...invalidControls, ...invalidControls.map(([key]) => [key, null])]) {
  assert.throws(() => new InputStreamHost().control({ [key]: value }),
    new RegExp("Invalid fixture control: " + key + "$"), "a control step's " + key + " " + shown(value) + " is refused");
  apiChecks++;
  assertions++;
}
for (const [change, reason] of [[{ maxStreams: 1 }, "maxStreams is set only when the Host is built"],
  [{ maxStream: 1 }, "unknown member maxStream"], [[], "not an object"]]) {
  assert.throws(() => new InputStreamHost().control(change),
    new RegExp("Invalid fixture control: " + reason + "$"), "a control step " + shown(change) + " is refused");
  apiChecks++;
  assertions++;
}
// The clock never moves back, and a reconnect never reuses an epoch the Host has used.
assert.throws(() => new InputStreamHost().control({ now: 999 }), /Fixture clock must be monotonic$/, "a backward clock is refused");
apiChecks++;
assertions++;
const reconnected = new InputStreamHost();
reconnected.control({ transportEpoch: "epoch-2" });
assert.throws(() => reconnected.control({ transportEpoch: "epoch-1" }), /Reconnect needs a fresh epoch$/, "an earlier epoch is refused");
apiChecks++;
assertions++;
const openParams = {
  streamId: "s", channelId: "voice:lobby", messageId: "m", sender: { id: "alice" },
  contentType: "text/plain", startedAt: 900, expiresAt: 5000,
};
// A control step reads its own members only, as the constructor reads its configuration.
const inherited = new InputStreamHost();
inherited.control(Object.create({ ready: false }));
assert.equal(inherited.request("open", openParams).result?.accepted, true, "an inherited control member is not applied");
apiChecks++;
assertions++;
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
// A refused control step changes nothing, though it carries every member: the
// clock, the lease and the settings are as they were, as an update, a new lease
// and a completion after it show.
const refused = new InputStreamHost();
refused.request("open", openParams);
const everything = { now: 6000, ready: false, grants: ["channels.incoming"], channels: {}, finalAccepted: false, mode: "final-only", serverPrincipal: "server-2" };
assert.throws(() => refused.control(everything), /A principal change requires a fresh connection$/);
assertions++;
assert.throws(() => refused.control({ ...everything, transportEpoch: "epoch-1" }), /Reconnect needs a fresh epoch$/);
assertions++;
assert.deepEqual(refused.request("update", { ...leaseParams, revision: 1, text: "red" }),
  { result: { accepted: true, status: "updated", revision: 1 } }, "the lease takes an update after the refused steps");
assertions++;
assert.deepEqual(refused.request("open", { ...openParams, streamId: "s2", messageId: "m2" }), { result: {
  accepted: true, streamId: "s2", transportEpoch: "epoch-1", leaseId: "lease-2",
  expiresAt: 5000, maxUpdateHz: 10, maxChars: 100, mode: "volatile",
} }, "a lease opened after the refused steps gets the settings as they were");
assertions++;
assert.deepEqual(refused.request("complete", { ...leaseParams, revision: 1, text: "red" }), { result: {
  accepted: true, status: "completed", messageId: "m", revision: 1,
  contentDigest: "sha256:b1f51a511f1da0cd348b8f8598db32e61cb963e5fc69e2b41485bf99590ed75a",
} }, "the final is accepted after the refused steps");
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
// The defaults build a Host on their own, so a fault in them is named as theirs.
within("the corpus's defaults", () => {
  assert.ok(plainObject(vectors.defaults), "they are an object");
  new InputStreamHost(vectors.defaults);
});
const names = new Set();
for (const [index, vector] of vectors.advertisements.entries()) {
  assertKeys(vector, VECTOR_KEYS, "advertisement vector " + (vector?.name ?? index + 1), VECTOR_KEYS);
  assert.ok(!names.has(vector.name), "Duplicate vector name: " + vector.name);
  names.add(vector.name);
  assertEqual(advertised(vector.input), vector.expect, vector.name);
  assertions++;
}
for (const [index, trace] of vectors.traces.entries()) {
  assertKeys(trace, TRACE_KEYS, "trace " + (trace?.name ?? index + 1), ["name", "steps"]);
  assert.ok(!names.has(trace.name), "Duplicate vector name: " + trace.name);
  names.add(trace.name);
  const host = within(trace.name, () => {
    if (Object.hasOwn(trace, "config")) assert.ok(plainObject(trace.config), "its config is an object");
    assert.ok(Array.isArray(trace.steps) && trace.steps.some(step => plainObject(step) && Object.hasOwn(step, "method")),
      "it sends at least one request");
    const last = trace.steps.at(-1);
    assert.ok(plainObject(last) && (Object.hasOwn(last, "method") || Object.hasOwn(last, "expectState")),
      "its last step is checked, by a receipt or an expected state");
    return new InputStreamHost({ ...vectors.defaults, ...trace.config });
  });
  for (const [index, step] of trace.steps.entries()) within(trace.name + " step " + (index + 1), () => {
    assertKeys(step, STEP_KEYS, "the step");
    assert.ok(Object.keys(step).length > 0, "the step isn't empty");
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
