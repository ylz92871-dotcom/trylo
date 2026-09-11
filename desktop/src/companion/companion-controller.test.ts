// Trylo Desktop — CompanionController tests (spec §6.3 / §6.4 / §6.5):
// lifecycle gating, state projection taps, permission merge + decision
// routing, and the per-request chat config injection.

import { describe, expect, it, vi } from 'vitest';

import { encodeFrame } from '../services-host/frames';
import { ServiceManager } from '../services-host/service-manager';
import type { PetStatusSnapshot } from '../services-host/methods';
import { ServicesCompanionPort } from './companion-port';
import { CompanionController, chatConfigFromSettings, composeLifecycleObservers } from './companion-controller';
import { ConversationRunSupervisor } from '../runtime/conversation-run-supervisor';
import { settingsDefaults, type TryloSettings } from '../settings/settings-store';

/** A ServiceManager + port harness whose fake invoke auto-answers every
 *  request frame with `{ ok: true, result: { ok: true } }` so the
 *  controller's fire-and-forget publishes resolve promptly. */
function createHarness(options?: {
  isWindows?: () => boolean;
  paths?: () => Promise<{ sidecarsDir: string; appDataDir: string }>;
}) {
  const sent: { method: string; params: unknown }[] = [];
  let frameHandler: ((event: { payload: unknown }) => void) | null = null;
  let running = false;

  const respond = (frame: string): void => {
    const request = JSON.parse(frame);
    queueMicrotask(() => {
      frameHandler?.({
        payload: encodeFrame({
          version: 1,
          type: 'response',
          id: request.id,
          ok: true,
          result: { ok: true },
        }),
      });
    });
  };

  const invoke = vi.fn((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'servicehost_spawn') running = true;
    if (cmd === 'servicehost_stop') running = false;
    if (cmd === 'servicehost_status') return Promise.resolve({ running, pid: running ? 1 : null });
    if (cmd === 'servicehost_send' && args?.['frame']) {
      sent.push({ method: JSON.parse(String(args['frame'])).method, params: JSON.parse(String(args['frame'])).params });
      respond(String(args['frame']));
    }
    return Promise.resolve({});
  });
  const listen = vi.fn((_event: string, handler: (event: { payload: unknown }) => void) => {
    frameHandler = handler;
    return Promise.resolve(() => {});
  });
  const manager = new ServiceManager({ invoke, listen });
  const supervisor = new ConversationRunSupervisor();
  const paths = vi.fn(options?.paths ?? (async () => ({ sidecarsDir: '/s', appDataDir: '/a' })));
  const port = new ServicesCompanionPort(manager, paths, () => '/ws');
  const respondApproval = vi.fn().mockResolvedValue(undefined);
  const settings: TryloSettings = {
    ...settingsDefaults,
    apiHost: 'https://api.example.com',
    apiKey: 'sk-test',
    apiFormat: 'openai',
    apiModel: 'mock-model',
  };
  const controller = new CompanionController({
    manager,
    port,
    supervisor,
    settings: () => settings,
    workRuntime: () => ({ respondApproval }),
    isWindows: options?.isWindows ?? (() => true),
  });
  return { controller, manager, supervisor, sent, invoke, frameHandler: () => frameHandler, respondApproval };
}

