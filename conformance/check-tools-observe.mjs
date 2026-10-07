import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { schemaValid, parseRequest } from "./tools-observe-parser.mjs";
const { values } = parseArgs({
  options: { host: { type: "string" }, report: { type: "string" } },
  allowPositionals: false,
});
const cases = JSON.parse(
  await readFile(
    new URL("./tools-observe-parser-vectors.json", import.meta.url),
    "utf8",
  ),
).cases;
const vectors = JSON.parse(
  await readFile(
    new URL("./tool-lifecycle-vectors.json", import.meta.url),
    "utf8",
  ),
).vectors;
const report = {
  schema: "RFC-007 revision 3 §13",
  strict: [],
  wrapper: [],
  host: [],
};
for (const c of cases) {
  assert.equal(schemaValid(c.params), c.valid, c.id);
  report.strict.push({ id: c.id, valid: c.valid });
}
for (const number of [43, 44, 45, 54]) {
  const vector = vectors.find((v) => v.rfcVector === number);
  for (const action of vector.actions.filter((a) => a.op === "observe")) {
    const params =
      action.params?.$fixture === "rules-over-limit"
        ? { rules: Array.from({ length: 65 }, () => ({ match: {} })) }
        : action.params;
    const response = parseRequest(params, { granted: number !== 43 });
    assert.equal(response.error?.code, action.expectCode, vector.id);
    if (action.expectLimit)
      assert.equal(typeof response.error.data.limit, "string");
    if (!response.error) assert.deepEqual(response.result, {});
  }
  report.wrapper.push({
    rfcVector: number,
    status: "pass",
    limits: { rules: 64, pathsPerRule: 64 },
    grant: number !== 43,
  });
}
console.log(
  "STRICT SCHEMA OK (" +
    cases.length +
    " cases); admission wrapper OK (43–45, 54)",
);
if (values.host) {
  const { loadHost } = await import("./agent-framework-tool-lifecycle.mjs");
  const host = await loadHost(values.host);
  report.hostInfo = host.info;
  for (const c of cases) {
    const actual = host.parse(c.params);
    const match = actual.ok === c.valid;
    report.host.push({
      id: c.id,
      schemaValid: c.valid,
      hostAccepted: actual.ok,
      match,
    });
    if (!match)
      console.log(
        "HOST/SCHEMA MISMATCH " +
          c.id +
          ": schema=" +
          c.valid +
          " host=" +
          actual.ok,
      );
  }
  // Omitted transport params are distinct from explicit null: omission is
  // normalized to {} by this strict request wrapper, not a schema instance.
  const omitted = host.parse(undefined);
  assert.deepEqual(parseRequest(undefined), { result: {}, filter: null });
  report.omittedParams = {
    hostAccepted: omitted.ok,
    strictTransportNormalization: {},
    schemaValid: schemaValid({}),
  };
}
report.summary = {
  strictCases: report.strict.length,
  wrapperCases: report.wrapper.length,
  hostMismatches: report.host.filter((c) => !c.match).length,
};
if (values.report)
  await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report.summary));
if (report.summary.hostMismatches) process.exitCode = 1;
