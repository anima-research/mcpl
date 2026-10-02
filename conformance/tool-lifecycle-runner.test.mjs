// Runner/peer regressions use synthetic transport messages, not Host evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createCallMatcher } from "./tool-lifecycle-fixture-calls.mjs";
const peerPath = fileURLToPath(
  new URL("./tool-lifecycle-peer.mjs", import.meta.url),
);
const runnerPath = fileURLToPath(
  new URL("./check-tool-lifecycle.mjs", import.meta.url),
);
async function withPeer(calls, run) {
  const dir = await mkdtemp(join(tmpdir(), "rfc007-peer-test-"));
  const log = join(dir, "peer.jsonl"),
    config = join(dir, "config.json");
  await writeFile(config, JSON.stringify({ log, tools: [], calls }));
  const child = spawn(process.execPath, [peerPath], {
    env: { ...process.env, MCPL_FIXTURE: config },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let seq = 1,
    stderr = "",
    closed;
  const exit = new Promise((done) =>
    child.once("exit", (code, signal) => {
      closed = { code, signal };
      done(closed);
    }),
  );
  const lines = createInterface({ input: child.stdout });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const rejectAll = (error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  };
  child.on("error", rejectAll);
  child.on("exit", () => rejectAll(Error("Peer exited: " + stderr)));
  lines.on("line", (line) => {
    const msg = JSON.parse(line),
      waiter = pending.get(msg.id);
    if (waiter) {
      pending.delete(msg.id);
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    }
  });
  const request = (method, params) => {
    const id = seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error("Peer request timeout"));
      }, 5000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  };
  try {
    await run(request, async () =>
      (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse),
    );
  } finally {
    rejectAll(Error("Test cleanup"));
    if (!closed) {
      child.kill();
      await exit;
    }
    lines.close();
    await rm(dir, { recursive: true, force: true });
  }
}
test("peer permits reversed parallel dispatch", async () => {
  await withPeer(
    [
      { key: "a", tool: "x--run", input: { a: 1 }, round: 0, hold: true },
      { key: "b", tool: "x--other", input: { b: 2 }, round: 0, hold: true },
    ],
    async (request, readLog) => {
      const b = request("tools/call", { name: "other", arguments: { b: 2 } });
      const a = request("tools/call", { name: "run", arguments: { a: 1 } });
      // Observe rejections immediately while waiting for the barrier.
      const replies = Promise.all([b, a]);
      replies.catch(() => {});
      await request("fixture/barrier", {});
      assert.deepEqual(
        (await readLog()).filter((e) => e.event === "call").map((e) => e.key),
        ["b", "a"],
      );
      await request("fixture/control", { op: "release", keys: ["a", "b"] });
      assert.equal((await replies).length, 2);
    },
  );
});
test("same tool reversed arguments and repeated identical later call", async () => {
  await withPeer(
    [
      {
        key: "a",
        tool: "x--run",
        input: { value: 1 },
        round: 0,
        resultText: "first",
      },
      {
        key: "b",
        tool: "x--run",
        input: { value: 2 },
        round: 0,
        resultText: "second",
      },
      {
        key: "c",
        tool: "x--run",
        input: { value: 1 },
        round: 1,
        resultText: "later",
      },
    ],
    async (request, readLog) => {
      const text = (reply) => reply.result.content[0].text;
      assert.equal(
        text(
          await request("tools/call", { name: "run", arguments: { value: 2 } }),
        ),
        "second",
      );
      assert.equal(
        text(
          await request("tools/call", { name: "run", arguments: { value: 1 } }),
        ),
        "first",
      );
      assert.equal(
        text(
          await request("tools/call", { name: "run", arguments: { value: 1 } }),
        ),
        "later",
      );
      assert.deepEqual(
        (await readLog()).filter((e) => e.event === "call").map((e) => e.key),
        ["b", "a", "c"],
      );
    },
  );
});
test("matcher consumes identical requests once each and preserves round boundaries", () => {
  const match = createCallMatcher([
    { key: "a", tool: "x--run", input: { x: 1 }, round: 0 },
    { key: "b", tool: "x--run", input: { x: 1 }, round: 0 },
    { key: "c", tool: "x--run", input: { x: 2 }, round: 1 },
  ]);
  assert.throws(
    () => match({ name: "run", arguments: { x: 2 } }),
    /Unexpected fixture call/,
  );
  assert.equal(match({ name: "run", arguments: { x: 1 } }).key, "a");
  assert.equal(match({ name: "run", arguments: { x: 1 } }).key, "b");
  assert.throws(
    () => match({ name: "run", arguments: { x: 1 } }),
    /Unexpected fixture call/,
  );
  assert.equal(match({ name: "run", arguments: { x: 2 } }).key, "c");
  assert.throws(
    () => match({ name: "run", arguments: { x: 2 } }),
    /Unexpected fixture call/,
  );
});
test("indistinguishable same-round requests cannot prescribe different outcomes", () => {
  assert.throws(
    () =>
      createCallMatcher([
        {
          key: "a",
          tool: "x--run",
          input: { x: 1 },
          round: 0,
          resultText: "first",
        },
        {
          key: "b",
          tool: "x--run",
          input: { x: 1 },
          round: 0,
          resultText: "second",
        },
      ]),
    /Ambiguous same-round/,
  );
});
test("invalid --only selections fail before loading the Host", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rfc007-selection-test-"));
  try {
    const adapter = join(dir, "adapter.mjs"),
      marker = join(dir, "loaded");
    await writeFile(
      adapter,
      'import {writeFileSync} from "node:fs"; export async function loadHost(){writeFileSync(' +
        JSON.stringify(marker) +
        ',"loaded"); return {info:{capabilities:{}},observe(){throw Error("Unexpected observe");}}}',
    );
    for (const only of [
      "55",
      "0",
      "1,55",
      "",
      " ",
      "1,",
      "1,,2",
      "abc",
      "1.5",
      "NaN",
      "-1",
      "1,1",
    ]) {
      const result = spawnSync(
        process.execPath,
        [
          runnerPath,
          "--host",
          "fixture",
          "--adapter",
          adapter,
          "--only=" + only,
        ],
        { encoding: "utf8", timeout: 10000 },
      );
      assert.equal(result.error, undefined, only);
      assert.equal(
        existsSync(marker),
        false,
        "invalid selection starts no Host: " + JSON.stringify(only),
      );
      assert.notEqual(
        result.status,
        0,
        "invalid selection fails: " + JSON.stringify(only),
      );
      assert.match(result.stderr, /Invalid --only/);
    }
    const valid = spawnSync(
      process.execPath,
      [runnerPath, "--host", "fixture", "--adapter", adapter, "--only=22,23"],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(valid.error, undefined);
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(existsSync(marker), true, "valid selection loads the Host");
    assert.match(valid.stdout, /"not-applicable":2/);
    assert.match(valid.stdout, /\(selected cases\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
