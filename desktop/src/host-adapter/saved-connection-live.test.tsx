// @vitest-environment jsdom
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SettingsModal } from '../components/app-shell/SettingsModal';
import { connectionFields, loadSettings, saveSettings, settingsDefaults, type TryloSettings } from '../settings/settings-store';
import { conversationModelsAfterSettingsSave, settingsForConversation, setConversationChoice } from '../settings/conversation-models';
import { NodeProcessFixture } from './cli-node-process.fixture';
import type { ProcessService } from './process-service';
import type { FilePath } from './types';
import type { LoopEvent } from './loop-events';
import { CodePermissionRegistry } from '../runtime/code-permission-registry';

const h = vi.hoisted(() => ({ service: null as ProcessService | null }));
vi.mock('./index', () => ({ hostAdapter: { get process() { return h.service; } } }));
vi.mock('../runtime/cli-runtime-guard', () => ({ verifyCliRuntime: vi.fn(async () => ({ ok: true })) }));
vi.mock('../components/app-shell/AppearanceSettings', () => ({ AppearanceSettings: () => null }));
vi.mock('../components/app-shell/WorkToolsSettings', () => ({ WorkToolsSettings: () => null }));
vi.mock('../components/app-shell/SkillsModal', () => ({ SkillsModal: () => null }));
const { CodeRunController } = await import('../runtime/code-run-controller');

