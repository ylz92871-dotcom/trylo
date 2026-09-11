// Trylo Desktop — RemoteController tests (migration spec §8.1 / §8.2, arch §7.2/§7.3).
//
// Lifecycle: enable publishes a full snapshot, disable leaves the shared
// Service Host running, dispose stops it, and a Service Host restart re-enables
// the gateway. Routing: every handler name (projects/project/session/task/
// cancel/permission/chat/fun) including the error paths — a failing authority
// answers with an error, never a hang. Projection: work-approval tracking and
// supervisor bumps flow into remote.publish. Status: push events + onDown.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { settingsDefaults } from '../settings/settings-store';
import { emptyWorkspaceHistory } from '../host-adapter/conversation-history';
import { IDLE_CODE_VIEW_STATE } from '../runtime/runtime-types';
import type { ConversationRunSupervisor } from '../runtime/conversation-run-supervisor';
import type { ServiceHealth, ServiceManager } from '../services-host/service-manager';
import type { RemoteAgentStateEvent, RemoteGatewayEvent, RemotePermissionRequestStateEvent, RemotePermissionSummary, RemoteRequestEvent, RemoteRespondParams, RemoteStatusResult } from '../services-host/methods';
import type { ServicesRemotePort } from './remote-port';
import { EMPTY_REMOTE_STATUS } from './remote-port';
import { RemoteController } from './remote-controller';

/** Projection is built in parallel; mocked here so these tests are pure
 *  controller logic. */
const projectionMock = vi.hoisted(() => {
  const approvals = (opts: { code: unknown; work: readonly RemotePermissionSummary[]; now: unknown }): RemotePermissionRequestStateEvent => ({
    type: 'permissionRequestState',
    requests: opts.work,
  });
  return {
    projectBindingState: vi.fn((): RemoteAgentStateEvent | null => ({ type: 'agentState', state: 'idle' })),
    projectLoopEvents: vi.fn((): RemoteGatewayEvent[] => []),
    projectApprovals: vi.fn(approvals),
    buildFullSnapshot: vi.fn((): RemoteGatewayEvent[] => []),
    projectTaskReceipt: vi.fn((): RemoteGatewayEvent[] => [
      { type: 'agentState', state: 'running', detail: 'mock' },
      { type: 'trace', title: 'mock', phase: 'running', at: 0 },
    ]),
    approvals,
  };
});

vi.mock('./remote-projection', () => projectionMock);

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

