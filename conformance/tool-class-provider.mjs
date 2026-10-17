// Synthetic MCP I/O only. Class interpretation lives in the Host under test.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const listingPath = process.env.MCPL_VECTOR_LISTING;
const logPath = process.env.MCPL_VECTOR_LOG;
if (!listingPath || !logPath) throw Error("Fixture needs a listing and log path");
const readListing = () => JSON.parse(readFileSync(listingPath, "utf8"));
const log = entry => appendFileSync(logPath, JSON.stringify(entry) + "\n");
const send = message => process.stdout.write(JSON.stringify(message) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
let listing = readListing();
let initialized = false;

const timer = setInterval(() => {
  if (!initialized) return;
  const next = readListing();
  if (next.revision !== listing.revision) {
    listing = next;
    log({ event: "changed", revision: listing.revision });
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }
}, 20);

const lines = createInterface({ input: process.stdin });
lines.on("close", () => { clearInterval(timer); process.exit(0); });
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: true }, experimental: { mcpl: { version: "0.5" } } },
      serverInfo: { name: "rfc-008-conformance-provider", version: "1" },
    });
  } else if (message.method === "notifications/initialized") {
    initialized = true;
  } else if (message.method === "featureSets/update") {
    if (Object.hasOwn(message, "id")) reply(message.id, { accepted: true });
  } else if (message.method === "tools/list") {
    log({ event: "listed", revision: listing.revision });
    reply(message.id, { tools: listing.tools });
  } else if (message.method === "tools/call") {
    reply(message.id, { content: [{ type: "text", text: "Synthetic tool result" }] });
  } else if (Object.hasOwn(message, "id") && message.method) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
});
