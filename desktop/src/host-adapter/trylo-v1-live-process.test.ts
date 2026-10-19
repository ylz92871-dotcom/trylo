// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { NodeProcessFixture } from './cli-node-process.fixture';
import type { ProcessService } from './process-service';
import type { FilePath } from './types';
import type { LoopEvent } from './loop-events';
import type { ThinkingMessage, TextMessage } from '../components/chat/types';
import { CodePermissionRegistry } from '../runtime/code-permission-registry';
import { applyEvents } from '../components/chat/events';
import { computeFileChange } from '../components/chat/file-change';

const h = vi.hoisted(() => ({ service: null as ProcessService | null }));
vi.mock('./index', () => ({ hostAdapter: { get process() { return h.service; } } }));
// Round-3 P1-10: this suite replaces the process bridge with a Node fixture
// but has no Tauri fs bridge, so the pre-spawn runtime guard (which stats
// the entry) would block every run as `not_found`. The guard itself is
// proved by cli-runtime-guard.test.ts with an injected probe; here it stays
// out of the way of the live run-through.
vi.mock('../runtime/cli-runtime-guard', () => ({
  verifyCliRuntime: vi.fn(async () => ({ ok: true })),
  resetCliRuntimeGuardForTests: vi.fn(),
}));
const { CodeRunController } = await import('../runtime/code-run-controller');
const cli = resolve(process.env.TRYLO_DESKTOP_CLI_ENTRY ?? '../new trylo cli/dist/cmd/trylo/main.js') as FilePath;
let root: string;
let workspace: FilePath;
let home: string;
let service: NodeProcessFixture;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'trylo-desktop-controller-'));
  workspace = join(root, 'workspace') as FilePath;
  home = join(root, 'home');
  mkdirSync(workspace);
  mkdirSync(home);
  writeFileSync(join(workspace, 'package.json'), '{"name":"desktop-controller-proof"}');
  service = new NodeProcessFixture({ ...process.env, TRYLO_HOME: home, USERPROFILE: home, HOME: home,
    TRYLO_API_KEY: '', TRYLO_OPENAI_API_KEY: '' });
  h.service = service;
});
afterEach(async () => { await service.dispose(); rmSync(root, { recursive: true, force: true }); });

function deferred<T>() {
  let resolveValue: (value: T) => void = () => undefined;
  const promise = new Promise<T>(resolve => { resolveValue = resolve; });
  return { promise, resolve: resolveValue };
}

async function waitForApproval(pending: Promise<string>, terminal: Promise<void>): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, terminal.then(() => { throw new Error('CLI ended before requesting approval; inspect live-model-stream.ndjson'); }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('No approval frame within 60s')), 60_000); })]);
  } finally { clearTimeout(timer); }
}

function setup() {
  const pending = deferred<string>();
  const registry = new CodePermissionRegistry({ onChange: () => {
    const request = registry.list()[0];
    if (request) pending.resolve(request.requestId);
  }, send: async (id, line) => { await service.send(id as never, line); return true; } });
  const controller = new CodeRunController({ projectKey: 'p', conversationId: 'c', onChange: () => undefined, permissions: registry });
  return { controller, registry, pending };
}

function request(events: LoopEvent[], terminal: ReturnType<typeof deferred<void>>, providerId = 'fixture-write') {
  return { prompt: 'write and verify', codeMode: 'agent' as const, permissionLevel: 'ask' as const, priorMessages: [],
    settings: { cliPath: cli, cliNodeProgram: process.execPath, cwd: workspace, cliRuntimeProtocol: 'trylo-v1' as const, providerId },
    onEvents: (batch: readonly LoopEvent[]) => { events.push(...batch); if (batch.some(e => e.type === 'loop_end')) terminal.resolve(); },
  };
}

