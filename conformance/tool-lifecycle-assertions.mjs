// Portable observation checks, also exercised by checker self-tests.
import assert from "node:assert/strict";
const has = (o, k) => Object.hasOwn(o, k);
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const sameSet = (a, b, label) =>
  assert.deepEqual([...new Set(a)].sort(), [...new Set(b)].sort(), label);
export function verify(vector, result, hostInfo) {
  const observedGroups = {};
  const approvalDuration = [];
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
        call.expectExecution === false ? 0 : 1,
        "execution witnesses: " + call.key,
      );
      // A disconnect or interruption can preclude a result; ordinary calls must return.
      if (call.expectExecution === false || !call.hold)
        assert.equal(
          witnessed.filter((x) => x.event === "result" && x.key === call.key)
            .length,
          call.expectExecution === false ? 0 : 1,
          "result witnesses: " + call.key,
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
      for (const field of ["isError", "inputAltered", "inputWithheld"]) {
        if (has(event, field))
          assert.equal(typeof event[field], "boolean", field + " type");
      }
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
              hostInfo.inputBound,
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
        const emitted = has(phases.at(-1), "durationMs");
        approvalDuration.push({ observer, key: expectation.key, emitted });
        if (emitted) {
          const approval = vector.actions.find(
            (a) => a.op === "approve" && a.key === expectation.key,
          );
          const timing = result.timings?.[expectation.key];
          assert.ok(
            timing,
            "approval timing observations on the Host execution clock",
          );
          for (const field of [
            "pendingAtMs",
            "startedAtMs",
            "terminalAtMs",
            "resolutionMs",
          ]) {
            assert.ok(
              Number.isFinite(timing[field]) && timing[field] >= 0,
              "finite timing " + field,
            );
          }
          assert.ok(
            timing.pendingAtMs <= timing.startedAtMs &&
              timing.startedAtMs <= timing.terminalAtMs,
            "monotonic timing",
          );
          assert.ok(
            timing.resolutionMs < approval.waitMs,
            "clock can distinguish the approval wait",
          );
          assert.ok(
            timing.startedAtMs - timing.pendingAtMs >=
              approval.waitMs - timing.resolutionMs,
            "approval wait occurred",
          );
          assert.ok(
            Math.abs(
              phases.at(-1).durationMs -
                (timing.terminalAtMs - timing.startedAtMs),
            ) <= timing.resolutionMs,
            "duration measures execution, excluding approval wait",
          );
        }
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
        result.disabledFeatures?.some(
          (feature) =>
            feature.server === "obs" &&
            feature.name === vector.disabledFeature.name &&
            feature.reason === vector.disabledFeature.reason,
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
    approvalDuration: approvalDuration.length ? approvalDuration : undefined,
    diagnostic: vector.diagnostic
      ? {
          code: vector.diagnostic,
          observed:
            result.diagnosticCodes?.includes(vector.diagnostic) ?? false,
        }
      : undefined,
    recommendedReuse: vector.recommendedReuse
      ? observedGroups.obs[vector.recommendedReuse.key].id ===
        vector.recommendedReuse.modelId
      : undefined,
  };
}
