// Portable assertions: the adapter supplies observations, never expected outcomes.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const { values } = parseArgs({
  options: {
    host: { type: "string" },
    adapter: { type: "string" },
    vectors: { type: "string" },
    only: { type: "string" },
    report: { type: "string" },
  },
  allowPositionals: false,
});
if (!values.host)
  throw Error(
    "Usage: bun run conformance/check-tool-lifecycle.mjs --host /path/to/agent-framework [--adapter ./adapter.mjs] [--only 1,20] [--report /tmp/result.json]",
  );
const data = JSON.parse(
  await readFile(
    values.vectors ?? new URL("./tool-lifecycle-vectors.json", import.meta.url),
    "utf8",
  ),
);
assert.equal(data.profile, "rfc-007-revision-3");
assert.deepEqual(
  data.vectors.map((v) => v.rfcVector),
  Array.from({ length: 54 }, (_, i) => i + 1),
  "exactly the 54 RFC cases",
);
const module = await import(
  values.adapter
    ? pathToFileURL(resolve(values.adapter)).href
    : new URL("./agent-framework-tool-lifecycle.mjs", import.meta.url).href
);
const host = await module.loadHost(values.host);
const report = { host: host.info, selection: values.only ?? "all", cases: [] };
console.log("Host evidence: " + JSON.stringify(host.info));
const has = (o, k) => Object.hasOwn(o, k);
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const sameSet = (a, b, label) =>
  assert.deepEqual([...new Set(a)].sort(), [...new Set(b)].sort(), label);