it('production controller, registry, CLI, journal and chat reducer complete two real subprocess turns', async () => {
  const { controller, registry, pending } = setup();
  const events: LoopEvent[] = [];
  const first = deferred<void>();
  await controller.run(request(events, first));
  const requestId = await pending.promise;
  expect(existsSync(join(workspace, 'fixture-output.txt'))).toBe(false);
  expect(registry.list()[0]).toMatchObject({ toolName: 'write_file', input: { path: 'fixture-output.txt' } });
  expect(await registry.respond(requestId, true)).toBe(true);
  await first.promise;
  await Promise.all(service.exits.values());
  expect(readFileSync(join(workspace, 'fixture-output.txt'), 'utf8')).toBe('the fixture wrote this line');
  expect(controller.getViewState().running).toBe(false);
  const written = applyEvents([], events).find(m => m.kind === 'tool' && m.tool === 'Write');
  expect(written).toMatchObject({ kind: 'tool', status: 'done', input: { file_path: 'fixture-output.txt' } });
  if (written?.kind === 'tool') expect(computeFileChange(written.tool, written.input, written.outputContent)).toMatchObject({ path: 'fixture-output.txt', additions: 1 });
  const journals = readdirSync(join(home, 'sessions'));
  const second = deferred<void>();
  await controller.run({ ...request(events, second), permissionLevel: 'workspace_write' });
  await second.promise;
  await Promise.all(service.exits.values());
  const runs = service.argv.filter(args => args.includes('run'));
  expect(runs[0]).toContain('--session');
  expect(runs[1]).toContain('--resume');
  expect(readdirSync(join(home, 'sessions'))).toEqual(journals);
  expect(events.filter(e => e.type === 'loop_end')).toHaveLength(2);
  expect(service.children.size).toBe(0);
}, 25_000);

it('denying through the production registry leaves disk untouched and releases Desktop busy state', async () => {
  const { controller, registry, pending } = setup();
  const events: LoopEvent[] = [];
  const terminal = deferred<void>();
  await controller.run(request(events, terminal));
  expect(await registry.respond(await pending.promise, false)).toBe(true);
  await terminal.promise;
  await Promise.all(service.exits.values());
  expect(existsSync(join(workspace, 'fixture-output.txt'))).toBe(false);
  expect(events.find(e => e.type === 'loop_end')).toMatchObject({ isError: true });
  expect(controller.getViewState().running).toBe(false);
  expect(registry.list()).toHaveLength(0);
}, 15_000);

it('startup auth failure releases Desktop busy state before any task runs', async () => {
  const { controller } = setup();
  await expect(controller.run(request([], deferred<void>(), 'openai-compatible'))).rejects.toThrow(/未登录/);
  expect(controller.getViewState()).toMatchObject({ running: false, sendable: true, error: true });
  expect(service.argv.some(args => args.includes('run'))).toBe(false);
}, 15_000);

it('stopping during approval retracts the request, releases the process and rejects a stale click', async () => {
  const { controller, registry, pending } = setup();
  await controller.run(request([], deferred<void>()));
  const requestId = await pending.promise;
  await controller.stop();
  expect(registry.list()).toHaveLength(0);
  expect(await registry.respond(requestId, true)).toBe(false);
  expect(existsSync(join(workspace, 'fixture-output.txt'))).toBe(false);
  expect(service.children.size).toBe(0);
  expect(controller.getViewState().running).toBe(false);
}, 15_000);