it('saving OpenAI in the real modal survives two actual CLI sends and reopening settings', async () => {
  window.localStorage.clear();
  const root = mkdtempSync(join(tmpdir(), 'trylo-saved-connection-'));
  const home = join(root, 'home'), workspace = join(root, 'workspace') as FilePath;
  mkdirSync(home); mkdirSync(workspace); writeFileSync(join(workspace, 'package.json'), '{}');
  // Keep project discovery inside this tiny fixture even when TEMP is under
  // the checkout (for example when the system drive has no free space).
  execFileSync('git', ['init', '--quiet', workspace], { windowsHide: true });
  const requests: { path: string; model: string; hasChatMessages: boolean }[] = [];
  const server = createServer((incoming, outgoing) => {
    let text = ''; incoming.on('data', chunk => { text += String(chunk); });
    incoming.on('end', () => {
      const body = JSON.parse(text) as { model: string; messages?: unknown[] };
      requests.push({ path: incoming.url ?? '', model: body.model, hasChatMessages: Array.isArray(body.messages) });
      outgoing.writeHead(200, { 'content-type': 'text/event-stream' });
      outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'OPENAI_CONNECTION_OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test endpoint');
  const service = new NodeProcessFixture({ ...process.env, TRYLO_HOME: home, TRYLO_API_KEY: '', TRYLO_OPENAI_API_KEY: '' });
  h.service = service;
  const permissions = new CodePermissionRegistry({ onChange() {}, send: async () => true });
  const controller = new CodeRunController({ projectKey: 'ws', conversationId: 'active', permissions, onChange() {} });
  const oldProfile = { id: 'old', name: 'Old', ...connectionFields(settingsDefaults),
    apiFormat: 'anthropic' as const, apiHost: 'http://old.invalid', apiModel: 'old-model' };
  const initial = { ...settingsDefaults, ...connectionFields(oldProfile), modelProfiles: [oldProfile], activeModelProfileId: 'old',
    cliRuntimeProtocol: 'trylo-v1' as const, cliPath: (process.env.TRYLO_DESKTOP_CLI_ENTRY ?? resolve('../new trylo cli/dist/cmd/trylo/main.js')) };
  saveSettings(initial);
  let models = setConversationChoice({}, 'ws', 'active', { kind: 'profile', id: 'old' });
  models = setConversationChoice(models, 'ws', 'other', { kind: 'profile', id: 'old' });
  let sending = Promise.resolve();
  const events: LoopEvent[] = [];
  let stage = 'ready';
  const checkpoint = (value: string) => {
    stage = value;
    if (process.env.TRYLO_SETTINGS_PROOF_DIR) writeFileSync(join(process.env.TRYLO_SETTINGS_PROOF_DIR, 'live-checkpoint.json'),
      JSON.stringify({ stage, requests, terminalCount: events.filter(event => event.type === 'loop_end').length,
        processesRemaining: service.children.size, stderr: service.stderr.map(line => line.replaceAll('local-test-only', '[test-key]')) }, null, 2));
  };
  function Harness() {
    const [settings, setSettings] = useState<TryloSettings>(initial);
    const [open, setOpen] = useState(true);
    const send = async () => {
      checkpoint(`send-${requests.length + 1}-starting`);
      const stored = loadSettings(); setSettings(stored);
      const run = settingsForConversation(stored, 'ws', 'active', models);
      let finish: () => void = () => {};
      const terminal = new Promise<void>(done => { finish = done; });
      await controller.run({ prompt: 'Reply with the marker.', codeMode: 'agent', permissionLevel: 'workspace_write', priorMessages: [],
        settings: { ...run, cliPath: run.cliPath as FilePath, cliNodeProgram: process.execPath, cwd: workspace },
        onEvents: batch => { events.push(...batch); if (batch.some(event => event.type === 'loop_end')) finish(); } });
      checkpoint(`send-${requests.length}-launched`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([terminal, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`No terminal event at ${stage}`)), 15000);
        })]);
        await Promise.all(service.exits.values());
        checkpoint(`send-${requests.length}-finished`);
      } finally { clearTimeout(timer); }
    };
    return <><output data-testid="display-format">{settings.apiFormat}</output>
      <button onClick={() => { sending = send(); }}>Send probe</button><button onClick={() => setOpen(true)}>Open settings</button>
      <SettingsModal open={open} initial={settings} onClose={() => setOpen(false)} onSave={(next, intent) => {
        models = conversationModelsAfterSettingsSave(settings, next, models, 'ws', 'active', intent); setSettings(next);
      }} /></>;
  }
  const view = render(<Harness />);
  try {
    fireEvent.change(screen.getByLabelText("API 协议"), { target: { value: 'openai' } });
    fireEvent.change(screen.getByLabelText("服务商标识"), { target: { value: 'openai-compatible' } });
    fireEvent.change(screen.getByLabelText("服务地址"), { target: { value: `http://127.0.0.1:${address.port}/v1` } });
    fireEvent.change(screen.getByLabelText("模型名称"), { target: { value: 'saved-openai-model' } });
    fireEvent.change(screen.getByLabelText("API 密钥"), { target: { value: 'local-test-only' } });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    const saved = loadSettings();
    for (let turn = 0; turn < 2; turn++) {
      fireEvent.click(screen.getByRole('button', { name: 'Send probe' }));
      await sending;
      expect(connectionFields(loadSettings())).toEqual(connectionFields(saved));
      expect(screen.getByTestId('display-format')).toHaveTextContent('openai');
    }
    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }));
    expect(screen.getByLabelText("API 协议")).toHaveValue('openai');
    // A pre-fix conversation may still hold the stale choice. Re-saving the
    // already-correct form must apply it without making the user retype it.
    models = setConversationChoice(models, 'ws', 'active', { kind: 'profile', id: 'old' });
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send probe' }));
    await sending;
    expect(requests).toEqual(Array.from({ length: 3 }, () => ({ path: '/v1/chat/completions', model: 'saved-openai-model', hasChatMessages: true })));
    expect(events.filter(event => event.type === 'loop_end')).toMatchObject([{ isError: false }, { isError: false }, { isError: false }]);
    expect(service.children.size).toBe(0);
    expect(settingsForConversation(saved, 'ws', 'other', models).apiFormat).toBe('anthropic');
    if (process.env.TRYLO_SETTINGS_PROOF_DIR) writeFileSync(join(process.env.TRYLO_SETTINGS_PROOF_DIR, 'saved-connection-live.json'),
      JSON.stringify({ requests, savedFormat: saved.apiFormat, loadedFormat: loadSettings().apiFormat,
        activeChoice: models.ws?.active, otherChoice: models.ws?.other, terminalCount: events.filter(event => event.type === 'loop_end').length,
        resumed: service.argv.some(args => args.includes('--resume')), processesRemaining: service.children.size }, null, 2));
  } finally { checkpoint(stage + '-cleanup'); await controller.stop(); await service.dispose(); view.unmount(); window.localStorage.clear(); server.closeAllConnections(); server.close(); }
}, 45000);
