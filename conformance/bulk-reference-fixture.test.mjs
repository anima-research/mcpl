// Exercise the actual streaming instrument with known client behavior.
// Run with the Host's target Bun version as well as the suite's development version.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './check-bulk-references.mjs';

const stream = { chunks: 64, chunkBytes: 32, intervalMs: 8 };
const pause = ms => new Promise(done => setTimeout(done, ms));

test('an aborting client closes the fixture stream before the producer finishes', async () => {
  const network = await fixture({ stream });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(network.origin + '/known-abort', { signal: controller.signal });
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.ok(first.value.byteLength > 0, 'the live stream must have begun');
    controller.abort();
    const deadline = Date.now() + 2000;
    while (!network.streamClosed && network.chunksSent < stream.chunks && Date.now() < deadline) await pause(5);
    // Inspect before fixture cleanup, which closes its own sockets.
    assert.equal(network.streamClosed, true, 'fixture must observe the known client abort');
    assert.ok(network.chunksSent > 0 && network.chunksSent < stream.chunks, 'aborted producer must stop early');
    const stoppedAt = network.chunksSent;
    await pause(stream.intervalMs * 3);
    assert.equal(network.chunksSent, stoppedAt, 'abort must stop further chunk production');
  } finally {
    clearTimeout(timer);
    controller.abort();
    await network.close();
  }
});

test('a non-aborting client receives all chunks and cannot satisfy the early-abort witness', async () => {
  const network = await fixture({ stream });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(network.origin + '/complete-stream', { signal: controller.signal });
    const body = new Uint8Array(await response.arrayBuffer());
    assert.equal(network.chunksSent, stream.chunks);
    assert.equal(body.byteLength, stream.chunks * stream.chunkBytes);
    assert.ok(body.every(byte => byte === 120));
    assert.equal(network.streamClosed && network.chunksSent < stream.chunks, false, 'completed transfer is not evidence of early abort');
  } finally {
    clearTimeout(timer);
    controller.abort();
    await network.close();
  }
});