function createHarness(options: { chatHandle?: boolean } = {}) {
  const responded: RemoteRespondParams[] = [];
  const published: RemoteGatewayEvent[] = [];

  const port = {
    enable: vi.fn(async () => ({ ok: true, enabled: true, running: true, port: 49380, publicUrl: '', tunnelMode: 'off' as const, tunnelRunning: false, reasonCode: '' })),
    disable: vi.fn(async () => ({ ok: true })),
    publish: vi.fn(async (event: RemoteGatewayEvent) => {
      published.push(event);
      return { ok: true };
    }),
    status: vi.fn(async () => EMPTY_REMOTE_STATUS),
    pairingInfo: vi.fn(async () => ({
      pairing: { protocol: 1 as const, service: 'trylo-remote', deviceId: 'd', deviceName: 'Desktop', workspaceName: 'Workspace', baseUrl: 'http://127.0.0.1:49380', token: 't' },
      qrDataUrl: 'data:image/png;base64,x',
    })),
    respond: vi.fn(async (params: RemoteRespondParams) => {
      responded.push(params);
      return { ok: true };
    }),
    emit: vi.fn(async () => ({ ok: true })),
    importIdentity: vi.fn(async () => ({ imported: false, skipped: true })),
  };

  const eventHandlers = new Map<string, (payload: unknown) => void>();
  const healthHandlers = new Set<(health: ServiceHealth) => void>();
  const downHandlers = new Set<() => void>();
  const supervisorListeners = new Set<() => void>();

  const manager = {
    client: {
      request: vi.fn(async () => ({ ok: true })),
      onEvent: vi.fn((topic: string, handler: (payload: unknown) => void) => {
        eventHandlers.set(topic, handler);
        return () => eventHandlers.delete(topic);
      }),
    },
    ensureRunning: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    onHealth: vi.fn((handler: (health: ServiceHealth) => void) => {
      healthHandlers.add(handler);
      return () => healthHandlers.delete(handler);
    }),
    onDown: vi.fn((handler: () => void) => {
      downHandlers.add(handler);
      return () => downHandlers.delete(handler);
    }),
    currentHealth: 'stopped' as ServiceHealth,
  };

  const supervisor = {
    subscribe: vi.fn((listener: () => void) => {
      supervisorListeners.add(listener);
      return () => supervisorListeners.delete(listener);
    }),
    getViewState: vi.fn(() => IDLE_CODE_VIEW_STATE),
    activeCodeRuns: vi.fn(() => []),
    pendingCodePermissions: vi.fn(() => []),
    respondCodePermission: vi.fn(async () => true),
  };

  const workspaces = {
    list: vi.fn(() => [{ id: 'p1', name: 'Project 1' }]),
    activeProjectId: vi.fn(() => 'p1'),
    select: vi.fn(async () => {}),
  };
  const sessions = {
    list: vi.fn(() => [{ id: 's1', title: 'Session 1' }]),
    activeSessionId: vi.fn(() => 's1'),
    select: vi.fn(async () => ({ switching: true })),
  };
  const sendTask = vi.fn(async () => ({}));
  const cancelTask = vi.fn(async () => {});
  const approvals = { decide: vi.fn(async () => true) };
  const artifacts = {
    list: vi.fn(async () => [{ id: 'out/report.docx', name: 'out/report.docx', kind: 'document', size: 1024, modifiedAt: 42 }]),
    read: vi.fn(async (path: string) => ({ name: path.split('/').pop() || 'file', mimeType: 'application/pdf', size: 3, data: 'aGk=' })),
  };
  const chatHandle = options.chatHandle === false ? null : vi.fn(async () => ({ ok: true }));

  const settings = { ...settingsDefaults, apiHost: 'https://api.example.com', apiKey: 'sk-test', apiFormat: 'openai' as const };

  const controller = new RemoteController({
    manager: manager as unknown as ServiceManager,
    port: port as unknown as ServicesRemotePort,
    supervisor: supervisor as unknown as ConversationRunSupervisor,
    settings: () => settings,
    paths: async () => ({ sidecarsDir: '/s', appDataDir: '/a' }),
    isTauri: () => true,
    workspaces,
    sessions,
    sendTask,
    cancelTask,
    approvals: approvals as never,
    artifacts,
    chatHandle: chatHandle as never,
    history: () => emptyWorkspaceHistory(),
    workspaceIndex: () => null,
    currentWorkspace: () => ({ id: 'w1', root: '/w', name: 'Workspace' }),
    conversationKind: () => 'code',
    codePermissions: () => [],
    workApprovals: () => [],
    projectKey: () => 'p1',
    conversationId: () => 'c1',
    mode: () => 'agent',
  });

  return {
    controller,
    manager,
    port,
    supervisor,
    workspaces,
    sessions,
    sendTask,
    cancelTask,
    approvals,
    artifacts,
    chatHandle,
    responded,
    published,
    fireRequest: (request: RemoteRequestEvent) => eventHandlers.get('host.remoteRequest')?.(request),
    fireStatus: (status: RemoteStatusResult) => eventHandlers.get('remote.status')?.(status),
    fireHealth: (health: ServiceHealth) => {
      manager.currentHealth = health;
      for (const handler of [...healthHandlers]) handler(health);
    },
    fireDown: () => {
      for (const handler of [...downHandlers]) handler();
    },
    bumpSupervisor: () => {
      for (const listener of [...supervisorListeners]) listener();
    },
  };
}

