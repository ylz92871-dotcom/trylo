import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it } from 'vitest';
import { parseCliV1Event } from './trylo-v1-protocol';
import { TryloV1EventAdapter } from './trylo-v1-event-adapter';
import { ToolCard } from '../components/chat/ToolCard';

afterEach(cleanup);
const receipt = { schemaVersion: 1, decisionPoint: 'read_file.strategy.v1', executionId: 'read-1',
  candidateIds: ['whole', 'stream'], selectedPath: 'whole', actualPath: 'whole', reason: 'learned_policy',
  versionId: 'routing:policy:private-id', outcome: 'completed', cost: { bytesRead: 1940, latencyMs: 31 }, diagnostics: [] };
const frame = (routing?: unknown) => JSON.stringify({ type: 'tool_result', toolCallId: 'read-1', name: 'read_file',
  status: 'succeeded', output: 'actual file content', truncated: false, ...(routing === undefined ? {} : { routing }) });

it('strictly rejects malformed optional routing receipts while accepting old streams unchanged', () => {
  expect(parseCliV1Event(frame()).ok).toBe(true);
  expect(parseCliV1Event(frame(receipt)).ok).toBe(true);
  for (const invalid of [{ ...receipt, schemaVersion: 2 }, { ...receipt, actualPath: '' },
    { ...receipt, candidateIds: Array(9).fill('whole') }, { ...receipt, diagnostics: Array(17).fill('degraded') },
    { ...receipt, executionId: 'x'.repeat(257) }, { ...receipt, cost: { tokens: -1 } },
    { ...receipt, cost: { tokens: null } }, { ...receipt, cost: {} },
    { ...receipt, cost: { tokens: 1.5 } }, { ...receipt, cost: { bytesRead: 1e12 + 1 } },
    { ...receipt, candidateIds: ['whole', 'whole'] }, { ...receipt, actualPath: 'unknown' },
    { ...receipt, extraAuthority: 'allow-network' }]) {
    expect(parseCliV1Event(frame(invalid)).ok, JSON.stringify(invalid)).toBe(false);
  }
});

it('preserves the valid route version and absent model usage through the Desktop projection', () => {
  const adapter = new TryloV1EventAdapter();
  adapter.feed(JSON.stringify({ type: 'run_start', sessionId: 'session', turnId: 'turn', providerId: 'fixture', model: 'model' }));
  adapter.feed(JSON.stringify({ type: 'tool_use', toolCallId: 'read-1', name: 'read_file', input: { path: 'readme.md' } }));
  const events = adapter.feed(frame(receipt));
  const result = events.find(event => event.type === 'tool_result');
  expect(result?.type === 'tool_result' && result.content).toEqual([
    { type: 'structured', schema: 'trylo.routing.v1', value: receipt },
  ]);
  expect(result?.type === 'tool_result' && result.output).toBe('actual file content');
});

it('explains adopted routes in the tool card and keeps IDs in collapsed evidence details', () => {
  render(<ToolCard variant="event" message={{ id: 'read-1', kind: 'tool', role: 'assistant', createdAt: 1,
    tool: 'Read', status: 'done', summary: 'read readme.md', outputText: 'actual file content',
    outputContent: [{ type: 'structured', schema: 'trylo.routing.v1', value: receipt }] }} />);
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByText('已采用整文件读取')).toBeInTheDocument();
  expect(screen.getByText('routing:policy:private-id')).not.toBeVisible();
  expect(screen.getByText('模型用量：未回报')).toBeInTheDocument();
  expect(screen.getByText('actual file content')).toBeInTheDocument();
  expect(screen.queryByText('0 tokens')).not.toBeInTheDocument();
});

it('makes an actual fallback explicit without claiming missing usage or savings', () => {
  render(<ToolCard variant="event" message={{ id: 'read-1', kind: 'tool', role: 'assistant', createdAt: 1,
    tool: 'Read', status: 'done', summary: 'read readme.md', outputText: 'fallback file content',
    outputContent: [{ type: 'structured', schema: 'trylo.routing.v1', value: { ...receipt, actualPath: 'stream', reason: 'path_failed', cost: undefined } }] }} />);
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByText('已回退至流式读取')).toBeInTheDocument();
  fireEvent.click(screen.getByText('已回退至流式读取'));
  expect(screen.getByText('模型用量：未回报')).toBeVisible();
  expect(screen.getByText('fallback file content')).toBeInTheDocument();
  expect(screen.queryByText(/节省|0 tokens/)).not.toBeInTheDocument();
});

it('describes the stable child context routes without claiming a model switch', () => {
  render(<ToolCard variant="event" message={{ id: 'child-1', kind: 'tool', role: 'assistant', createdAt: 1,
    tool: 'spawn_agent', status: 'done', summary: 'member task', outputText: 'member task result',
    outputContent: [{ type: 'structured', schema: 'trylo.routing.v1', value: { ...receipt,
      decisionPoint: 'subagent.context.v1', executionId: 'child-1', candidateIds: ['independent', 'fork'],
      selectedPath: 'fork', actualPath: 'fork', cost: undefined } }] }} />);
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByText('已采用父对话上下文')).toBeInTheDocument();
  expect(screen.getByText('member task result')).toBeInTheDocument();
  expect(screen.queryByText(/切换模型/)).not.toBeInTheDocument();
});
