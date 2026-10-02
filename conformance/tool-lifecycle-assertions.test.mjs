// Synthetic observation records test the checker, not a Host implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verify } from "./tool-lifecycle-assertions.mjs";
const vectors = JSON.parse(
  await readFile(
    new URL("./tool-lifecycle-vectors.json", import.meta.url),
    "utf8",
  ),
).vectors;
function observation(number) {
  const vector = vectors[number - 1];
  const expected = vector.expect.obs[0];
  const phases = expected.phases.map((phase) => ({
    toolCallId: "fixture-call",
    inferenceId: "fixture-inference",
    conversationId: "conv_1",
    tool: "x--run",
    class: ["shell"],
    serverId: "x",
    serverTool: "run",
    phase,
    ...(phase === "started" ? { input: { a: 1 } } : {}),
    ...(phase === "completed" ? { isError: false, durationMs: 2500 } : {}),
  }));
  return {
    peers: {
      obs: [
        ...phases.map((params) => ({ event: "lifecycle", params })),
        { event: "barrier" },
      ],
    },
    hostCalls:
      number === 23
        ? []
        : [
            { event: "call", key: "a" },
            { event: "result", key: "a" },
          ],
    responses: [{ action: 0, response: { result: {} } }],
    grants: [
      {
        server: "obs",
        stage: "initial",
        paths: ["toolLifecycle.observe", "toolLifecycle.inputs"],
      },
    ],
    diagnostics: [],
    timings: {
      a: {
        pendingAtMs: 1000,
        startedAtMs: 2000,
        terminalAtMs: 4500,
        resolutionMs: 0,
      },
    },
  };
}
test("approval refused: zero executions, pending then aborted", () => {
  verify(vectors[22], observation(23), {});
});
test("approval refusal rejects provider execution or result", () => {
  for (const event of ["call", "result"]) {
    const result = observation(23);
    result.hostCalls.push({ event, key: "a" });
    assert.throws(() => verify(vectors[22], result, {}), /witnesses/);
  }
});
test("execution may last longer than the approval wait", () => {
  verify(vectors[21], observation(22), {});
});
test("optional duration may be omitted without timing evidence", () => {
  const result = observation(22);
  delete result.peers.obs[2].params.durationMs;
  delete result.timings;
  const checked = verify(vectors[21], result, {});
  assert.deepEqual(checked.approvalDuration, [
    { observer: "obs", key: "a", emitted: false },
  ]);
});
test("duration including approval wait is rejected", () => {
  const result = observation(22);
  result.peers.obs[2].params.durationMs = 3500;
  assert.throws(
    () => verify(vectors[21], result, {}),
    /excluding approval wait/,
  );
});
test("missing or invalid timing evidence is rejected", () => {
  const missing = observation(22);
  delete missing.timings;
  assert.throws(() => verify(vectors[21], missing, {}), /timing observations/);
  for (const field of [
    "pendingAtMs",
    "startedAtMs",
    "terminalAtMs",
    "resolutionMs",
  ]) {
    const result = observation(22);
    result.timings.a[field] = NaN;
    assert.throws(() => verify(vectors[21], result, {}), /finite timing/);
  }
});
test("optional lifecycle booleans reject null, numbers, and strings", () => {
  for (const field of ["isError", "inputAltered", "inputWithheld"])
    for (const value of [null, 0, ""]) {
      const result = observation(22);
      result.peers.obs[field === "isError" ? 2 : 1].params[field] = value;
      assert.throws(
        () => verify(vectors[21], result, {}),
        new RegExp(field + " type"),
      );
    }
});
