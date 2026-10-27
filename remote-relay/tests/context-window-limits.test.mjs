import test from 'node:test';
import assert from 'node:assert/strict';
import { createAmdExecutor, AMD_BASE } from '../src/model-service/amd.mjs';

test('long message histories pass the structural guard while oversized histories fail before credentials or dispatch', () => {
  let reads = 0, dispatches = 0;
  const executor = createAmdExecutor({
    vault: { has: () => false, read: () => { reads++; throw Error('unexpected credential access'); } },
    transport: () => { dispatches++; throw Error('unexpected dispatch'); },
  });
  const source = { id: 'fixture', type: 'free', protocol: 'chat', unit: 'requests', endpoint: AMD_BASE,
    catalog: [{ id: 'fixture-model', chat: true, streaming: true, tools: true, contextLength: 1_000_000 }] };
  const prepare = count => executor.prepare({ source, model: 'fixture-model', streaming: false,
    payload: { max_tokens: 64, messages: Array.from({ length: count }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' })) } });
  assert.doesNotThrow(() => prepare(260));
  assert.doesNotThrow(() => prepare(2048));
  assert.throws(() => prepare(2049), error => error.status === 400);
  assert.equal(reads, 0); assert.equal(dispatches, 0);
});
