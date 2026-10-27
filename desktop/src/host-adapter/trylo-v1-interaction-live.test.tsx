// @vitest-environment jsdom
import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NodeProcessFixture } from './cli-node-process.fixture';
import type { ProcessService } from './process-service';
import type { FilePath } from './types';
import type { LoopEvent } from './loop-events';
import { CodePermissionRegistry } from '../runtime/code-permission-registry';
import { applyEvents } from '../components/chat/events';
import { Message } from '../components/chat/Message';
import { ApprovalCard } from '../components/chat/ApprovalCard';
import type { ChatMessage } from '../components/chat/types';
const h = vi.hoisted(() => ({ service: null as ProcessService | null }));
vi.mock('./index', () => ({ hostAdapter: { get process() { return h.service; } } }));
vi.mock('../runtime/cli-runtime-guard', () => ({ verifyCliRuntime: vi.fn(async () => ({ ok: true })) }));
const { CodeRunController } = await import('../runtime/code-run-controller');

it('streams before completion, displays a real question, awaits an approval click and consumes live guidance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trylo-interaction-'));
  const home = join(root, 'home'), workspace = join(root, 'workspace') as FilePath;
  mkdirSync(home); mkdirSync(workspace); writeFileSync(join(workspace, 'package.json'), '{}');
  execFileSync('git', ['init', '--quiet', workspace], { windowsHide: true });
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = createServer((incoming, outgoing) => {
    let body = ''; incoming.on('data', chunk => { body += String(chunk); });
    incoming.on('end', () => { void (async () => {
      requests.push(JSON.parse(body)); const index = requests.length;
      outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = (value: object, finish: string | null = null) => outgoing.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
      if (index === 1) {
        delta({ reasoning_content: 'FIRST_REASONING_CHUNK ' });
        await gate;
        delta({ reasoning_content: 'SECOND_REASONING_CHUNK' });
        delta({ tool_calls: [{ index: 0, id: 'question-call', type: 'function', function: { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{
          id: 'style', header: '样式', question: '选择修改方向', multiSelect: true,
          options: [{ label: 'A', description: '方向 A' }, { label: 'B', description: '方向 B' }],
        }] }) } }] }); delta({}, 'tool_calls');
      } else if (index === 2) {
        delta({ tool_calls: [{ index: 0, id: 'write-call', type: 'function', function: { name: 'write_file',
          arguments: JSON.stringify({ path: 'proof.txt', content: 'APPROVED_WRITE' }) } }] }); delta({}, 'tool_calls');
      } else { delta({ content: 'INTERACTION_COMPLETE' }); delta({}, 'stop'); }
      outgoing.end('data: [DONE]\n\n');
    })().catch(error => outgoing.destroy(error as Error)); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const service = new NodeProcessFixture({ ...process.env, TRYLO_HOME: home, TRYLO_API_KEY: '', TRYLO_OPENAI_API_KEY: '' }); h.service = service;
  let refresh = () => {};
  let messages: readonly ChatMessage[] = [{ id: 'user-1', role: 'user', kind: 'text', text: 'Run interaction proof', createdAt: Date.now() }];
  const permissions = new CodePermissionRegistry({ onChange: () => refresh(), send: async (id, line) => { await service.send(id as never, line); return true; } });
  const controller = new CodeRunController({ projectKey: 'p', conversationId: 'c', permissions, onChange: () => refresh() });
  const events: LoopEvent[] = [];
  function Harness() {
    const [, setVersion] = useState(0); refresh = () => setVersion(n => n + 1);
    return <>{messages.map(message => <Message key={message.id} message={message}
      onRespondInputRequest={(id, status, answers) => controller.inputRequests.respond(id, status, answers)} />)}
      {permissions.list().map(request => <ApprovalCard key={request.requestId} message={{ id: request.requestId, kind: 'approval', role: 'system',
        createdAt: request.at, approvalId: request.requestId, type: request.toolName, description: 'Review the actual file write', status: 'pending', authority: 'code' }}
        onRespond={(id, allow) => { void permissions.respond(id, allow); }} />)}</>;
  }
  const view = render(<Harness />);
  try {
    await controller.run({ prompt: 'Run interaction proof', permissionLevel: 'ask', codeMode: 'agent', priorMessages: [],
      settings: { cliRuntimeProtocol: 'trylo-v1', cliPath: resolve(process.env.TRYLO_DESKTOP_CLI_ENTRY ?? '../new trylo cli/dist/cmd/trylo/main.js') as FilePath,
        cliNodeProgram: process.execPath, cwd: workspace, apiFormat: 'openai', providerId: 'openai-compatible', apiHost: `http://127.0.0.1:${port}/v1`, apiModel: 'interaction-model', apiKey: 'local-test-only' },
      onEvents: batch => { events.push(...batch); messages = applyEvents(messages, batch); refresh(); } });
    await waitFor(() => expect(events.some(e => e.type === 'thinking' && e.preview.includes('FIRST_REASONING_CHUNK'))).toBe(true), { timeout: 12000 });
    await waitFor(() => expect(screen.getAllByText(/FIRST_REASONING_CHUNK/)[0]).toBeVisible());
    expect(events.some(e => e.type === 'thinking' && e.preview.includes('SECOND_REASONING_CHUNK'))).toBe(false);
    expect(await controller.steer('USE_GUIDANCE_MARKER')).toEqual({ kind: 'delivered' });
    release();
    const a = await screen.findByRole('checkbox', { name: /方向 A/ }, { timeout: 12000 });
    expect(requests).toHaveLength(1); expect(permissions.list()).toHaveLength(0);
    fireEvent.click(a); fireEvent.click(screen.getByRole('checkbox', { name: /方向 B/ }));
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
    const approve = await screen.findByRole('button', { name: '批准并继续' }, { timeout: 12000 });
    expect(existsSync(join(workspace, 'proof.txt'))).toBe(false);
    expect(requests).toHaveLength(2);
    const seenInput = JSON.stringify(requests[1]?.messages);
    expect(seenInput).toContain('A, B'); expect(seenInput).toContain('USE_GUIDANCE_MARKER');
    fireEvent.click(approve);
    await waitFor(() => expect(events.some(e => e.type === 'loop_end')).toBe(true), { timeout: 12000 });
    await Promise.all(service.exits.values());
    expect(readFileSync(join(workspace, 'proof.txt'), 'utf8')).toBe('APPROVED_WRITE');
    expect(events.filter(e => e.type === 'loop_end')).toMatchObject([{ isError: false }]);
    expect(service.children.size).toBe(0);
    if (process.env.TRYLO_INTERACTION_PROOF_DIR) writeFileSync(join(process.env.TRYLO_INTERACTION_PROOF_DIR, 'interaction-ui-live.json'), JSON.stringify({
      requests: requests.length, streamedBeforeRelease: true, questionSubmitted: true, approvalClicked: true,
      writeBeforeApproval: false, fileReadback: 'APPROVED_WRITE', guidanceSeenByProvider: true,
      terminals: events.filter(e => e.type === 'loop_end').length, processesRemaining: service.children.size, nativeWindow: false,
    }, null, 2));
  } finally {
    if (process.env.TRYLO_INTERACTION_PROOF_DIR) writeFileSync(join(process.env.TRYLO_INTERACTION_PROOF_DIR, 'interaction-checkpoint.json'), JSON.stringify({
      requests: requests.length, events: events.map(e => e.type), stderr: service.stderr,
      unclassifiedWire: service.wire.filter(line => { try { return !(JSON.parse(line) as { type?: string }).type; } catch { return true; } }),
      wireTypes: service.wire.map(line => { try { return (JSON.parse(line) as { type?: string }).type; } catch { return 'invalid'; } }),
      processesBeforeCleanup: service.children.size,
    }, null, 2));
    release(); await act(async () => { await controller.stop(); await service.dispose(); }); view.unmount(); server.closeAllConnections(); server.close();
  }
}, 60000);
