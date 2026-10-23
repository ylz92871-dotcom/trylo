import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { expect, it, vi } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { NodeProcessFixture } from './cli-node-process.fixture';
import type { ProcessService } from './process-service';
import type { FilePath, ProcessId } from './types';
import type { LoopEvent } from './loop-events';
import { CodePermissionRegistry } from '../runtime/code-permission-registry';
import { settingsDefaults } from '../settings/settings-store';
import { AgentConversationSurface } from '../components/chat/AgentConversationSurface';
import { applyEvents } from '../components/chat/events';
import type { ChatMessage, SubagentMessage } from '../components/chat/types';

const h = vi.hoisted(() => ({ service: null as ProcessService | null }));
vi.mock('./index', () => ({ hostAdapter: { get process() { return h.service; } } }));
vi.mock('../runtime/cli-runtime-guard', () => ({ verifyCliRuntime: vi.fn(async () => ({ ok: true })) }));
vi.mock('react-virtuoso', async () => {
  const { forwardRef } = await import('react');
  return { Virtuoso: forwardRef(function List(props: { data: readonly unknown[]; itemContent: (index: number, item: unknown) => React.ReactNode }, _ref) {
    return <div>{props.data.map((item, index) => <div key={index}>{props.itemContent(index, item)}</div>)}</div>;
  }) };
});
const { CodeRunController } = await import('../runtime/code-run-controller');
const { sendSubagentInput } = await import('./trylo-v1-subagent-control');

