import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServiceManager } from '../services-host/service-manager'
import { encodeFrame } from '../services-host/frames'
import type { ResolvedToolRuntime, ToolingResolveProfileFailure } from '../services-host/methods'
import { createToolingFacade, createToolingRuntimeResolver } from '../tooling/tooling-facade'
import { ConversationRunSupervisor } from './conversation-run-supervisor'
import { IDLE_CODE_VIEW_STATE } from './runtime-types'
import { sendWorkChat } from '../work-chat/work-chat-adapter'
import { workToolProfile } from '../work-chat/work-tool-profile'

const h = vi.hoisted(() => ({ run: vi.fn(), stop: vi.fn() }))
vi.mock('../host-adapter/index', () => ({
  hostAdapter: { process: { list: async () => [], stop: async () => {} } },
}))
vi.mock('./code-run-controller', () => ({ CodeRunController: class {
  run = h.run
  stop = h.stop
  getViewState = () => IDLE_CODE_VIEW_STATE
  getActiveRun = () => null
  hasPrewarm = () => ({ processId: null, ready: false })
} }))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

const runtime: ResolvedToolRuntime = {
  profileId: 'code.core.v1', profileRevision: 'test', surface: 'code', mcpConfigPath: null,
  mcpConfigHash: 'hash', permissionSettingsPath: null, permissionSettingsHash: 'permission-hash',
  cliArgs: [], spawnEnv: { TRYLO_MCP_RUNTIME_REGISTRY: 'D:/profiles/current.json' },
  serverNames: ['trylo-office'], packageHealth: [], strictMcpConfig: false, resolvedAt: 0,
  unavailableCapabilities: [{ id: 'windows-mcp', type: 'package', reasonCode: 'input_runtime_low_integrity',
    userMessage: 'Computer input is temporarily unavailable.' }],
}
const request = { prompt: 'work', turnId: 'original-turn', settings: { cliPath: 'cli.js', cwd: 'D:/original' },
  codeMode: 'agent' as const, permissionLevel: 'workspace_write' as const, priorMessages: [], onEvents() {} }
const managers: ServiceManager[] = []

async function fixture() {
  const ready = deferred(), requests: Record<string, unknown>[] = []
  let running = false, listener: ((event: { payload: unknown }) => void) | undefined
  let failNextRequest = false
  let result: ({ readonly ok: true } & ResolvedToolRuntime) | ToolingResolveProfileFailure = { ok: true, ...runtime }
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'servicehost_spawn') { await ready.promise; running = true; return {} }
    if (command === 'servicehost_stop') { running = false; return {} }
    if (command === 'servicehost_status') return { running, pid: running ? 42 : null }
    if (command === 'servicehost_send') {
      const frame: { id: string; method: string; params: Record<string, unknown> } = JSON.parse(String(args?.frame))
      requests.push(frame.params)
      if (!running) throw new Error('Host is not ready')
      if (failNextRequest) { failNextRequest = false; throw new Error('Host transport failed') }
      const surface = frame.params.surface === 'work' ? 'work' : 'code'
      const resolved = result.ok ? { ...result, surface, profileId: frame.params.requestedProfileId ?? `${surface}.core.v1` } : result
      listener?.({ payload: encodeFrame({ version: 1, type: 'response', id: frame.id, ok: true, result: resolved }) })
    }
    return {}
  })
  const manager = new ServiceManager({ invoke, listen: async (_event, handler) => { listener = handler; return () => {} } })
  managers.push(manager)
  await manager.client.start()
  const facade = createToolingFacade(manager.client, {
    ensureReady: () => manager.ensureRunning({ sidecarsDir: 'D:/sidecars', appDataDir: 'D:/appdata' }),
  })
  const supervisor = new ConversationRunSupervisor({ resolveToolRuntime: createToolingRuntimeResolver(() => facade) })
  return { ready, requests, invoke, manager, supervisor,
    setResult(value: typeof result) { result = value }, failNextRequest() { failNextRequest = true } }
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map(manager => manager.stop()))
  vi.clearAllMocks()
})

