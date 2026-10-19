// Trylo Desktop — CodeRunController protocol routing (P08 §4.1 / §3.3).
//
// These tests do not care what the CLI does; they prove that the
// controller picks the right runner and refuses the capabilities the
// one-shot protocol does not have. A silent fall-through to the legacy
// runner here would be the worst kind of bug: everything would look
// like it worked while the new CLI was never exercised.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopEvent } from '../host-adapter/loop-events';
import { StreamTranslator } from '../host-adapter/stream-translator';
import type { FilePath } from '../host-adapter/types';
import type { SettingsForCodeRun } from './runtime-types';
import type { ResolvedToolRuntime } from '../tooling/types';

const m = vi.hoisted(() => {
  const calls = {
    startTrylo: 0,
    startTryloV1: 0,
    stopTryloProcess: 0,
    stopTryloV1: 0,
    sendPrompt: 0,
  };
  type StubProviders = {
    ok: boolean;
    selected?: string;
    reason?: string;
    detail?: string;
    providers: { id: string; auth: string }[];
  };
  type StubStatus = {
    ok: boolean;
    reason?: string;
    detail?: string;
    providers: { providerId: string; layer: string; accountId: string; loggedIn: boolean }[];
  };
  const auth = {
    providers: { ok: true, selected: 'fixture', providers: [] } as StubProviders,
    status: { ok: true, providers: [] } as StubStatus,
    providerCalls: 0,
    statusCalls: 0,
    wait: null as Promise<void> | null,
    started: null as (() => void) | null,
  };
  return {
    calls,
    legacyCallbacks: { onEvents: null as ((events: readonly LoopEvent[]) => void) | null },
    prewarmCallbacks: { onEvents: null as ((events: readonly LoopEvent[]) => void) | null },
    lastV1: { binding: null as unknown, priorMessages: null as unknown, systemPrompt: undefined as string | undefined },
    auth,
  };
});

// Keep providerArgsFor real (it is pure), stub only the CLI probes.
vi.mock('../host-adapter/cli-auth-status', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../host-adapter/cli-auth-status')>();
  return {
    ...actual,
    readCliProviders: async () => {
      m.auth.providerCalls += 1;
      m.auth.started?.();
      if (m.auth.wait) await m.auth.wait;
      return m.auth.providers;
    },
    readCliAuthStatus: async () => {
      m.auth.statusCalls += 1;
      return m.auth.status;
    },
  };
});

vi.mock('../host-adapter/cli-provider-credential', () => ({
  readCliProviderCredential: async () => {
    m.auth.statusCalls += 1;
    if (!m.auth.status.ok) return { ok: false, detail: m.auth.status.detail ?? 'failed' };
    const row = m.auth.status.providers[0];
    return { ok: true, loggedIn: row?.loggedIn ?? false, layer: row?.layer ?? 'none' };
  },
}));

vi.mock('../host-adapter/trylo-runner', () => ({
  startTrylo: vi.fn(async (args: { onEvents?: (events: readonly LoopEvent[]) => void }) => {
    m.legacyCallbacks.onEvents = args.onEvents ?? null;
    m.calls.startTrylo += 1;
    return { processId: 'proc-legacy', eventsFile: 'e' };
  }),
  startTryloPrewarm: vi.fn(async (args: { onEvents?: (events: readonly LoopEvent[]) => void }) => {
    m.prewarmCallbacks.onEvents = args.onEvents ?? null;
    return { processId: 'proc-prewarm', eventsFile: 'e' };
  }),
  stopTryloProcess: vi.fn(async () => {
    m.calls.stopTryloProcess += 1;
  }),
  sendPromptToProcess: vi.fn(async () => {
    m.calls.sendPrompt += 1;
    return true;
  }),
  sendControlLineToProcess: vi.fn(async () => true),
}));

vi.mock('../host-adapter/trylo-v1-runner', () => ({
  startTryloV1: vi.fn(async (a: { binding?: unknown; priorMessages?: unknown; systemPrompt?: string }) => {
    m.calls.startTryloV1 += 1;
    m.lastV1.binding = a.binding ?? null;
    m.lastV1.priorMessages = a.priorMessages ?? null;
    m.lastV1.systemPrompt = a.systemPrompt;
    return { processId: 'proc-v1', state: () => 'input_closed' as const };
  }),
  stopTryloV1: vi.fn(async () => {
    m.calls.stopTryloV1 += 1;
  }),
  TryloV1UnsupportedError: class TryloV1UnsupportedError extends Error {},
}));