for (const parked of [false, true]) it(parked
  ? 'continues an automatically parked real CLI task in the same UI conversation'
  : 'sends a UI follow-up to the same real CLI child and renders its second answer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trylo-collaboration-'));
  const workspace = join(root, 'workspace') as FilePath, home = join(root, 'home');
  mkdirSync(workspace); mkdirSync(home); writeFileSync(join(workspace, 'package.json'), '{}');
  execFileSync('git', ['init', '--quiet', workspace], { windowsHide: true });
  const service = new NodeProcessFixture({ ...process.env, TRYLO_HOME: home, TRYLO_API_KEY: '', TRYLO_OPENAI_API_KEY: '' });
  h.service = service;
  const agentIds: string[] = [];
  const events: LoopEvent[] = [];
  let finishSpawns: () => void = () => {}, finishFollowUp: () => void = () => {};
  const spawned = new Promise<void>(done => { finishSpawns = done; });
  const followedUp = new Promise<void>(done => { finishFollowUp = done; });
  let mainRequests = 0;
  const childPrompts: string[] = [];
  const textReply = (out: ServerResponse, text: string): void => {
    out.writeHead(200, { 'content-type': 'text/event-stream' });
    out.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  };
  const toolsReply = (out: ServerResponse, calls: { id: string; name: string; arguments: object }[]): void => {
    out.writeHead(200, { 'content-type': 'text/event-stream' });
    out.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls.map((call, index) => ({ index, id: call.id,
      type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
  };
  const server = createServer((incoming, outgoing) => {
    let input = ''; incoming.on('data', chunk => { input += String(chunk); });
    incoming.on('end', () => { void (async () => {
      const body = JSON.parse(input) as { messages: { role: string; content: string }[] };
      const userTexts = body.messages.filter(message => message.role === 'user').map(message => message.content);
      if (!userTexts.includes('COLLAB_PARENT')) {
        const last = userTexts.at(-1) ?? '';
        childPrompts.push(last);
        textReply(outgoing, last === 'CHILD_FOLLOWUP' ? 'CHILD_ANSWER_2' : `CHILD_ANSWER_1:${last}`);
        return;
      }
      mainRequests += 1;
      if (mainRequests === 1) {
        toolsReply(outgoing, [1, 2, 3].map(index => ({ id: `spawn-${index}`, name: 'spawn_agent', arguments: { message: `CHILD_TASK_${index}`,
          ...(parked ? { idle_timeout_ms: 200 } : {}) } })));
      } else if (mainRequests === 2) {
        await spawned;
        toolsReply(outgoing, [{ id: 'collect', name: 'wait_agent', arguments: { targets: agentIds, timeout_ms: 1000 } }]);
      } else {
        await followedUp;
        textReply(outgoing, 'PARENT_FINISHED');
      }
    })().catch(error => { outgoing.writeHead(500); outgoing.end(String(error)); }); });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local endpoint');
  let processId: ProcessId | null = null;
  let push: (batch: readonly LoopEvent[]) => void = () => {};
  let current: ChatMessage[] = [{ id: 'live-u', kind: 'text', role: 'user', createdAt: 1, text: 'COLLAB_PARENT' }];
  const permissions = new CodePermissionRegistry({ onChange() {}, send: async () => true });
  const controller = new CodeRunController({ projectKey: 'proof', conversationId: 'live', permissions, onChange() {} });
  function Harness() {
    const [messages, setMessages] = useState<ChatMessage[]>(current);
    const [running, setRunning] = useState(true);
    push = batch => {
      current = applyEvents(current, batch); setMessages(current);
      if (batch.some(event => event.type === 'loop_end')) setRunning(false);
    };
    return <AgentConversationSurface surface="code" messages={messages} running={running} emptyState={null} composer={<p>主输入框</p>}
      onSubagentInput={(id, text) => {
        if (!processId) return Promise.reject(new Error('process missing'));
        return sendSubagentInput(processId, id, text);
      }} />;
  }
  render(<Harness />);
  try {
    await act(async () => {
      await controller.run({ prompt: 'COLLAB_PARENT', codeMode: 'agent', permissionLevel: 'read_only', priorMessages: [],
        settings: { ...settingsDefaults, cliRuntimeProtocol: 'trylo-v1', cliPath: resolve('../new trylo cli/dist/cmd/trylo/main.js') as FilePath,
          ...(process.env.TRYLO_SUBAGENT_PROOF_CLI ? { cliPath: resolve(process.env.TRYLO_SUBAGENT_PROOF_CLI) as FilePath } : {}),
          cliNodeProgram: process.execPath, cwd: workspace, apiFormat: 'openai', apiHost: `http://127.0.0.1:${address.port}/v1`, apiModel: 'local-test-model', apiKey: 'local-test-only' },
        onEvents: batch => {
          events.push(...batch);
          for (const event of batch) {
            if (event.type === 'subagent' && event.kind === 'spawn') { agentIds.push(event.id); if (agentIds.length === 3) finishSpawns(); }
            if (event.type === 'subagent' && event.kind === 'update' && event.result === 'CHILD_ANSWER_2') finishFollowUp();
          }
          push(batch);
        } });
      processId = [...service.children.keys()][0] ?? null;
    });
    await waitFor(() => expect(current.filter(message => message.kind === 'subagent' && message.status === 'waiting')).toHaveLength(3), { timeout: 15000 });
    if (parked) await waitFor(() => expect(current.filter(message => message.kind === 'subagent' && message.status === 'done')).toHaveLength(3), { timeout: 15000 });
    fireEvent.click(screen.getByRole('button', { name: '4 个智能体 1 主控 · 3 协作' }));
    fireEvent.click(screen.getAllByRole('button', { name: /的会话$/ })[0]!);
    const panel = screen.getByRole('complementary');
    expect(within(panel).getByText('CHILD_TASK_1')).toBeVisible();
    expect(within(panel).getByText('CHILD_ANSWER_1:CHILD_TASK_1')).toBeVisible();
    fireEvent.change(within(panel).getByRole('textbox'), { target: { value: 'CHILD_FOLLOWUP' } });
    fireEvent.click(within(panel).getByRole('button', { name: '发送给该智能体' }));
    await within(panel).findByText('CHILD_ANSWER_2', {}, { timeout: 15000 });
    await waitFor(() => expect(events.some(event => event.type === 'loop_end')).toBe(true), { timeout: 15000 });
    await Promise.all(service.exits.values());
    const children = current.filter((message): message is SubagentMessage => message.kind === 'subagent');
    expect(children).toHaveLength(3);
    expect(children[0]?.conversation?.map(round => round.result)).toEqual(['CHILD_ANSWER_1:CHILD_TASK_1', 'CHILD_ANSWER_2']);
    expect(childPrompts.filter(prompt => prompt === 'CHILD_FOLLOWUP')).toHaveLength(1);
    if (parked) {
      expect(children[0]?.status).toBe('cancelled');
      expect(children[0]?.subagentId).not.toBe(children[0]?.taskId);
      expect(events.filter(event => event.type === 'subagent' && event.kind === 'spawn')).toHaveLength(4);
    } else expect(children.every(child => child.status === 'cancelled' && child.canReceiveInput === false)).toBe(true);
    expect(service.argv[0]).toContain('--subagent');
    if (process.env.TRYLO_COLLAB_PROOF_DIR) {
      mkdirSync(process.env.TRYLO_COLLAB_PROOF_DIR, { recursive: true });
      writeFileSync(join(process.env.TRYLO_COLLAB_PROOF_DIR, 'wire.json'), JSON.stringify(service.wire.map(line => JSON.parse(line)), null, 2));
      writeFileSync(join(process.env.TRYLO_COLLAB_PROOF_DIR, 'summary.json'), JSON.stringify({ mainRequests, childPrompts, children,
        terminalCount: events.filter(event => event.type === 'loop_end').length, processesRemaining: service.children.size }, null, 2));
    }
  } finally {
    finishSpawns(); finishFollowUp(); cleanup(); await controller.stop(); controller.dispose(); await service.dispose();
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
}, 45000);
