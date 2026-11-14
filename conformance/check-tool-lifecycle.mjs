import { verify } from "./tool-lifecycle-assertions.mjs";
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
// Validate targeted coverage before importing or starting any Host adapter.
let selected = null;
if (values.only !== undefined) {
  const requested = values.only.split(",");
  const known = new Set(data.vectors.map((vector) => vector.rfcVector));
  if (
    !/^[1-9][0-9]*(,[1-9][0-9]*)*$/.test(values.only) ||
    new Set(requested).size !== requested.length ||
    requested.some((value) => !known.has(Number(value)))
  ) {
    throw Error(
      "Invalid --only: use distinct case numbers 1–54 separated by commas",
    );
  }
  selected = new Set(requested.map(Number));
}
const module = await import(
  values.adapter
    ? pathToFileURL(resolve(values.adapter)).href
    : new URL("./agent-framework-tool-lifecycle.mjs", import.meta.url).href
);
const host = await module.loadHost(values.host);
const report = { host: host.info, selection: values.only ?? "all", cases: [] };
console.log("Host evidence: " + JSON.stringify(host.info));
for (const vector of data.vectors) {
  if (selected && !selected.has(vector.rfcVector)) continue;
  if (vector.requires && !host.info.capabilities[vector.requires]) {
    const reason = "Host capability absent: " + vector.requires;
    report.cases.push({ id: vector.id, status: "not-applicable", reason });
    console.log("NOT APPLICABLE " + vector.id + " — " + reason);
    continue;
  }
  try {
    const result = await host.observe(vector);
    const checks = verify(vector, result, host.info);
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
