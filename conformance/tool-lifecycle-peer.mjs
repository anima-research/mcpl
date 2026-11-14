// Synthetic MCPL peer: real stdio, scripted tools/results, no Host decisions.
import { readFileSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createCallMatcher } from "./tool-lifecycle-fixture-calls.mjs";
const config = JSON.parse(readFileSync(process.env.MCPL_FIXTURE, "utf8"));
const log = (event) => appendFileSync(config.log, JSON.stringify(event) + "\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const held = new Map();
const reverse = new Map();
let seq = 10000;
const matchCall = createCallMatcher(config.calls);
function finish(msg, call) {
  const result = {
    content: [{ type: "text", text: call.resultText ?? "synthetic-result" }],
    isError: call.isError ?? false,
  };
  log({ event: "result", key: call.key });
  reply(msg.id, result);
}
const lines = createInterface({ input: process.stdin });
lines.on("close", () => process.exit(0));
lines.on("line", (line) => {
  const msg = JSON.parse(line);
  if (!msg.method && reverse.has(msg.id)) {
    const id = reverse.get(msg.id);
    reverse.delete(msg.id);
    log({ event: "observe-response", response: msg });
    reply(id, msg);
    return;
  }
  switch (msg.method) {
    case "initialize":
      reply(msg.id, {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
          experimental: {
            mcpl: {
              version: "0.5",
              ...(config.observer ? { toolLifecycle: true } : {}),
              ...(config.featureSets
                ? { featureSets: config.featureSets }
                : {}),
            },
          },
        },
        serverInfo: { name: "rfc007-fixture", version: "1" },
      });
      break;
    case "featureSets/update":
      log({ event: "policy", params: msg.params });
      reply(msg.id, { accepted: true });
      break;
    case "tools/list":
      reply(msg.id, { tools: config.tools });
      break;
    case "tools/call": {
      const call = matchCall(msg.params);
      log({ event: "call", key: call.key, params: msg.params });
      if (call.hold) held.set(call.key, { msg, call });
      else finish(msg, call);
      break;
    }
    case "tools/lifecycle":
      log({ event: "lifecycle", params: msg.params });
      break;
    case "fixture/control":
      if (msg.params.op === "observe") {
        const id = seq++;
        reverse.set(id, msg.id);
        send({
          jsonrpc: "2.0",
          id,
          method: "tools/observe",
          ...(Object.hasOwn(msg.params, "params")
            ? { params: msg.params.params }
            : {}),
        });
      } else if (msg.params.op === "release") {
        for (const key of msg.params.keys) {
          const entry = held.get(key);
          if (!entry) throw Error("Unopened held fixture call " + key);
          held.delete(key);
          finish(entry.msg, entry.call);
        }
        reply(msg.id, {});
      } else if (msg.params.op === "disconnect") {
        reply(msg.id, {});
        setTimeout(() => process.exit(0), 10);
      } else throw Error("Unknown fixture control");
      break;
    case "fixture/barrier":
      log({ event: "barrier" });
      reply(msg.id, {});
      break;
    default:
      if (msg.id !== undefined && msg.method) reply(msg.id, {});
  }
});
