import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './check-bulk-references.mjs';

const stream = { chunks: 64, chunkBytes: 32, intervalMs: 8 };
const pause = ms => new Promise(done => setTimeout(done, ms));
const LONG = { timeout: 30000 };

test('an aborting client closes the fixture stream before the producer finishes', LONG, async () => {
  const network = await fixture({ stream });
  const controller = new AbortController();
  try {
    const response = await fetch(network.origin + '/known-abort', { signal: controller.signal });
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.ok(first.value.byteLength > 0, 'the live stream must have begun');
    controller.abort();
    while (!network.streamClosed && network.chunksSent < stream.chunks) await pause(5);
    assert.equal(network.streamClosed, true, 'fixture must observe the known client abort');
    assert.ok(network.chunksSent > 0 && network.chunksSent < stream.chunks, 'aborted producer must stop early');
  } finally {
    controller.abort();
    await network.close();
  }
});

test('a non-aborting client receives all chunks and cannot satisfy the early-abort witness', LONG, async () => {
  const network = await fixture({ stream });
  try {
    const response = await fetch(network.origin + '/complete-stream');
    const body = new Uint8Array(await response.arrayBuffer());
    assert.equal(network.chunksSent, stream.chunks);
    assert.equal(body.byteLength, stream.chunks * stream.chunkBytes);
    assert.ok(body.every(byte => byte === 120));
  } finally {
    await network.close();
  }
});
