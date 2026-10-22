// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SettingsModal } from '../components/app-shell/SettingsModal';
import { loadSettings, settingsDefaults, type TryloSettings } from '../settings/settings-store';
import { settingsForCodeRun } from '../runtime/conversation-run-supervisor';
import { NodeProcessFixture } from './cli-node-process.fixture';
import type { ProcessService } from './process-service';
import type { FilePath } from './types';
import { CodePermissionRegistry } from '../runtime/code-permission-registry';

const h = vi.hoisted(() => ({ service: null as ProcessService | null }));
vi.mock('./index', () => ({ hostAdapter: { get process() { return h.service; } } }));
vi.mock('../runtime/cli-runtime-guard', () => ({ verifyCliRuntime: vi.fn(async () => ({ ok: true })) }));
vi.mock('../components/app-shell/AppearanceSettings', () => ({ AppearanceSettings: () => null }));
vi.mock('../components/app-shell/WorkToolsSettings', () => ({ WorkToolsSettings: () => null }));
vi.mock('../components/app-shell/SkillsModal', () => ({ SkillsModal: () => null }));
const { CodeRunController } = await import('../runtime/code-run-controller');
afterEach(() => { cleanup(); window.localStorage.clear(); });

it.each(['chat', 'responses'] as const)('UI save → real CLI → %s wire sends high, low and no override', async wire => {
  const root = mkdtempSync(join(tmpdir(), 'trylo-effort-'));
  const home = join(root, 'home'), workspace = join(root, 'workspace') as FilePath;
  mkdirSync(home); mkdirSync(workspace);
  execFileSync('git', ['init', '--quiet', workspace], { windowsHide: true });
  const requests: { path: string; effort?: string; summary?: string }[] = [];
  const server = createServer((incoming, outgoing) => {
    let text = ''; incoming.on('data', chunk => { text += String(chunk); });
    incoming.on('end', () => {
      const body = JSON.parse(text) as { reasoning_effort?: string; reasoning?: { effort?: string; summary?: string } };
      requests.push({ path: incoming.url ?? '', effort: body.reasoning_effort ?? body.reasoning?.effort, summary: body.reasoning?.summary });
      outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
      outgoing.end(wire === 'chat'
        ? 'data: {"choices":[{"delta":{"content":"EFFORT_WIRE_OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        : 'event: response.output_text.delta\ndata: {"output_index":0,"delta":"EFFORT_WIRE_OK"}\n\nevent: response.completed\ndata: {"response":{"status":"completed"}}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test endpoint');
  const endpoint = `http://127.0.0.1:${address.port}/v1/${wire === 'chat' ? 'chat/completions' : 'responses'}`;
  const providerId = wire === 'chat' ? 'openai-compatible' : 'local-responses';
  if (wire === 'responses') writeFileSync(join(home, 'providers.json'), JSON.stringify({ version: 1,
    providers: [{ id: providerId, kind: 'openai-responses', endpoint, model: 'local-model', reasoning: true }] }));
  const service = new NodeProcessFixture({ ...process.env, TRYLO_HOME: home, TRYLO_API_KEY: '', TRYLO_OPENAI_API_KEY: 'local-test-only' });
  h.service = service;
  const controller = new CodeRunController({ projectKey: 'ws', conversationId: wire,
    permissions: new CodePermissionRegistry({ onChange() {}, send: async () => true }), onChange() {} });
  const initial = { ...settingsDefaults, cliRuntimeProtocol: 'trylo-v1' as const, apiFormat: 'openai' as const,
    apiModel: 'local-model', apiHost: endpoint, providerId, apiKey: 'local-test-only',
    cliPath: process.env.TRYLO_DESKTOP_CLI_ENTRY ?? resolve('../new trylo cli/dist/cmd/trylo/main.js') };
  let sending = Promise.resolve();
  function Harness() {
    const [settings, setSettings] = useState<TryloSettings>(initial), [open, setOpen] = useState(true);
    async function send() {
      let done: () => void = () => {};
      const terminal = new Promise<void>(resolve => { done = resolve; });
      await controller.run({ prompt: 'Reply EFFORT_WIRE_OK.', codeMode: 'agent', permissionLevel: 'workspace_write', priorMessages: [],
        settings: { ...settingsForCodeRun(loadSettings(), workspace), cliNodeProgram: process.env.TRYLO_DESKTOP_NODE_PROGRAM ?? process.execPath },
        onEvents: events => { if (events.some(event => event.type === 'loop_end')) done(); } });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([terminal, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`No CLI terminal; ${service.stderr.slice(-3).join(' ')}`)), 45000);
        })]);
        await Promise.all(service.exits.values());
      } finally { clearTimeout(timer); }
    }
    return <><button onClick={() => setOpen(true)}>Open settings</button><button onClick={() => { sending = send(); }}>Send</button>
      <SettingsModal open={open} initial={settings} onClose={() => setOpen(false)} onSave={next => setSettings(next)} /></>;
  }
  render(<Harness />);
  try {
    for (const effort of ['high', 'low', '']) {
      if (!screen.queryByRole('combobox', { name: '思考强度' })) fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
      fireEvent.change(screen.getByRole('combobox', { name: '思考强度' }), { target: { value: effort } });
      fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
      fireEvent.click(screen.getByRole('button', { name: /^Send$/ }));
      await sending;
    }
    expect(requests.map(request => request.effort), JSON.stringify({ argv: service.argv,
      stderr: service.stderr, frames: service.wire.slice(-8) })).toEqual(['high', 'low', undefined]);
    expect(requests.every(request => request.path === new URL(endpoint).pathname)).toBe(true);
    if (wire === 'responses') expect(requests.map(request => request.summary)).toEqual(['auto', 'auto', 'auto']);
    expect(service.children.size).toBe(0);
    expect(service.argv.some(args => args.includes('--resume'))).toBe(true);
    if (process.env.TRYLO_SETTINGS_PROOF_DIR) writeFileSync(join(process.env.TRYLO_SETTINGS_PROOF_DIR, `reasoning-${wire}-wire.json`),
      JSON.stringify({ requests, resumed: true, processesRemaining: service.children.size }, null, 2));
  } finally { await controller.stop(); await service.dispose(); server.closeAllConnections(); server.close(); }
}, 150000);
