import test from 'node:test';
import assert from 'node:assert/strict';
import { respondToRender } from './agent-framework-coalescing.mjs';

for (const order of [[0, 1], [1, 0]]) {
  test('overlapping render evidence keeps request identity under completion order ' + order, async () => {
    const renders = [], pending = [], replies = [];
    const start = index => respondToRender({
      renders, server: 'server-' + index, params: { key: 'key-' + index, eventId: 'event-' + index },
      plan: { mode: 'inference-request', text: 'result-' + index }, held: [],
      reply: result => { replies[index] = result; },
      replyError() { throw new Error('unexpected error'); },
      send(server, method, params) {
        assert.equal(server, 'server-' + index);
        assert.equal(method, 'inference/request');
        assert.deepEqual(params, { featureSet: 'doc', messages: [] });
        return new Promise(resolve => { pending[index] = resolve; });
      },
    });
    const tasks = [start(0), start(1)];
    assert.deepEqual(renders.map(entry => entry.params.eventId), ['event-0', 'event-1']);
    const responses = [0, 1].map(i => ({ id: 'response-' + i, error: { code: -32600, message: 'refused-' + i } }));
    pending[order[0]](responses[order[0]]);
    await tasks[order[0]];
    assert.equal(renders[order[1]].inferenceResponse, undefined, 'unfinished render must stay unfinished');
    pending[order[1]](responses[order[1]]);
    await tasks[order[1]];
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(renders[i], { server: 'server-' + i, params: { key: 'key-' + i, eventId: 'event-' + i }, inferenceResponse: responses[i] });
      assert.deepEqual(replies[i], { content: [{ type: 'text', text: 'result-' + i }] });
    }
  });
}