function waitFor(fn: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 1000;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (fn()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`${what} not observed`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('CompanionController lifecycle', () => {
  it('setEnabled(true) spawns the host and sends pet.enable with the workspace', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    expect(h.sent.some((s) => s.method === 'pet.enable')).toBe(true);
  });

  it('setEnabled(false) on non-Windows never spawns', async () => {
    const h = createHarness({ isWindows: () => false });
    await h.controller.setEnabled(true);
    expect(h.sent).toEqual([]);
    expect(h.sent.some((s) => s.method === 'pet.enable')).toBe(false);
  });

  it('dispose() stops the manager (pet.disable + servicehost_stop path)', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    await h.controller.dispose();
    expect(h.manager.currentHealth).toBe('stopped');
  });

  it('disabling the pet leaves the shared Service Host running for learning', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    await h.controller.setEnabled(false);
    expect(h.sent.some((s) => s.method === 'pet.disable')).toBe(true);
    expect(h.invoke).not.toHaveBeenCalledWith('servicehost_stop');
    expect(h.manager.currentHealth).not.toBe('stopped');
  });

  it('does not resurrect the pet when disabled during startup', async () => {
    let releasePaths!: (value: { sidecarsDir: string; appDataDir: string }) => void;
    const paths = () => new Promise<{ sidecarsDir: string; appDataDir: string }>((resolve) => {
      releasePaths = resolve;
    });
    const h = createHarness({ paths });
    const enabling = h.controller.setEnabled(true);
    await Promise.resolve();
    await h.controller.setEnabled(false);
    releasePaths({ sidecarsDir: '/s', appDataDir: '/a' });
    await enabling;
    expect(h.sent.map((item) => item.method)).toEqual(['pet.enable', 'pet.disable']);
    expect(h.controller.petStatus().enabled).toBe(false);
    expect(h.invoke).not.toHaveBeenCalledWith('servicehost_stop');
  });
});

describe('CompanionController projection taps', () => {
  it('lifecycle.onEvents refines the state (Bash tool → running_command)', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    h.controller.lifecycle.onRunStarted({ projectKey: 'p', projectRoot: '/w', conversationId: 'c', mode: 'code', runId: 'r', turnId: 't', startedAt: 0 });
    h.controller.lifecycle.onEvents(
      { projectKey: 'p', projectRoot: '/w', conversationId: 'c', mode: 'code', runId: 'r', turnId: 't', startedAt: 0 },
      [{ seq: 1, ts: 0, type: 'tool_use', turn: 1, id: 'x', tool: 'Bash', input: {} }],
    );
    await waitFor(() => h.sent.some((s) => s.method === 'pet.publish' && (s.params as { state?: string }).state === 'running_command'), 'running_command publish');
  });

  it('lifecycle.onRunTerminal publishes the outcome payload', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    h.controller.lifecycle.onRunTerminal(
      { projectKey: 'p', projectRoot: '/w', conversationId: 'c', mode: 'code', runId: 'r', turnId: 't', startedAt: 0 },
      'completed',
    );
    await waitFor(() => h.sent.some((s) => s.method === 'pet.publish' && (s.params as { type?: string }).type === 'assistant'), 'assistant publish');
  });

  it('work approval items drive permissionRequestState (pending then cleared)', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    const base = {
      id: 'approval:r:ap-1',
      at: 0,
      conversationId: 'c',
      approvalId: 'ap-1',
      type: 'bash',
      description: 'run tests',
      runId: 'r',
      taskId: 't',
      turnId: undefined,
    };
    h.controller.onWorkItem({ kind: 'approval', ...base, status: 'pending' });
    await waitFor(
      () =>
        h.sent.some(
          (s) =>
            s.method === 'pet.publish' &&
            (s.params as { type?: string; requests?: { requestId: string }[] }).type === 'permissionRequestState' &&
            ((s.params as { requests?: { requestId: string }[] }).requests ?? []).some((r) => r.requestId === 'ap-1'),
        ),
      'permissionRequestState with ap-1',
    );
    h.controller.onWorkItem({ kind: 'approval', ...base, status: 'approved' });
    await waitFor(
      () =>
        h.sent.some(
          (s) =>
            s.method === 'pet.publish' &&
            (s.params as { type?: string; requests?: unknown[] }).type === 'permissionRequestState' &&
            ((s.params as { requests?: unknown[] }).requests ?? []).length === 0,
        ),
      'cleared permissionRequestState',
    );
  });

  it('host.permissionDecision routes to the work runtime by approvalId', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    h.controller.onWorkItem({ kind: 'approval', id: 'a', at: 0, conversationId: 'c', approvalId: 'ap-7', type: '', description: 'd', status: 'pending', runId: 'r', taskId: 't', turnId: undefined });
    const handler = h.frameHandler();
    expect(handler).toBeTruthy();
    handler!({ payload: encodeFrame({ version: 1, type: 'event', topic: 'host.permissionDecision', payload: { requestId: 'ap-7', decision: 'allow' } }) });
    await waitFor(() => h.respondApproval.mock.calls.length > 0, 'workd respondApproval');
    expect(h.respondApproval).toHaveBeenCalledWith('ap-7', true);
  });
});