// Round-3 P1-10: the pre-spawn runtime guard is proved by its own suite
// (cli-runtime-guard.test.ts) with an injected probe. Here it stays out of
// the way so protocol routing is tested without spawning real probes.
vi.mock('./cli-runtime-guard', () => ({
  verifyCliRuntime: vi.fn(async () => ({ ok: true })),
  resetCliRuntimeGuardForTests: vi.fn(),
}));

const { CodeRunController } = await import('./code-run-controller');
const { CodePermissionRegistry } = await import('./code-permission-registry');
const { buildStopTaskRequest } = await import('../host-adapter/control-protocol');
const { verifyCliRuntime } = await import('./cli-runtime-guard');

const CWD = 'C:/trylo-workspace/workspace' as FilePath;
const CLI_PATH = 'C:/trylo-workspace/new trylo cli/dist/cmd/trylo/main.js' as FilePath;

function settings(protocol: 'legacy-stream-json' | 'trylo-v1'): SettingsForCodeRun {
  return { cliPath: CLI_PATH, cwd: CWD, cliRuntimeProtocol: protocol };
}

function controller(withRegistry = true): InstanceType<typeof CodeRunController> {
  return new CodeRunController({
    projectKey: 'p',
    conversationId: 'c',
    onChange: () => undefined,
    ...(withRegistry ? { permissions: new CodePermissionRegistry({ onChange() {}, send: async () => true }) } : {}),
  });
}

function selectedProfile(cliArgs: readonly string[] = ['--mcp-config', 'D:/private/profile.json', '--settings', 'D:/private/settings.json']): ResolvedToolRuntime {
  return { profileId: 'work.browser.v1', profileRevision: '1', surface: 'work',
    mcpConfigPath: 'D:/private/profile.json', mcpConfigHash: 'mcp-hash',
    permissionSettingsPath: 'D:/private/settings.json', permissionSettingsHash: 'settings-hash',
    cliArgs, spawnEnv: {}, serverNames: [], packageHealth: [], unavailableCapabilities: [],
    strictMcpConfig: true, resolvedAt: 0 };
}

function request(
  protocol: 'legacy-stream-json' | 'trylo-v1',
  prompt = 'hi',
  extraSettings: Partial<SettingsForCodeRun> = {},
) {
  return {
    prompt,
    settings: { ...settings(protocol), ...extraSettings },
    codeMode: 'agent' as const,
    permissionLevel: 'read_only' as const,
    priorMessages: [],
    onEvents: () => undefined,
  };
}

beforeEach(() => {
  vi.mocked(verifyCliRuntime).mockReset().mockResolvedValue({ ok: true });
  m.legacyCallbacks.onEvents = null;
  m.prewarmCallbacks.onEvents = null;
  m.auth.providerCalls = 0;
  m.auth.statusCalls = 0;
  m.auth.wait = null;
  m.auth.started = null;
  m.auth.providers = { ok: true, selected: 'fixture', providers: [] };
  m.auth.status = { ok: true, providers: [] };
  m.calls.startTrylo = 0;
  m.calls.startTryloV1 = 0;
  m.calls.stopTryloProcess = 0;
  m.calls.stopTryloV1 = 0;
  m.calls.sendPrompt = 0;
});