it('local model stream preserves public summaries, progress, patch effects and the final answer end to end', async () => {
  const requests: { messages: { role: string; content?: string }[] }[] = [];
  const server = createServer((incoming, outgoing) => {
    let body = '';
    incoming.setEncoding('utf8');
    incoming.on('data', chunk => { body += chunk; });
    incoming.on('end', () => {
      const modelRequest = JSON.parse(body) as typeof requests[number];
      requests.push(modelRequest);
      const results = modelRequest.messages.filter(message => message.role === 'tool').length;
      const summary = ['Let me inspect the file.', 'I will apply the patch.', 'I will report the verified result.'][results];
      const progress = ['Checking the file.', 'Updating the file.', 'DONE'][results];
      const call = results === 0
        ? { id: 'read-proof', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'proof.txt' }) } }
        : results === 1
          ? { id: 'patch-proof', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify({
              patch: '*** Begin Patch\n*** Update File: proof.txt\n@@\n-before\n+after\n*** End Patch',
            }) } }
          : null;
      outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = (value: Record<string, unknown>, finishReason: string | null = null) => {
        outgoing.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: value, finish_reason: finishReason }] })}\n\n`);
      };
      delta({ reasoning_content: summary });
      delta({ content: progress });
      if (call) delta({ tool_calls: [{ index: 0, ...call }] });
      delta({}, call ? 'tool_calls' : 'stop');
      outgoing.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolveValue => server.listen(0, '127.0.0.1', resolveValue));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Local model did not bind a TCP port');
  writeFileSync(join(workspace, 'proof.txt'), 'before\n');
  const { controller, registry, pending } = setup();
  const events: LoopEvent[] = [];
  const terminal = deferred<void>();
  try {
    // This scenario explicitly exercises approval; workspace_write may now
    // auto-allow an in-workspace add/update patch under the current host policy.
    await controller.run({ ...request(events, terminal, 'openai-compatible'), permissionLevel: 'ask',
      prompt: 'Read proof.txt, patch before to after, then report the result.',
      settings: { cliPath: cli, cliNodeProgram: process.execPath, cwd: workspace, cliRuntimeProtocol: 'trylo-v1',
        providerId: 'openai-compatible', apiFormat: 'openai', apiHost: `http://127.0.0.1:${address.port}/v1`,
        apiModel: 'local-contract-model', apiKey: 'local-contract-key', systemPrompt: 'PUBLIC-PROGRESS-CONTRACT',
      },
    });
    const approvalId = await waitForApproval(pending.promise, terminal.promise);
    expect(registry.list()[0]).toMatchObject({ toolName: 'apply_patch' });
    expect(readFileSync(join(workspace, 'proof.txt'), 'utf8')).toBe('before\n');
    expect(await registry.respond(approvalId, true)).toBe(true);
    await terminal.promise;
    await Promise.all(service.exits.values());
    expect(requests).toHaveLength(3);
    expect(requests.every(modelRequest => modelRequest.messages.some(message =>
      message.role === 'system' && message.content?.includes('PUBLIC-PROGRESS-CONTRACT')))).toBe(true);
    expect(readFileSync(join(workspace, 'proof.txt'), 'utf8')).toBe('after\n');
    expect(registry.list()).toHaveLength(0);
    expect(events.filter(event => event.type === 'loop_end')).toMatchObject([{ isError: false, finalResult: 'DONE' }]);
    expect(events.some(event => event.type === 'runtime_warning' && event.code === 'protocol_rejected')).toBe(false);
    const messages = applyEvents([], events);
    const thinking = messages.filter((message): message is ThinkingMessage => message.kind === 'thinking');
    expect(thinking).toHaveLength(3);
    expect(thinking.every(message => !message.partial)).toBe(true);
    expect(new Set(thinking.map(message => message.id)).size).toBe(3);
    expect(messages.filter((message): message is TextMessage => message.kind === 'text').map(message => message.text)).toEqual([
      'Checking the file.', 'Updating the file.', 'DONE',
    ]);
    expect(controller.getViewState().running).toBe(false);
    expect(service.children.size).toBe(0);
  } finally {
    await service.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolveValue, reject) => server.close(error => error ? reject(error) : resolveValue()));
  }
}, 60_000);