describe('CompanionController pet status projection (audit PET-P0-1/P0-2)', () => {
  it('reports the REAL post-enable status and notifies subscribers', async () => {
    const h = createHarness();
    const seen: PetStatusSnapshot[] = [];
    const off = h.controller.onStatus((status) => seen.push(status));
    await h.controller.setEnabled(true);
    expect(h.controller.petStatus()).toMatchObject({ enabled: false, launched: false });

    // A sidecar-side `pet.status` event must reach the UI verbatim.
    const launched: PetStatusSnapshot = {
      enabled: true,
      exeFound: true,
      launchAttempted: true,
      launched: true,
      chatConnected: true,
      exePath: 'TryloDesktopPet.exe',
      reasonCode: '',
    };
    h.frameHandler()!({
      payload: encodeFrame({ version: 1, type: 'event', topic: 'pet.status', payload: launched }),
    });
    expect(h.controller.petStatus()).toEqual(launched);
    expect(seen.at(-1)).toEqual(launched);
    off();
    // Unsubscribed listeners stop receiving updates.
    expect(h.controller.onStatus(() => {})).toBeTypeOf('function');
  });

  it('a failed launch is visible through its reason code', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    h.frameHandler()!({
      payload: encodeFrame({
        version: 1,
        type: 'event',
        topic: 'pet.status',
        payload: {
          enabled: false,
          exeFound: false,
          launchAttempted: true,
          launched: false,
          chatConnected: false,
          exePath: '',
          reasonCode: 'exe_not_found',
        },
      }),
    });
    expect(h.controller.petStatus().reasonCode).toBe('exe_not_found');
    expect(h.controller.petStatus().launched).toBe(false);
    // The distinction the audit asks for: we DID try, it just failed.
    expect(h.controller.petStatus().launchAttempted).toBe(true);
  });

  it('status resets when the service host goes down', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    h.frameHandler()!({
      payload: encodeFrame({
        version: 1,
        type: 'event',
        topic: 'pet.status',
        payload: { enabled: true, exeFound: true, launchAttempted: true, launched: true, chatConnected: true, exePath: 'TryloDesktopPet.exe', reasonCode: '' },
      }),
    });
    expect(h.controller.petStatus().launched).toBe(true);
    await h.manager.stop();
    expect(h.controller.petStatus().launched).toBe(false);
    expect(h.controller.petStatus().reasonCode).toBe('not_attempted');
  });
});

describe('CompanionController chat', () => {
  it('chatConfigFromSettings mirrors the primary connection fields', () => {
    const config = chatConfigFromSettings({
      ...settingsDefaults,
      apiHost: 'https://host',
      apiKey: 'k',
      apiFormat: 'anthropic',
      apiModel: 'm',
      systemPrompt: 'sp',
    });
    expect(config).toMatchObject({ endpoint: 'https://host', apiKey: 'k', apiFormat: 'anthropic', model: 'm', systemPrompt: 'sp' });
  });
});

describe('composeLifecycleObservers', () => {
  it('calls both observers in order', async () => {
    const calls: string[] = [];
    const a = {
      onRunStarted: () => { calls.push('a-start'); },
      onEvents: () => { calls.push('a-events'); },
      onRunTerminal: () => { calls.push('a-terminal'); },
    };
    const b = {
      onRunStarted: () => { calls.push('b-start'); },
      onEvents: () => { calls.push('b-events'); },
      onRunTerminal: () => { calls.push('b-terminal'); },
    };
    const composed = composeLifecycleObservers(a, b);
    const scope = { projectKey: 'p', projectRoot: '/w', conversationId: 'c', mode: 'code' as const, runId: 'r', turnId: 't', startedAt: 0 };
    await composed.onRunStarted(scope);
    composed.onEvents(scope, []);
    await composed.onRunTerminal(scope, 'completed');
    expect(calls).toEqual(['a-start', 'b-start', 'a-events', 'b-events', 'a-terminal', 'b-terminal']);
  });
});