describe('required user tool preparation through real facade, manager and supervisor', () => {
  it.each(['code', 'work'] as const)('%s waits for the existing host owner and preserves a partial runtime', async surface => {
    const f = await fixture()
    const sent = f.supervisor.runCode('original-project', 'original-chat', { ...request, surface })
    try {
      await vi.waitFor(() => expect(f.invoke.mock.calls.some(([name]) => name === 'servicehost_spawn')).toBe(true))
      expect(f.requests).toEqual([])
      expect(h.run).not.toHaveBeenCalled()
      f.ready.resolve()
      await sent
      expect(f.requests).toEqual([expect.objectContaining({ projectRoot: 'D:/original', conversationId: 'original-chat', surface })])
      expect(h.run).toHaveBeenCalledWith(expect.objectContaining({
        toolRuntime: expect.objectContaining({ ...runtime, surface, profileId: `${surface}.core.v1` }),
        turnId: 'original-turn', permissionLevel: 'workspace_write',
      }))
    } finally { f.ready.resolve(); await sent.catch(() => {}) }
  })

  it('stops during readiness without a later profile RPC and leaves the shared host running', async () => {
    const f = await fixture()
    const sent = f.supervisor.runCode('project', 'chat', request)
    try {
      await vi.waitFor(() => expect(f.invoke.mock.calls.some(([name]) => name === 'servicehost_spawn')).toBe(true))
      await f.supervisor.stopConversation('project', 'chat')
      await sent
      expect(f.supervisor.getViewState('project', 'chat').sendable).toBe(true)
      f.ready.resolve()
      await f.manager.ensureRunning({ sidecarsDir: 'D:/sidecars', appDataDir: 'D:/appdata' })
      expect(f.requests).toEqual([])
      expect(h.run).not.toHaveBeenCalled()
      expect(f.manager.currentHealth).toBe('ready')
    } finally { f.ready.resolve(); await sent.catch(() => {}) }
  })

  it('surfaces a whole profile failure and releases the same preparation for a successful retry', async () => {
    const f = await fixture()
    f.ready.resolve()
    f.setResult({ ok: false, reasonCode: 'config_write_failed', error: 'D:/private/profile.json' })
    await expect(f.supervisor.runCode('project', 'chat', request)).rejects.toMatchObject({ code: 'config_write_failed' })
    expect(h.run).not.toHaveBeenCalled()
    expect(f.supervisor.getViewState('project', 'chat').sendable).toBe(true)
    f.setResult({ ok: true, ...runtime })
    await f.supervisor.runCode('project', 'chat', { ...request, turnId: 'retry' })
    expect(h.run).toHaveBeenCalledOnce()
  })

  it('does not silently accept null from a wired user resolver', async () => {
    const supervisor = new ConversationRunSupervisor({ resolveToolRuntime: async () => null })
    await expect(supervisor.runCode('project', 'chat', request)).rejects.toThrow('工具配置')
    expect(h.run).not.toHaveBeenCalled()
    expect(supervisor.getViewState('project', 'chat').sendable).toBe(true)
  })

  it('surfaces an RPC transport failure without silently starting or automatically repeating the request', async () => {
    const f = await fixture()
    f.ready.resolve(); f.failNextRequest()
    await expect(f.supervisor.runCode('project', 'chat', request)).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
    expect(f.requests).toHaveLength(1)
    expect(h.run).not.toHaveBeenCalled()
    expect(f.supervisor.getViewState('project', 'chat').sendable).toBe(true)
    await f.supervisor.runCode('project', 'chat', { ...request, turnId: 'explicit-retry' })
    expect(f.requests).toHaveLength(2)
    expect(h.run).toHaveBeenCalledOnce()
  })

  it('shares startup across concurrent conversations while retaining each original scope and permission', async () => {
    const f = await fixture()
    const first = f.supervisor.runCode('first-project', 'first-chat', request)
    const second = f.supervisor.runCode('second-project', 'second-chat', {
      ...request, turnId: 'second-turn', permissionLevel: 'read_only', settings: { ...request.settings, cwd: 'D:/second' },
    })
    try {
      await vi.waitFor(() => expect(f.invoke.mock.calls.filter(([name]) => name === 'servicehost_spawn')).toHaveLength(1))
      expect(f.requests).toEqual([])
      f.ready.resolve(); await Promise.all([first, second])
      expect(f.requests).toEqual(expect.arrayContaining([
        expect.objectContaining({ projectKey: 'first-project', conversationId: 'first-chat', projectRoot: 'D:/original' }),
        expect.objectContaining({ projectKey: 'second-project', conversationId: 'second-chat', projectRoot: 'D:/second' }),
      ]))
      expect(h.run).toHaveBeenCalledWith(expect.objectContaining({
        settings: expect.objectContaining({ cwd: 'D:/second' }), turnId: 'second-turn', permissionLevel: 'read_only',
      }))
    } finally { f.ready.resolve(); await Promise.allSettled([first, second]) }
  })

  it('does not let an old canceled wait start or finish the newer send in the same conversation', async () => {
    const f = await fixture()
    const old = f.supervisor.runCode('project', 'chat', { ...request, turnId: 'old' })
    try {
      await vi.waitFor(() => expect(f.invoke.mock.calls.some(([name]) => name === 'servicehost_spawn')).toBe(true))
      await f.supervisor.stopConversation('project', 'chat'); await old
      const next = f.supervisor.runCode('project', 'chat', { ...request, turnId: 'new' })
      expect(f.supervisor.getViewState('project', 'chat').runId).toBe('new')
      f.ready.resolve(); await next
      expect(f.requests).toHaveLength(1)
      expect(h.run).toHaveBeenCalledOnce()
      expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'new' }))
    } finally { f.ready.resolve(); await old.catch(() => {}) }
  })

  it('binds a Work preflight readiness wait to its existing preparation signal', async () => {
    const f = await fixture()
    const preparation = f.supervisor.beginSend('project', 'work', 'work-preflight')!
    const prepared = f.supervisor.resolveRuntimeFor({ surface: 'work', projectKey: 'project',
      projectRoot: 'D:/original', conversationId: 'work', permissionLevel: 'workspace_write',
    }, { signal: preparation.signal }).catch(error => error as Error)
    try {
      await vi.waitFor(() => expect(f.invoke.mock.calls.some(([name]) => name === 'servicehost_spawn')).toBe(true))
      await f.supervisor.stopConversation('project', 'work')
      expect(await prepared).toMatchObject({ name: 'AbortError' })
      f.ready.resolve(); await f.manager.ensureRunning({ sidecarsDir: 'D:/sidecars', appDataDir: 'D:/appdata' })
      expect(f.requests).toEqual([])
      expect(preparation.isCurrent()).toBe(false)
    } finally { preparation.finish(); f.ready.resolve(); await prepared }
  })

  it.each(['remote', 'team-reopen'] as const)('%s uses the shared production Work settings and adapter without an explicit-null bypass', async entry => {
    const f = await fixture()
    const computerUse = entry === 'remote'
    const settingsAtSend = { workComputer: computerUse, workBrowserDebug: true, workCad: false }
    const sent = sendWorkChat(f.supervisor, { ...request, projectKey: 'project', conversationId: entry,
      text: request.prompt, teamMode: entry === 'team-reopen',
      ...workToolProfile(settingsAtSend),
    })
    try {
      await vi.waitFor(() => expect(f.invoke.mock.calls.some(([name]) => name === 'servicehost_spawn')).toBe(true))
      settingsAtSend.workComputer = !computerUse; settingsAtSend.workBrowserDebug = false
      f.ready.resolve(); await sent
      expect(f.requests).toEqual([expect.objectContaining({ surface: 'work', requestedProfileId: 'work.browser-debug.v1',
        computerUse, conversationId: entry, projectRoot: 'D:/original' })])
      expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ computerUse,
        toolRuntime: expect.objectContaining({ profileId: 'work.browser-debug.v1', surface: 'work' }) }))
    } finally { f.ready.resolve(); await sent.catch(() => {}) }
  })
})