it.runIf(process.env.TRYLO_DESKTOP_LIVE === '1')('real configured model writes with approval and remembers in a second process', async () => {
  const { controller, registry, pending } = setup();
  const events: LoopEvent[] = [];
  const first = deferred<void>();
  const settings = { cliPath: cli, cliNodeProgram: process.execPath, cwd: workspace, cliRuntimeProtocol: 'trylo-v1' as const,
    providerId: 'openai-compatible', apiFormat: 'openai' as const, apiHost: process.env.TRYLO_DESKTOP_LIVE_ENDPOINT,
    apiModel: process.env.TRYLO_DESKTOP_LIVE_MODEL, apiKey: process.env.TRYLO_DESKTOP_LIVE_KEY,
  };
  const marker = 'desktop-protocol-20261003-proof';
  let secondToolCalls = -1;
  try {
    await controller.run({ ...request(events, first), settings,
      prompt: `Use write_file to create proof.txt containing exactly ${marker}, no newline. Then use read_file to verify it. Reply DONE. Do not change any other file or use run_shell.`,
    });
    const approval = await waitForApproval(pending.promise, first.promise);
    expect(registry.list()[0]).toMatchObject({ toolName: 'write_file', input: { path: 'proof.txt', content: marker } });
    expect(existsSync(join(workspace, 'proof.txt'))).toBe(false);
    expect(await registry.respond(approval, true)).toBe(true);
    await first.promise;
    await Promise.all(service.exits.values());
    expect(readFileSync(join(workspace, 'proof.txt'), 'utf8')).toBe(marker);
    expect(events.filter(e => e.type === 'loop_end')[0]).toMatchObject({ isError: false });
    const boundary = events.length;
    const second = deferred<void>();
    await controller.run({ ...request(events, second), settings, prompt: 'From our previous turn, give only the exact content you wrote to proof.txt. Do not call tools.' });
    await second.promise;
    await Promise.all(service.exits.values());
    const followup = events.slice(boundary);
    secondToolCalls = followup.filter(e => e.type === 'tool_use').length;
    expect(secondToolCalls).toBe(0);
    expect(followup.find(e => e.type === 'loop_end')).toMatchObject({ isError: false, finalResult: expect.stringContaining(marker) });
    expect(service.children.size).toBe(0);
    expect(controller.getViewState().running).toBe(false);
  } finally {
    const evidence = process.env.TRYLO_DESKTOP_LIVE_EVIDENCE;
    if (evidence) {
      const terminal = events.filter(e => e.type === 'loop_end');
      const path = join(workspace, 'proof.txt');
      writeFileSync(join(evidence, 'live-model-result.json'), JSON.stringify({
        model: settings.apiModel, runtimeEntry: cli, interpreter: process.execPath, terminal, secondToolCalls, processesRemaining: service.children.size,
        file: existsSync(path) ? readFileSync(path, 'utf8') : null,
        approvalRequests: service.wire.filter(line => JSON.parse(line).type === 'control_request').length,
        resumed: service.argv.some(args => args.includes('--resume')),
        commands: service.argv, stderr: service.stderr.map(line => settings.apiKey ? line.replaceAll(settings.apiKey, '<redacted>') : line),
      }, null, 2));
      const redacted = service.wire.map(line => {
        const frame = JSON.parse(line) as Record<string, unknown>;
        return JSON.stringify(frame.type === 'reasoning_delta' ? { ...frame, text: '<redacted>' } : frame);
      });
      writeFileSync(join(evidence, 'live-model-stream.ndjson'), redacted.join('\n') + '\n');
    }
  }
}, 180_000);

it.each(['ask', 'workspace_write', 'unrestricted', 'read_only'] as const)(
  '%s applies the host decision before a real shell process can write', async level => {
    const subdir = join(workspace, 'src'); mkdirSync(subdir);
    const effect = join(subdir, 'shell-proof.txt');
    const server = createServer((incoming, outgoing) => {
      let body = '';
      incoming.on('data', chunk => { body += chunk; });
      incoming.on('end', () => {
        const input = JSON.parse(body) as { messages: { role: string }[] };
        const finished = input.messages.some(message => message.role === 'tool');
        const command = `node -e "require('node:fs').writeFileSync('shell-proof.txt','approved')"`;
        const delta = finished ? { content: 'DONE' } : { tool_calls: [{ index: 0, id: 'host-shell', type: 'function',
          function: { name: 'run_shell', arguments: JSON.stringify({ command, cwd: subdir }) } }] };
        outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
        outgoing.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        outgoing.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finished ? 'stop' : 'tool_calls' }] })}\n\n`);
        outgoing.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>(resolveValue => server.listen(0, '127.0.0.1', resolveValue));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Local fixture did not bind');
    const { controller, registry, pending } = setup();
    const terminal = deferred<void>(); const events: LoopEvent[] = [];
    try {
      await controller.run({ ...request(events, terminal, 'openai-compatible'), permissionLevel: level,
        settings: { cliPath: cli, cliNodeProgram: process.execPath, cwd: workspace, cliRuntimeProtocol: 'trylo-v1',
          providerId: 'openai-compatible', apiFormat: 'openai', apiHost: `http://127.0.0.1:${address.port}/v1`,
          apiModel: 'local-shell-contract', apiKey: 'local-contract-key' } });
      if (level === 'ask' || level === 'workspace_write') {
        const id = await waitForApproval(pending.promise, terminal.promise);
        expect(registry.list()[0]?.toolName).toBe('run_shell');
        expect(existsSync(effect)).toBe(false);
        expect(await registry.respond(id, true)).toBe(true);
      }
      await terminal.promise; await Promise.all(service.exits.values());
      expect(existsSync(effect)).toBe(level !== 'read_only');
      if (level !== 'read_only') expect(readFileSync(effect, 'utf8')).toBe('approved');
      expect(registry.list()).toHaveLength(0);
      expect(service.children.size).toBe(0);
    } finally {
      await service.dispose(); server.closeAllConnections();
      await new Promise<void>(resolveValue => server.close(() => resolveValue()));
    }
  }, 60000);
