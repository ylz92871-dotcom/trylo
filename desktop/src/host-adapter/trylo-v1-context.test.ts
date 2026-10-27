// @vitest-environment node
import { expect, it } from 'vitest';
import { TryloV1EventAdapter } from './trylo-v1-event-adapter';
import { applyEvents } from '../components/chat/events';
import { latestContextTokens, latestContextWindow, type ChatMessage } from '../components/chat/types';

function harness() {
  const adapter = new TryloV1EventAdapter();
  let messages: readonly ChatMessage[] = [{ id: 'u', kind: 'text', role: 'user', text: 'continue', createdAt: 0 }];
  return { send(frame: object) { messages = applyEvents(messages, adapter.feed(JSON.stringify(frame))); },
    get messages() { return messages; } };
}
const start = { type: 'run_start', sessionId: 's', turnId: 't', providerId: 'fixture', model: 'fixture' };
const terminal = { type: 'run_result', status: 'completed', finishReason: 'completed', sessionId: 's', turnId: 't',
  iterations: 12, usage: { inputTokens: 422000, outputTokens: 1200, totalTokens: 423200 }, durationMs: 1000, lastMessage: 'done' };

it('starts a new request with its actual window instead of retaining an older reading', () => {
  const h = harness(); h.send({ ...start, contextWindow: 128000 });
  h.send({ type: 'usage', usage: { inputTokens: 100000, outputTokens: 1, totalTokens: 100001 } });
  h.send(terminal);
  const next = new TryloV1EventAdapter(); // One adapter/process per turn.
  const messages = applyEvents(h.messages, next.feed(JSON.stringify({ ...start, turnId: 'next', contextWindow: 200000 })));
  expect(latestContextWindow(messages)).toBe(200000);
  expect(latestContextTokens(messages)).toBe(0);
});

it('uses the latest request immediately and never substitutes cumulative billing at terminal', () => {
  const h = harness(); h.send(start);
  h.send({ type: 'usage', usage: { inputTokens: 30000, outputTokens: 100, totalTokens: 30100 } });
  expect(latestContextTokens(h.messages)).toBe(30000);
  h.send({ type: 'usage', usage: { inputTokens: 33000, outputTokens: 100, totalTokens: 33100 } });
  h.send(terminal);
  expect(latestContextTokens(h.messages)).toBe(33000);
});

it('projects compaction results and does not restore an older pre-compaction reading on exit', () => {
  const h = harness(); h.send(start);
  h.send({ type: 'usage', usage: { inputTokens: 180000, outputTokens: 100, totalTokens: 180100 } });
  h.send({ type: 'compact', status: 'started', tokensBefore: 180000, reason: 'auto' });
  h.send({ type: 'compact', status: 'completed', tokensBefore: 180000, tokensAfter: 40000, reason: 'auto' });
  expect(latestContextTokens(h.messages)).toBe(40000);
  h.send(terminal); expect(latestContextTokens(h.messages)).toBe(40000);
  expect(h.messages.filter(message => message.kind === 'compaction')).toHaveLength(1);
});

it('unknown compaction counts never reset an existing measurement to zero', () => {
  const h = harness(); h.send(start);
  h.send({ type: 'usage', usage: { inputTokens: 33000, outputTokens: 0, totalTokens: 33000 } });
  h.send({ type: 'compact', status: 'completed', reason: 'old boundary' });
  expect(latestContextTokens(h.messages)).toBe(33000);
});

it('manual maintenance has a terminal but does not manufacture an empty assistant turn', () => {
  const h = harness(); h.send({ ...start, operation: 'compact' });
  h.send({ type: 'compact', status: 'completed', tokensBefore: 180000, tokensAfter: 40000, reason: 'manual' });
  h.send({ ...terminal, iterations: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, lastMessage: '' });
  expect(latestContextTokens(h.messages)).toBe(40000);
  expect(h.messages.some(message => message.kind === 'turn')).toBe(false);
});

it('a fresh provider reading after compaction supersedes the estimate while the request is still running', () => {
  const h = harness(); h.send({ ...start, contextWindow: 128000 });
  h.send({ type: 'compact', status: 'completed', tokensBefore: 180000, tokensAfter: 40000, reason: 'auto' });
  h.send({ type: 'usage', usage: { inputTokens: 35000, outputTokens: 1, totalTokens: 35001 } });
  expect(latestContextTokens(h.messages)).toBe(35000);
  expect(latestContextWindow(h.messages)).toBe(128000);
});

it('interrupted compaction does not leave a permanent busy notice or reset its previous measurement', () => {
  const h = harness(); h.send(start);
  h.send({ type: 'usage', usage: { inputTokens: 33000, outputTokens: 1, totalTokens: 33001 } });
  h.send({ type: 'compact', status: 'started', tokensBefore: 33000, reason: 'auto' });
  h.send({ ...terminal, status: 'cancelled' });
  expect(h.messages.some(message => message.kind === 'notice' && message.text.startsWith('Compacting context'))).toBe(false);
  expect(latestContextTokens(h.messages)).toBe(33000);
});

it('restored totals without request provenance are ignored on v1 until a real reading arrives', () => {
  const legacy: ChatMessage[] = [{ id: 'old', kind: 'turn', role: 'system', createdAt: 0,
    turn: 1, depth: 0, agentId: null, status: 'done', usage: { input_tokens: 422000 } }];
  expect(latestContextTokens(legacy)).toBe(422000); // Legacy CLI compatibility.
  expect(latestContextTokens(legacy, { allowLegacyUsage: false })).toBe(0);
});
