// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { NodeProcessFixture } from './cli-node-process.fixture';
import type { ProcessService } from './process-service';
import type { LoopEvent } from './loop-events';
import type { PermissionLevel } from '../permission/permission-policy';
import { CodePermissionRegistry } from '../runtime/code-permission-registry';

const h = vi.hoisted(() => ({ service: null as ProcessService | null }));
vi.mock('./index', () => ({ hostAdapter: { get process() { return h.service; } } }));
const { startTryloV1 } = await import('./trylo-v1-runner');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1cAAAAASUVORK5CYII=';
const cases: readonly { tool: 'write_file' | 'read_file' | 'run_shell' | 'view_image'; level: PermissionLevel; answer?: boolean }[] = [
  { tool: 'write_file', level: 'workspace_write', answer: true },
  { tool: 'write_file', level: 'workspace_write', answer: false },
  { tool: 'write_file', level: 'ask', answer: true },
  { tool: 'write_file', level: 'unrestricted' },
  { tool: 'write_file', level: 'read_only' },
  { tool: 'read_file', level: 'workspace_write', answer: true },
  { tool: 'read_file', level: 'ask', answer: false },
  { tool: 'read_file', level: 'read_only' },
  { tool: 'run_shell', level: 'ask', answer: true },
  { tool: 'run_shell', level: 'ask', answer: false },
  { tool: 'view_image', level: 'workspace_write', answer: true },
  { tool: 'view_image', level: 'ask', answer: false },
  { tool: 'view_image', level: 'read_only' },
  { tool: 'view_image', level: 'unrestricted' },
];

it.each(cases)('real CLI external $tool under $level (answer=$answer)', async ({ tool, level, answer }) => {
  const root = mkdtempSync(join(tmpdir(), 'trylo-filesystem-authority-'));
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  execFileSync('git', ['init', '--quiet', workspace], { windowsHide: true });
  const target = join(root, tool === 'view_image' ? 'external.png' : 'external.txt');
  const privateText = 'outside-read-fixture-body';
  if (tool === 'read_file') writeFileSync(target, privateText);
  if (tool === 'view_image') writeFileSync(target, Buffer.from(png, 'base64'));
  const args = tool === 'run_shell'
    ? { cwd: root, command: process.platform === 'win32'
      ? "$v = 'shell approved'; [IO.File]::WriteAllText('external.txt', $v); Get-Content 'external.txt'"
      : "printf 'shell approved' > external.txt; cat external.txt" }
    : { path: target, ...(tool === 'write_file' ? { content: 'write approved' } : {}) };
  const service = new NodeProcessFixture({ ...process.env, TRYLO_HOME: join(root, 'home'),
    TRYLO_MCP_RUNTIME_REGISTRY: undefined, TRYLO_MCP_RUNTIME_MODE: undefined,
    TRYLO_API_KEY: 'local-contract-key', TRYLO_OPENAI_API_KEY: 'local-contract-key' });
  h.service = service;
  const providerBodies: unknown[] = [];
  const server = createServer(async (incoming, outgoing) => {
    let body = ''; for await (const chunk of incoming) body += chunk;
    const input = JSON.parse(body) as { messages: { role: string }[] }; providerBodies.push(input);
    const done = input.messages.some(message => message.role === 'tool');
    const delta = done ? { content: 'DONE' } : { tool_calls: [{ index: 0, id: 'file-authority', type: 'function',
      function: { name: tool, arguments: JSON.stringify(args) } }] };
    outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
    outgoing.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    outgoing.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: done ? 'stop' : 'tool_calls' }] })}\n\n`);
    outgoing.end('data: [DONE]\n\n');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  let pending!: (id: string) => void; const approval = new Promise<string>(done => { pending = done; });
  const registry = new CodePermissionRegistry({ onChange() { const item = registry.list()[0]; if (item) pending(item.requestId); },
    send: async (id, line) => { await service.send(id as never, line); return true; } });
  let finish!: () => void; const exited = new Promise<void>(done => { finish = done; });
  const events: LoopEvent[] = [];
  try {
    await startTryloV1({ cliPath: resolve(process.env.TRYLO_DESKTOP_CLI_ENTRY ?? '../new trylo cli/dist/cmd/trylo/main.js') as never,
      nodeProgram: process.execPath, cwd: workspace as never, permissionLevel: level,
      providerId: 'openai-compatible', endpoint: `http://127.0.0.1:${address.port}/v1`, model: 'local-filesystem-contract',
      prompt: 'Execute the requested tool once and report its result.', onEvents: batch => events.push(...batch), onExit: finish,
      onControlFrame: (frame, processId) => registry.handleControlFrame(frame, {
        processId, projectKey: 'project', conversationId: 'conversation', projectRoot: workspace, permissionLevel: level,
      }) });
    if (answer !== undefined) {
      const id = await Promise.race([approval, exited.then(() => { throw new Error(`CLI exited before approval: ${service.stderr.join('\n')}`); })]);
      expect(registry.list()[0]?.toolName).toBe(tool);
      if (tool !== 'read_file' && tool !== 'view_image') expect(existsSync(target)).toBe(false);
      expect(JSON.stringify(providerBodies)).not.toContain(privateText);
      expect(JSON.stringify(providerBodies)).not.toContain(png);
      expect(await registry.respond(id, answer)).toBe(true);
    }
    await exited; await Promise.all(service.exits.values());
    const allowed = level === 'unrestricted' || answer === true;
    if (tool === 'view_image') expect(JSON.stringify(providerBodies).includes(png)).toBe(allowed);
    else if (tool === 'read_file') expect(JSON.stringify(providerBodies).includes(privateText)).toBe(allowed);
    else {
      expect(existsSync(target)).toBe(allowed);
      if (allowed) expect(readFileSync(target, 'utf8')).toBe(tool === 'run_shell' ? 'shell approved' : 'write approved');
    }
    const results = events.filter(event => event.type === 'tool_result');
    expect(results).toHaveLength(1); expect(results[0]).toMatchObject({ ok: allowed });
    expect(registry.list()).toHaveLength(0); expect(service.children.size).toBe(0);
  } finally {
    await service.dispose(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