describe('CodeRunController — protocol routing', () => {
  it.each([false, true])('settles a real legacy 401 frame and kills its child (prewarmed=%s)', async prewarmed => {
    const c = controller();
    if (prewarmed) await c.prewarm(settings('legacy-stream-json'), { permissionLevel: 'read_only' });
    const received: LoopEvent[] = [];
    const terminal = vi.fn();
    await c.run({ ...request('legacy-stream-json'), onEvents: events => received.push(...events),
      lifecycleObserver: { onRunStarted: async () => undefined, onEvents: () => undefined, onRunTerminal: terminal } });
    expect(c.getViewState().running).toBe(true);
    const events = new StreamTranslator().feed(JSON.stringify({ type: 'system', subtype: 'api_retry',
      attempt: 1, max_retries: 10, retry_delay_ms: 1000, error_status: 401, error: 'authentication_failed' }));
    (prewarmed ? m.prewarmCallbacks : m.legacyCallbacks).onEvents?.(events);
    expect(c.getViewState()).toMatchObject({ running: false, error: true });
    expect(m.calls.stopTryloProcess).toBe(1);
    expect(received).toContainEqual(expect.objectContaining({ type: 'runtime_warning', code: 'provider_auth_failed' }));
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal.mock.calls[0]?.[1]).toBe('failed');
  });

  it('uses the legacy runner for the legacy protocol', async () => {
    const c = controller();
    await c.run(request('legacy-stream-json'));
    expect(m.calls.startTrylo).toBe(1);
    expect(m.calls.startTryloV1).toBe(0);
  });

  it('uses the one-shot runner for trylo-v1', async () => {
    const c = controller();
    await c.run(request('trylo-v1'));
    expect(m.calls.startTryloV1).toBe(1);
    expect(m.calls.startTrylo).toBe(0);
  });

  it('carries the snapshotted Desktop system prompt into the v1 runner', async () => {
    await controller().run(request('trylo-v1', 'hi', { systemPrompt: 'Report progress before using tools.' }));
    expect(m.lastV1.systemPrompt).toBe('Report progress before using tools.');
  });

  it('visibly reports an explicitly selected unsupported profile once while still running the task', async () => {
    const c = controller();
    const events: LoopEvent[] = [];
    const run = { ...request('trylo-v1'), toolRuntime: selectedProfile(), requestedProfileId: 'work.browser.v1',
      onEvents: (batch: readonly LoopEvent[]) => events.push(...batch) };
    await c.run(run);
    await c.run(run);
    const warnings = events.filter(e => e.type === 'runtime_warning' && e.code === 'desktop_profile_unavailable');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ message: expect.stringContaining('CLI 自身的 MCP 配置') });
    expect(JSON.stringify(warnings)).not.toContain('D:/private');
    expect(m.calls.startTryloV1).toBe(2);
  });

  it('does not emit profile notices on default runs or profiles without legacy config flags', async () => {
    const events: LoopEvent[] = [];
    const onEvents = (batch: readonly LoopEvent[]) => events.push(...batch);
    await controller().run({ ...request('trylo-v1'), toolRuntime: selectedProfile(), onEvents });
    await controller().run({ ...request('trylo-v1'), toolRuntime: selectedProfile([]), requestedProfileId: 'work.browser.v1', onEvents });
    await controller().run({ ...request('legacy-stream-json'), toolRuntime: selectedProfile(), requestedProfileId: 'work.browser.v1', onEvents });
    expect(events.filter(e => e.type === 'runtime_warning')).toEqual([]);
  });

  it('never reuses a live process on the v1 protocol', async () => {
    // The legacy warm path writes a second prompt to the same process.
    // On v1 that stdin is already closed, so the prompt would vanish and
    // the user would see a run that never answers.
    const c = controller();
    await c.run(request('trylo-v1'));
    await c.run(request('trylo-v1'));
    expect(m.calls.startTryloV1).toBe(2);
    expect(m.calls.sendPrompt).toBe(0);
  });

  it('starts a fresh session after a v1 to legacy to v1 round trip', async () => {
    const c = controller();
    await c.run(request('trylo-v1'));
    const first = m.lastV1.binding as { state: string; sessionId?: string };
    await c.run(request('legacy-stream-json'));
    await c.run(request('trylo-v1'));
    const returned = m.lastV1.binding as { state: string; sessionId?: string };
    expect(returned.state).toBe('creating');
    expect(returned.sessionId).not.toBe(first.sessionId);
    expect(m.calls.stopTryloV1).toBe(1);
    expect(m.calls.stopTryloProcess).toBe(1);
  });

  it('resumes the SAME CLI session on the next v1 turn', async () => {
    // §6.2: one session per conversation. A second turn must not mint a
    // new id, or every turn starts a fresh journal and the history is lost.
    const c = controller();
    await c.run(request('trylo-v1'));
    const first = m.lastV1.binding as { state: string; sessionId?: string };
    expect(first.state).toBe('creating');
    await c.run(request('trylo-v1'));
    const second = m.lastV1.binding as { state: string; sessionId?: string };
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.state).not.toBe('none');
  });

  it('passes prior turns to the v1 runner for replay', async () => {
    // §6.1: with no CLI-owned session yet, history is replayed inside the
    // prompt. Dropping it would make turn two look like a first message.
    const c = controller();
    await c.run({
      ...request('trylo-v1'),
      priorMessages: [
        { id: 'm1', role: 'user', kind: 'text', text: 'earlier question' } as never,
      ],
    });
    expect(m.lastV1.priorMessages).toHaveLength(1);
  });

  it('does not prewarm on the v1 protocol', async () => {
    const c = controller();
    await c.prewarm(settings('trylo-v1'), { permissionLevel: 'read_only' });
    expect(c.hasPrewarm()).toEqual({ processId: null, ready: false });
  });

  it('delivers steering on the framed v1 protocol', async () => {
    const c = controller();
    await c.run(request('trylo-v1'));
    // Round-3 P0-5: `unsupported` (not a thrown error): nothing was even
    // attempted. The caller must be able to tell "this runtime cannot do it"
    // apart from "the write failed" — see runtime/steer-delivery.ts.
    expect(await c.steer('actually, stop')).toEqual({ kind: 'delivered' });
    expect(m.calls.sendPrompt).toBe(1);
  });

  it('stops a v1 run through the v1 stop path', async () => {
    // Only the v1 runner knows how to mark the exit as a cancellation;
    // the legacy stop would leave the outcome as a crash.
    const c = controller();
    await c.run(request('trylo-v1'));
    await c.stop();
    expect(m.calls.stopTryloV1).toBe(1);
    expect(m.calls.stopTryloProcess).toBe(0);
  });

  it('creates a fresh CLI session with visible history after a forced stop', async () => {
    const c = controller();
    await c.run(request('trylo-v1'));
    const stopped = m.lastV1.binding as { sessionId: string };
    await c.stop();
    const history = [{ id: 'earlier', role: 'user', kind: 'text', text: 'remember me' } as never];
    await c.run({ ...request('trylo-v1'), priorMessages: history });
    const recovered = m.lastV1.binding as { state: string; sessionId: string };
    expect(recovered.state).toBe('creating');
    expect(recovered.sessionId).not.toBe(stopped.sessionId);
    expect(m.lastV1.priorMessages).toEqual(history);
  });

  it('stops a legacy run through the legacy path', async () => {
    const c = controller();
    await c.run(request('legacy-stream-json'));
    await c.stop();
    expect(m.calls.stopTryloProcess).toBe(1);
    expect(m.calls.stopTryloV1).toBe(0);
  });

  it('refuses an ask run when its controller has no approval registry', async () => {
    const c = controller(false);
    await expect(
      c.run({
        ...request('trylo-v1'),
        permissionLevel: 'ask',
      }),
    ).rejects.toThrow(/approval/i);
    expect(m.calls.startTryloV1).toBe(0);
  });

  it('refuses automatic editing when commands could not be approved by the host', async () => {
    await expect(controller(false).run({ ...request('trylo-v1'), permissionLevel: 'workspace_write' }))
      .rejects.toThrow(/approval/i);
    expect(m.calls.startTryloV1).toBe(0);
  });
  it('refuses read-only runs when the host cannot deny unclassified MCP effects', async () => {
    await expect(controller(false).run(request('trylo-v1'))).rejects.toThrow(/approval/i);
    expect(m.calls.startTryloV1).toBe(0);
  });
});

