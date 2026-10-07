// Fixture identity matching. MCP tools/call has no model-call ID, so use the
// provider tool name and complete JSON arguments, within the current call round.
import { isDeepStrictEqual } from "node:util";
export function expandInput(input) {
  if (input?.$fixture === "object-utf8-bytes") {
    const overhead = Buffer.byteLength(JSON.stringify({ data: "" }));
    return { data: "x".repeat(input.bytes - overhead) };
  }
  return structuredClone(input);
}
const name = (call) => call.tool.split("--").at(-1);
const sameRequest = (a, b) =>
  name(a) === name(b) && isDeepStrictEqual(a.input, b.input);
const treatment = (call) => ({
  hold: call.hold ?? false,
  isError: call.isError ?? false,
  resultText: call.resultText ?? "synthetic-result",
});
export function createCallMatcher(calls) {
  const pending = calls.map((call) => ({
    ...call,
    input: expandInput(call.input),
  }));
  // Simultaneous indistinguishable calls can have interchangeable fixture keys,
  // but cannot request different synthetic outcomes: no wire fact distinguishes them.
  for (let i = 0; i < pending.length; i++)
    for (let j = 0; j < i; j++) {
      if (
        pending[i].round === pending[j].round &&
        sameRequest(pending[i], pending[j]) &&
        !isDeepStrictEqual(treatment(pending[i]), treatment(pending[j]))
      ) {
        throw Error(
          "Ambiguous same-round fixture calls: " +
            pending[j].key +
            " and " +
            pending[i].key,
        );
      }
    }
  return (params) => {
    const round = pending[0]?.round;
    const index = pending.findIndex(
      (call) =>
        call.round === round &&
        name(call) === params?.name &&
        isDeepStrictEqual(call.input, params.arguments),
    );
    if (index < 0)
      throw Error("Unexpected fixture call " + JSON.stringify(params));
    return pending.splice(index, 1)[0];
  };
}