beforeEach(() => {
  projectionMock.projectBindingState.mockReset().mockReturnValue({ type: 'agentState', state: 'idle' });
  projectionMock.projectLoopEvents.mockReset().mockReturnValue([]);
  projectionMock.projectApprovals.mockReset().mockImplementation(projectionMock.approvals);
  projectionMock.buildFullSnapshot.mockReset().mockReturnValue([]);
  projectionMock.projectTaskReceipt.mockReset().mockReturnValue([
    { type: 'agentState', state: 'running', detail: 'mock' },
    { type: 'trace', title: 'mock', phase: 'running', at: 0 },
  ]);
});

describe('RemoteController lifecycle', () => {
  it('setEnabled(true) ensures the host, enables the gateway, and publishes the full snapshot', async () => {
    const h = createHarness();
    projectionMock.buildFullSnapshot.mockReturnValue([
      { type: 'projectsState', projects: [{ id: 'p1', name: 'Project 1' }], activeProjectId: 'p1' },
      { type: 'sessionState', activeSessionId: 's1', sessions: [{ id: 's1', title: 'Session 1' }] },
    ]);
    await h.controller.setEnabled(true);
    expect(h.manager.ensureRunning).toHaveBeenCalledWith({ sidecarsDir: '/s', appDataDir: '/a' });
    expect(h.port.enable).toHaveBeenCalledTimes(1);
    expect(h.port.enable).toHaveBeenCalledWith(expect.objectContaining({ workspaceName: 'Workspace', deviceName: '' }));
    await waitFor(() => h.published.some((event) => event.type === 'projectsState'), 'projectsState snapshot publish');
    expect(h.published.some((event) => event.type === 'sessionState')).toBe(true);
    expect(h.controller.status().running).toBe(true);
  });

  it('non-Tauri or disabled is a no-op that reports empty status', async () => {
    const h = createHarness();
    await h.controller.setEnabled(false);
    expect(h.manager.ensureRunning).not.toHaveBeenCalled();
    expect(h.port.enable).not.toHaveBeenCalled();
    expect(h.controller.status()).toEqual(EMPTY_REMOTE_STATUS);
  });

  it('setEnabled(false) disables the gateway but keeps the shared host running', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    await h.controller.setEnabled(false);
    expect(h.port.disable).toHaveBeenCalled();
    expect(h.manager.stop).not.toHaveBeenCalled();
  });

  it('dispose disables the gateway and stops the service host', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    await h.controller.dispose();
    expect(h.port.disable).toHaveBeenCalled();
    expect(h.manager.stop).toHaveBeenCalled();
    await h.controller.dispose();
  });

  it('re-enables the gateway after a service host restart and re-publishes the snapshot', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    expect(h.port.enable).toHaveBeenCalledTimes(1);
    h.fireHealth('restarting');
    h.fireDown();
    h.fireHealth('ready');
    await waitFor(() => h.port.enable.mock.calls.length >= 2, 're-enable after restart');
    await waitFor(() => projectionMock.buildFullSnapshot.mock.calls.length >= 2, 'snapshot after re-enable');
  });
});