function verify(vector, result) {
  const observedGroups = {};
  // Every executed call has a provider witness. Even suppressed calls must run.
  const witnessed = [
    ...result.hostCalls,
    ...Object.values(result.peers).flat(),
  ];
  for (const action of vector.actions.filter((a) => a.op === "call"))
    for (const call of action.calls) {
      assert.equal(
        witnessed.filter((x) => x.event === "call" && x.key === call.key)
          .length,
        1,
        "one execution witness: " + call.key,
      );
      // A disconnect or interruption can preclude a result; ordinary calls must return.
      if (!call.hold)
        assert.equal(
          witnessed.filter((x) => x.event === "result" && x.key === call.key)
            .length,
          1,
          "result witness: " + call.key,
        );
    }
  for (const [observer, expected] of Object.entries(vector.expect)) {
    const log = result.peers[observer];
    assert.ok(log?.length, "observer log");
    assert.equal(
      log.at(-1).event,
      "barrier",
      "same-connection settling barrier",
    );
    const events = log
      .filter((x) => x.event === "lifecycle")
      .map((x) => x.params);
    const groups = new Map();
    for (const event of events) {
      for (const key of ["toolCallId", "inferenceId", "conversationId", "tool"])
        assert.equal(typeof event[key], "string", key);
      assert.ok(
        event.toolCallId.length > 0 && event.inferenceId.length > 0,
        "nonempty identity",
      );
      assert.ok(Array.isArray(event.class), "class array");
      for (const field of ["result", "output", "content"])
        assert.ok(!has(event, field), "no outcome field " + field);
      assert.ok(
        ["pending", "started", "completed", "failed", "aborted"].includes(
          event.phase,
        ),
        "phase vocabulary",
      );
      if (event.phase !== "started")
        for (const field of ["input", "inputAltered", "inputWithheld"])
          assert.ok(!has(event, field), "started-only " + field);
      if (event.phase !== "completed")
        assert.ok(!has(event, "isError"), "completed-only isError");
      if (["pending", "started"].includes(event.phase))
        assert.ok(!has(event, "durationMs"), "terminal-only duration");
      if (has(event, "durationMs"))
        assert.ok(
          Number.isInteger(event.durationMs) && event.durationMs >= 0,
          "duration",
        );
      if (!groups.has(event.toolCallId)) groups.set(event.toolCallId, []);
      groups.get(event.toolCallId).push(event);
    }
    assert.equal(
      groups.size,
      expected.length,
      "reported call count for " + observer,
    );
    const remaining = [...groups.entries()];
    observedGroups[observer] = {};
    for (const expectation of expected) {
      const index = remaining.findIndex(
        ([, events]) =>
          events[0].tool === expectation.tool &&
          events[0].conversationId === expectation.conversationId,
      );
      assert.notEqual(index, -1, "reported " + expectation.tool);
      const [id, phases] = remaining.splice(index, 1)[0];
      observedGroups[observer][expectation.key] = { id, phases };
      assert.deepEqual(
        phases.map((p) => p.phase),
        expectation.phases,
        "phase sequence: " + expectation.key,
      );
      for (const p of phases) {
        assert.equal(p.tool, expectation.tool);
        assert.equal(p.conversationId, expectation.conversationId);
        assert.equal(p.inferenceId, phases[0].inferenceId, "inference pairing");
        sameSet(p.class, expectation.class, "class membership");
        if (expectation.host) {
          assert.ok(!has(p, "serverId"));
          assert.ok(!has(p, "serverTool"));
        } else {
          assert.equal(
            p.serverId,
            expectation.tool.split("--").slice(0, -1).join("--"),
          );
          assert.equal(p.serverTool, expectation.tool.split("--").at(-1));
        }
        if (p.phase === "completed") {
          if (expectation.isError)
            assert.equal(
              p.isError,
              true,
              "error RESULT completes with isError",
            );
          else assert.ok(!p.isError, "successful completion");
        }
      }
      const start = phases.find((p) => p.phase === "started");
      if (start) {
        if (expectation.bounded) {
          assert.ok(object(start.input), "bounded JSON object");
          assert.ok(
            Buffer.byteLength(JSON.stringify(start.input)) <=
              host.info.inputBound,
            "bounded serialized bytes",
          );
        } else if (has(expectation, "input"))
          assert.deepEqual(start.input, expectation.input, "selected input");
        else assert.ok(!has(start, "input"), "input absent");
        for (const field of ["inputAltered", "inputWithheld"]) {
          if (expectation[field]) assert.equal(start[field], true, field);
          else assert.ok(!has(start, field), field + " absent");
        }
      }
      if (expectation.durationExcludesApproval) {
        const approval = vector.actions.find(
          (a) => a.op === "approve" && a.key === expectation.key,
        );
        assert.ok(
          phases.at(-1).durationMs < approval.waitMs,
          "duration excludes approval wait",
        );
      }
    }
    if (vector.forbiddenText)
      assert.ok(
        !JSON.stringify(events).includes(vector.forbiddenText),
        "outcome text absent",
      );
  }
  for (const action of vector.actions.filter((a) => a.op === "observe")) {
    const response = result.responses.find(
      (r) => r.action === vector.actions.indexOf(action),
    )?.response;
    assert.ok(response, "observe response");
    if (action.expectCode) {
      assert.equal(response.error?.code, action.expectCode, "observe error");
      if (action.expectLimit)
        assert.equal(
          typeof response.error?.data?.limit,
          "string",
          "limit label",
        );
    } else {
      assert.ok(!response.error, "observe success");
      assert.deepEqual(response.result, {});
    }
  }
  const initial = result.grants.find(
    (g) => g.server === "obs" && g.stage === "initial",
  ).paths;
  if (vector.grantUnchanged)
    sameSet(
      result.grants.find((g) => g.server === "obs" && g.stage === "final")
        .paths,
      initial,
      "pause preserves grant",
    );
  if (vector.grant) {
    for (const path of vector.grant.include)
      assert.ok(initial.includes(path), "granted " + path);
    for (const path of vector.grant.exclude)
      assert.ok(!initial.includes(path), "denied " + path);
  }
  if (vector.disabledFeature) {
    const policy = result.peers.obs.find((x) => x.event === "policy").params;
    const disabled = policy.disabled ?? [];
    assert.ok(
      disabled.includes(vector.disabledFeature.name) &&
        result.diagnostics.some((line) =>
          line.includes(
            "obs/" +
              vector.disabledFeature.name +
              " disabled: " +
              vector.disabledFeature.reason,
          ),
        ),
      "actual invalid_uses policy",
    );
  }
  if (vector.distinctIds)
    assert.equal(
      new Set(vector.distinctIds.map((key) => observedGroups.obs[key].id)).size,
      vector.distinctIds.length,
      "distinct host ids",
    );
  if (vector.parallel) {
    const phases = result.peers.obs
      .filter((x) => x.event === "lifecycle")
      .map((x) => x.params.phase);
    assert.deepEqual(
      phases.slice(0, vector.parallel.length),
      vector.parallel.map(() => "started"),
      "both calls opened before either terminal",
    );
  }
  if (vector.providerCalls)
    for (const call of vector.providerCalls)
      assert.ok(
        result.peers[call.server].some(
          (x) => x.event === "call" && x.params.name === call.tool,
        ),
        "own tools/call received",
      );
  return {
    diagnostic: vector.diagnostic
      ? {
          hint: vector.diagnostic,
          observed: result.diagnostics.some((line) =>
            line.includes(vector.diagnostic),
          ),
        }
      : undefined,
    recommendedReuse: vector.recommendedReuse
      ? observedGroups.obs[vector.recommendedReuse.key].id ===
        vector.recommendedReuse.modelId
      : undefined,
  };
}
for (const vector of data.vectors) {
  if (
    values.only &&
    !values.only.split(",").map(Number).includes(vector.rfcVector)
  )
    continue;
  if (vector.requires && !host.info.capabilities[vector.requires]) {
    const reason = "Host capability absent: " + vector.requires;
    report.cases.push({ id: vector.id, status: "not-applicable", reason });
    console.log("NOT APPLICABLE " + vector.id + " — " + reason);
    continue;
  }
  try {
    const result = await host.observe(vector);
    const checks = verify(vector, result);
    report.cases.push({
      id: vector.id,
      status: "pass",
      ...checks,
      evidence: result,
    });
    console.log(
      "PASS " +
        vector.id +
        " " +
        vector.title +
        (checks.diagnostic
          ? " (diagnostic " + checks.diagnostic.observed + ")"
          : ""),
    );
  } catch (error) {
    report.cases.push({ id: vector.id, status: "fail", error: error.stack });
    console.error("FAIL " + vector.id + "\n" + error.stack);
  }
}
report.summary = Object.fromEntries(
  ["pass", "fail", "not-applicable"].map((s) => [
    s,
    report.cases.filter((c) => c.status === s).length,
  ]),
);
if (values.report)
  await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
console.log(
  "RFC-007 behavioral result: " +
    JSON.stringify(report.summary) +
    (values.only ? " (selected cases)" : ""),
);
if (report.summary.fail) process.exitCode = 1;