describe('buildStopTaskRequest', () => {
  it('still builds a legacy control frame', () => {
    // Guard: the v1 work must not have changed the legacy wire shape.
    const frame = buildStopTaskRequest('t1');
    expect(JSON.stringify(frame)).toContain('t1');
  });
});

describe('CodeRunController — provider/auth gate (P08 §3.4, audit P1)', () => {
  it('an invalid API base releases busy state without starting a CLI task', async () => {
    const c = controller();
    await expect(c.run(request('trylo-v1', 'hi', { apiFormat: 'openai', apiHost: 'invalid-url' })))
      .rejects.toThrow('API host');
    expect(c.getViewState()).toMatchObject({ running: false, sendable: true, error: true });
    expect(m.calls.startTryloV1).toBe(0);
  });
  it('stop during authentication prevents a late probe from starting a new task', async () => {
    let release: () => void = () => undefined;
    m.auth.wait = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { m.auth.started = resolve; });
    m.auth.providers = { ok: true, providers: [{ id: 'fixture', auth: 'none' }] };
    const c = controller();
    const run = c.run(request('trylo-v1', 'hi', { providerId: 'fixture' }));
    await started;
    await c.stop();
    release();
    await run;
    expect(m.calls.startTryloV1).toBe(0);
    expect(c.getViewState().running).toBe(false);
  });
  it('does not probe anything when no provider is configured (M0 dev path)', async () => {
    // Two extra process spawns per turn to learn "fixture needs no
    // credential" would be pure waste.
    const c = controller();
    await c.run(request('trylo-v1'));
    expect(m.auth.providerCalls).toBe(0);
    expect(m.auth.statusCalls).toBe(0);
    expect(m.calls.startTryloV1).toBe(1);
  });

  it('overlaps runtime verification with credential checks but waits for both before spawning', async () => {
    let releaseAuth!: () => void;
    let releaseRuntime!: () => void;
    m.auth.wait = new Promise<void>(resolve => { releaseAuth = resolve; });
    const authStarted = new Promise<void>(resolve => { m.auth.started = resolve; });
    const runtimeWait = new Promise<void>(resolve => { releaseRuntime = resolve; });
    vi.mocked(verifyCliRuntime).mockImplementationOnce(async () => { await runtimeWait; return { ok: true }; });
    m.auth.providers = { ok: true, providers: [{ id: 'fixture', auth: 'none' }] };
    const c = controller();
    const run = c.run(request('trylo-v1', 'hi', { providerId: 'fixture' }));
    await authStarted;
    expect(verifyCliRuntime).toHaveBeenCalledTimes(1);
    expect(m.calls.startTryloV1).toBe(0);
    releaseAuth();
    await vi.waitFor(() => expect(m.auth.providerCalls).toBe(1));
    expect(m.calls.startTryloV1).toBe(0);
    releaseRuntime();
    await run;
    expect(m.calls.startTryloV1).toBe(1);
  });

  it('still blocks a mismatched runtime when an explicit key skips auth subprocesses', async () => {
    vi.mocked(verifyCliRuntime).mockResolvedValueOnce({ ok: false, message: 'runtime mismatch' });
    const c = controller();
    await expect(c.run(request('trylo-v1', 'hi', { apiFormat: 'openai', apiKey: 'test-only-key' })))
      .rejects.toThrow('runtime mismatch');
    expect(m.auth.providerCalls).toBe(0);
    expect(m.calls.startTryloV1).toBe(0);
    expect(c.getViewState()).toMatchObject({ running: false, error: true });
  });

  it('refuses an Anthropic-only connection instead of silently running fixture', async () => {
    // The audit's point: forwarding an Anthropic endpoint at the
    // openai-compatible provider, or falling back to the CLI default
    // while the user believes they are on their own endpoint, are both
    // worse than an honest refusal.
    const c = controller();
    await expect(
      c.run(
        request('trylo-v1', 'hi', {
          apiHost: 'https://api.anthropic.com',
          apiKey: 'sk-ant-x',
          apiFormat: 'anthropic',
        }),
      ),
    ).rejects.toThrow(/无法映射|provider/i);
    expect(m.calls.startTryloV1).toBe(0);
  });

  it('refuses to spawn when the selected provider needs a credential it lacks', async () => {
    m.auth.providers = {
      ok: true,
      selected: 'fixture',
      providers: [{ id: 'openai-compatible', auth: 'api_key' }],
    };
    m.auth.status = {
      ok: true,
      providers: [{ providerId: 'openai-compatible', layer: 'none', accountId: '', loggedIn: false }],
    };
    const c = controller();
    await expect(
      c.run(request('trylo-v1', 'hi', { providerId: 'openai-compatible' })),
    ).rejects.toThrow(/未登录/);
    expect(m.calls.startTryloV1).toBe(0);
  });

  it('spawns when the credential is present, forwarding only provider args', async () => {
    m.auth.providers = {
      ok: true,
      selected: 'openai-compatible',
      providers: [{ id: 'openai-compatible', auth: 'api_key' }],
    };
    m.auth.status = {
      ok: true,
      providers: [{ providerId: 'openai-compatible', layer: 'user', accountId: 'acct', loggedIn: true }],
    };
    const c = controller();
    await c.run(
      request('trylo-v1', 'hi', {
        providerId: 'openai-compatible',
        apiHost: 'https://api.example.com',
        apiModel: 'gpt-x',
      }),
    );
    expect(m.calls.startTryloV1).toBe(1);
    expect(m.auth.providerCalls).toBe(1);
    expect(m.auth.statusCalls).toBe(1);
  });

  it('fails closed when the provider list cannot be read', async () => {
    // "We could not tell" must not become "go ahead".
    m.auth.providers = { ok: false, reason: 'timeout', detail: 'no exit', providers: [] };
    const c = controller();
    await expect(
      c.run(request('trylo-v1', 'hi', { providerId: 'openai-compatible' })),
    ).rejects.toThrow(/provider 列表/);
    expect(m.calls.startTryloV1).toBe(0);
  });
});