describe('RemoteController handler routing', () => {
  it('routes projects → list + activeProjectId', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    h.fireRequest({ requestId: 'r1', name: 'projects', payload: {} });
    await waitFor(() => h.responded.some((r) => r.requestId === 'r1'), 'projects response');
    const call = h.responded.find((r) => r.requestId === 'r1')!;
    expect(call.ok).toBe(true);
    expect(call.result).toEqual({ projects: [{ id: 'p1', name: 'Project 1' }], activeProjectId: 'p1' });
  });

  it('routes project → select + accepted + snapshot re-projection', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    projectionMock.buildFullSnapshot.mockReturnValue([{ type: 'projectsState', projects: [], activeProjectId: 'p2' }]);
    h.fireRequest({ requestId: 'r2', name: 'project', payload: { projectId: 'p2' } });
    await waitFor(() => h.responded.some((r) => r.requestId === 'r2'), 'project response');
    expect(h.workspaces.select).toHaveBeenCalledWith('p2');
    const call = h.responded.find((r) => r.requestId === 'r2')!;
    expect(call.ok).toBe(true);
    expect(call.result).toEqual({ accepted: true, projectId: 'p2' });
    await waitFor(() => projectionMock.buildFullSnapshot.mock.calls.length >= 2, 'snapshot after project select');
  });

  it('routes session → select + accepted/switching + snapshot re-projection', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    h.sessions.select.mockResolvedValue({ switching: true });
    h.fireRequest({ requestId: 'r3', name: 'session', payload: { sessionId: 's2' } });
    await waitFor(() => h.responded.some((r) => r.requestId === 'r3'), 'session response');
    expect(h.sessions.select).toHaveBeenCalledWith('s2');
    const call = h.responded.find((r) => r.requestId === 'r3')!;
    expect(call.ok).toBe(true);
    expect(call.result).toEqual({ accepted: true, switching: true });
    await waitFor(() => projectionMock.buildFullSnapshot.mock.calls.length >= 2, 'snapshot after session select');
  });

  it('routes task → sendTask with explicit scope + accepted', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    h.fireRequest({ requestId: 'r4', name: 'task', payload: { text: 'fix bug' } });
    await waitFor(() => h.responded.some((r) => r.requestId === 'r4'), 'task response');
    expect(h.sendTask).toHaveBeenCalledWith({ projectKey: 'p1', conversationId: 'c1', mode: 'agent', surface: 'code', text: 'fix bug', requestId: 'r4' });
    const call = h.responded.find((r) => r.requestId === 'r4')!;
    expect(call.ok).toBe(true);
    expect(call.result).toEqual({ accepted: true, requestId: 'r4' });
  });

  it("routes task with surface 'work' → sendTask keeps the work surface", async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    h.fireRequest({ requestId: 'r4w', name: 'task', payload: { text: 'make a deck', surface: 'work' } });
    await waitFor(() => h.responded.some((r) => r.requestId === 'r4w'), 'work task response');
    expect(h.sendTask).toHaveBeenCalledWith({ projectKey: 'p1', conversationId: 'c1', mode: 'agent', surface: 'work', text: 'make a deck', requestId: 'r4w' });
    expect(h.responded.find((r) => r.requestId === 'r4w')!.ok).toBe(true);
  });

  it("routes task with bogus surface → sendTask falls back to 'code'", async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    h.fireRequest({ requestId: 'r4b', name: 'task', payload: { text: 'hi', surface: 'team' } });
    await waitFor(() => h.responded.some((r) => r.requestId === 'r4b'), 'bogus surface response');
    expect(h.sendTask).toHaveBeenCalledWith(expect.objectContaining({ surface: 'code' }));
  });

  it('announceTaskSurface publishes the receipt pair and stays silent when disabled', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    h.controller.announceTaskSurface({ surface: 'work', mode: 'agent', profileId: 'work.core.v1' });
    expect(projectionMock.projectTaskReceipt).toHaveBeenCalledWith(expect.objectContaining({ surface: 'work' }));
    await waitFor(() => h.published.length >= 2, 'receipt published');
    await h.controller.setEnabled(false);
    const count = h.published.length;
    h.controller.announceTaskSurface({ surface: 'code', mode: 'agent' });
    expect(h.published.length).toBe(count);
  });

  it('routes cancel → cancelTask + ok', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    h.fireRequest({ requestId: 'r5', name: 'cancel', payload: {} });
    await waitFor(() => h.responded.some((r) => r.requestId === 'r5'), 'cancel response');
    expect(h.cancelTask).toHaveBeenCalledWith('p1', 'c1');
    expect(h.responded.find((r) => r.requestId === 'r5')!.result).toEqual({ ok: true });
  });

  it('routes permission → approvals.decide by requestId', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    h.fireRequest({ requestId: 'r6', name: 'permission', payload: { requestId: 'req-9', decision: 'allow' } });
    await waitFor(() => h.responded.some((r) => r.requestId === 'r6'), 'permission response');
    expect(h.approvals.decide).toHaveBeenCalledWith('req-9', 'allow');
    expect(h.responded.find((r) => r.requestId === 'r6')!.result).toEqual({ ok: true });
  });

  it('routes artifacts → list result passthrough', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    h.fireRequest({ requestId: 'r9', name: 'artifacts', payload: {} });
    await waitFor(() => h.responded.some((r) => r.requestId === 'r9'), 'artifacts response');
    expect(h.artifacts.list).toHaveBeenCalledTimes(1);
    expect(h.responded.find((r) => r.requestId === 'r9')!.result).toEqual({
      artifacts: [{ id: 'out/report.docx', name: 'out/report.docx', kind: 'document', size: 1024, modifiedAt: 42 }],
    });
  });

  it('routes artifact → read result passthrough, traversal rejected as 400', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    h.fireRequest({ requestId: 'r10', name: 'artifact', payload: { path: 'out/report.docx' } });
    await waitFor(() => h.responded.some((r) => r.requestId === 'r10'), 'artifact response');
    expect(h.artifacts.read).toHaveBeenCalledWith('out/report.docx');
    expect(h.responded.find((r) => r.requestId === 'r10')!.result).toMatchObject({ name: 'report.docx' });
    h.fireRequest({ requestId: 'r11', name: 'artifact', payload: { path: '../secret.txt' } });
    await waitFor(() => h.responded.some((r) => r.requestId === 'r11'), 'traversal response');
    const call = h.responded.find((r) => r.requestId === 'r11')!;
    expect(call.ok).toBe(false);
    expect(call.error?.statusCode).toBe(400);
    expect(h.artifacts.read).toHaveBeenCalledTimes(1);
  });

  it('routes chat → pet-chat handle with per-request config', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    h.fireRequest({ requestId: 'r7', name: 'chat', payload: { type: 'chat_send', requestId: 'msg-1', text: 'hi' } });
    await waitFor(() => h.responded.some((r) => r.requestId === 'r7'), 'chat response');
    expect(h.chatHandle).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat_send', text: 'hi' }),
      expect.objectContaining({ endpoint: 'https://api.example.com' }),
    );
    expect(h.responded.find((r) => r.requestId === 'r7')!.result).toEqual({ ok: true });
  });

  it('routes chat → error when no chat handle', async () => {
    const h = createHarness({ chatHandle: false });
    await h.controller.setEnabled(true);
    h.fireRequest({ requestId: 'r8', name: 'chat', payload: { type: 'chat_send' } });
    await waitFor(() => h.responded.some((r) => r.requestId === 'r8'), 'chat unavailable response');
    const call = h.responded.find((r) => r.requestId === 'r8')!;
    expect(call.ok).toBe(false);
    expect(call.error).toEqual({ code: 'CHAT_UNAVAILABLE', message: 'chat unavailable', statusCode: 501 });
  });

  it('routes fun → capability-unavailable 501', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    h.fireRequest({ requestId: 'r9', name: 'fun', payload: {} });
    await waitFor(() => h.responded.some((r) => r.requestId === 'r9'), 'fun response');
    const call = h.responded.find((r) => r.requestId === 'r9')!;
    expect(call.ok).toBe(false);
    expect(call.error).toMatchObject({ code: 'CAPABILITY_UNAVAILABLE', message: '本版本不支持猫箱', statusCode: 501 });
  });

  it('a failing authority returns an error response — never a hang', async () => {
    const h = createHarness();
    h.workspaces.select.mockRejectedValueOnce(new Error('boom'));
    await h.controller.setEnabled(true);
    h.fireRequest({ requestId: 'r10', name: 'project', payload: { projectId: 'p2' } });
    await waitFor(() => h.responded.some((r) => r.requestId === 'r10'), 'error response');
    const call = h.responded.find((r) => r.requestId === 'r10')!;
    expect(call.ok).toBe(false);
    expect(call.error).toMatchObject({ code: 'HANDLER_ERROR', statusCode: 500 });
  });

  it('unknown handler names are answered with an error', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    h.fireRequest({ requestId: 'r11', name: 'nope', payload: {} });
    await waitFor(() => h.responded.some((r) => r.requestId === 'r11'), 'unknown handler response');
    expect(h.responded.find((r) => r.requestId === 'r11')!.ok).toBe(false);
  });
});