describe('Legacy initialization failures', () => {
  const aborted = [{ type: 'aborted', seq: 1, ts: 0, reason: 'error' }] as const;
  it('ends a cold run, reports failure once, and removes the failed child', async () => {
    const terminal = vi.fn();
    const c = controller();
    await c.run({ ...request('legacy-stream-json'), lifecycleObserver: {
      onRunStarted: vi.fn(), onEvents: vi.fn(), onRunTerminal: terminal,
    } });
    m.legacyCallbacks.onEvents?.(aborted);
    m.legacyCallbacks.onEvents?.(aborted);
    expect(c.getViewState().running).toBe(false);
    expect(m.calls.stopTryloProcess).toBe(1);
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal.mock.calls[0]?.[1]).toBe('failed');
  });
  it('discards an idle prewarm that aborts, then cold starts the next task', async () => {
    const c = controller();
    await c.prewarm(settings('legacy-stream-json'), { permissionLevel: 'read_only' });
    m.prewarmCallbacks.onEvents?.(aborted);
    expect(c.hasPrewarm().processId).toBeNull();
    await c.run(request('legacy-stream-json'));
    expect(m.calls.startTrylo).toBe(1);
    expect(m.calls.sendPrompt).toBe(0);
  });
  it('cleans up a prewarm that aborts after adoption', async () => {
    const c = controller();
    await c.prewarm(settings('legacy-stream-json'), { permissionLevel: 'read_only' });
    await c.run(request('legacy-stream-json'));
    expect(m.calls.sendPrompt).toBe(1);
    m.prewarmCallbacks.onEvents?.(aborted);
    expect(c.getViewState().running).toBe(false);
    expect(m.calls.stopTryloProcess).toBe(1);
  });
  it('ignores a late abort from a discarded prewarm without clearing its replacement', async () => {
    const c = controller();
    await c.prewarm(settings('legacy-stream-json'), { permissionLevel: 'read_only' });
    const staleEvents = m.prewarmCallbacks.onEvents;
    await c.stop();
    await c.prewarm(settings('legacy-stream-json'), { permissionLevel: 'read_only' });
    const replacement = c.hasPrewarm();
    const stopped = m.calls.stopTryloProcess;
    staleEvents?.(aborted);
    expect(c.hasPrewarm()).toEqual(replacement);
    expect(m.calls.stopTryloProcess).toBe(stopped);
  });
});


it('forwards the installed interpreter to legacy runs and prewarm', async () => {
  const { startTrylo, startTryloPrewarm } = await import('../host-adapter/trylo-runner');
  const nodeProgram = 'C:/Program Files/Trylo/runtime/node/win-x64/node.exe';
  await controller().run(request('legacy-stream-json', 'hi', { cliNodeProgram: nodeProgram }));
  expect(vi.mocked(startTrylo).mock.lastCall?.[0]).toMatchObject({ nodeProgram });
  await controller().prewarm({ ...settings('legacy-stream-json'), cliNodeProgram: nodeProgram },
    { permissionLevel: 'read_only' });
  expect(vi.mocked(startTryloPrewarm).mock.lastCall?.[0]).toMatchObject({ nodeProgram });
});