describe('RemoteController projection taps', () => {
  it('onWorkItem tracks pending work approvals into permissionRequestState', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    h.controller.onWorkItem({
      kind: 'approval', id: 'a1', at: 0, conversationId: 'c1', approvalId: 'ap-1', type: 'bash',
      description: 'run tests', status: 'pending', taskId: 't', runId: 'r', turnId: undefined,
    });
    await waitFor(
      () => h.published.some((e) => e.type === 'permissionRequestState' && (e as { requests?: readonly { requestId: string }[] }).requests?.some((r) => r.requestId === 'ap-1')),
      'permissionRequestState with ap-1',
    );
    h.controller.onWorkItem({
      kind: 'approval', id: 'a1', at: 0, conversationId: 'c1', approvalId: 'ap-1', type: 'bash',
      description: 'run tests', status: 'approved', taskId: 't', runId: 'r', turnId: undefined,
    });
    await waitFor(
      () => h.published.filter((e) => e.type === 'permissionRequestState').at(-1) !== undefined
        && (h.published.filter((e) => e.type === 'permissionRequestState').at(-1) as { requests?: readonly unknown[] }).requests?.length === 0,
      'cleared permissionRequestState',
    );
  });

  it('supervisor bumps re-project binding state and permissions', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    projectionMock.projectBindingState.mockReturnValue({ type: 'agentState', state: 'thinking' });
    h.bumpSupervisor();
    await waitFor(() => h.published.some((e) => e.type === 'agentState' && e.state === 'thinking'), 'binding agentState publish');
  });

  it('lifecycle taps publish loop events and terminal outcomes', async () => {
    const h = createHarness();
    await h.controller.setEnabled(true);
    const scope = { projectKey: 'p1', projectRoot: '/w', conversationId: 'c1', mode: 'code' as const, runId: 'r', turnId: 't', startedAt: 0 };
    projectionMock.projectLoopEvents.mockReturnValue([{ type: 'trace', id: 'x', title: 'read', kind: 'tool' }]);
    h.controller.lifecycle.onRunStarted(scope);
    h.controller.lifecycle.onEvents(scope, [{ seq: 1, ts: 0, type: 'tool_use', turn: 1, id: 'x', tool: 'Bash', input: {} }]);
    h.controller.lifecycle.onRunTerminal(scope, 'completed');
    await waitFor(() => h.published.some((e) => e.type === 'trace'), 'loop event publish');
    await waitFor(() => h.published.some((e) => e.type === 'assistant'), 'terminal publish');
  });
});

describe('RemoteController status', () => {
  it('onStatus fires immediately; remote.status pushes update; down invalidates', async () => {
    const h = createHarness();
    const seen: RemoteStatusResult[] = [];
    const off = h.controller.onStatus((status) => seen.push(status));
    expect(seen).toHaveLength(1);
    await h.controller.setEnabled(true);
    expect(h.controller.status().running).toBe(true);
    h.fireStatus({ ok: true, enabled: true, running: true, port: 49380, publicUrl: 'https://x', tunnelMode: 'named', tunnelRunning: true, reasonCode: '' });
    expect(h.controller.status().publicUrl).toBe('https://x');
    expect(seen.at(-1)?.publicUrl).toBe('https://x');
    h.fireDown();
    expect(h.controller.status().running).toBe(false);
    expect(h.controller.status().reasonCode).toBe('not_attempted');
    off();
  });
});
