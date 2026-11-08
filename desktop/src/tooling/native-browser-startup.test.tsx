import { StrictMode, useEffect, useRef, type ReactNode } from 'react'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServicesClient } from '../services-host/services-client'
import { nativeBrowserCommand } from '../host-adapter/native-browser'
import { createToolingFacade, type ToolingFacade } from './tooling-facade'
import { useBrowserPreview } from './use-browser-preview'
import type { ServiceManager } from '../services-host/service-manager'

vi.mock('../host-adapter/native-browser', () => ({
  nativeBrowserScope: (root: string, id: string) => JSON.stringify([root.replaceAll('\\', '/').toLowerCase().replace(/\/$/, ''), id]),
  nativeBrowserCommand: vi.fn(async () => ({ scope: '["d:/task","one"]', cdpPort: 9000, tabs: [], activeLabel: 'one' })),
  onNativeBrowserPage: vi.fn(async () => () => {}),
  onNativeBrowserControls: vi.fn(async () => () => {}),
}))
afterEach(() => { vi.clearAllMocks() })
const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>

async function within<T>(job: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([job, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('startup fixture did not respond within 10s')), 10_000)
    })])
  } finally { clearTimeout(timer) }
}

async function stopChild(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
  child.kill()
  await exited
}

async function repositoryBrowserEntry(): Promise<string> {
  const registryPath = path.resolve('../desktop-services/toolchain/tool-sources.json')
  const config: unknown = JSON.parse(await fs.readFile(registryPath, 'utf8'))
  if (!config || typeof config !== 'object' || !('tools' in config)) {
    throw new Error('Repository tool registry is missing its tools declaration')
  }
  const tools = config.tools
  if (!tools || typeof tools !== 'object' || !('playwright' in tools)) {
    throw new Error('Repository tool registry does not declare Playwright')
  }
  const browser = tools.playwright
  if (!browser || typeof browser !== 'object' || !('entry' in browser)
    || typeof browser.entry !== 'string' || !('policy' in browser) || browser.policy !== 'repository-local') {
    throw new Error('Repository Playwright entry must be a repository-local path')
  }
  const root = path.dirname(registryPath)
  const entry = path.resolve(root, browser.entry)
  if (!entry.startsWith(root + path.sep)) throw new Error('Repository Playwright entry escaped the checkout')
  await fs.access(entry)
  return entry
}

async function hostFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'trylo-native-startup-'))
  const marker = 'about:blank#trylo-native-native-root'
  const engine = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify([{ id: 'real-target', type: 'page', url: marker, title: 'Test page' }]))
  })
  await new Promise<void>(resolve => engine.listen(0, '127.0.0.1', resolve))
  const port = (engine.address() as { port: number }).port
  vi.mocked(nativeBrowserCommand).mockImplementation(async command => ({
    scope: command.scope, cdpPort: port, tabs: [{ label: 'native-root', marker }], activeLabel: 'native-root',
  }))
  const child = spawn(process.execPath, [path.resolve('../desktop-services/src/host.mjs')], {
    cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, TRYLO_APP_DATA_DIR: root, TRYLO_SIDECARS_DIR: '', TRYLO_SERVICEHOST_SIDECAR_PING: '0' },
  })
  let frame: (event: { payload: unknown }) => void = () => {}
  const lines = readline.createInterface({ input: child.stdout })
  lines.on('line', line => frame({ payload: line }))
  child.stderr.on('data', () => {})
  const client = new ServicesClient({
    listen: async (_topic, handler) => { frame = handler; return () => {} },
    invoke: async (_command, args) => { child.stdin.write(String(args?.frame)) },
  })
  const ready = new Promise<void>(resolve => client.onEvent('ready', () => resolve()))
  await client.start()
  const close = async () => {
    await client.stop(); await stopChild(child); lines.close()
    engine.closeAllConnections()
    await new Promise<void>(resolve => engine.close(() => resolve()))
    await fs.rm(root, { recursive: true, force: true })
  }
  try { await within(ready) } catch (error) { await close(); throw error }
  return { root, client, close }
}

async function listMcpTools(command: string, args: string[], cwd: string): Promise<string[]> {
  const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.on('data', () => {})
  const lines = readline.createInterface({ input: child.stdout })
  const pending = new Map<number, (result: { tools?: { name: string }[] }) => void>()
  lines.on('line', line => {
    const response = JSON.parse(line) as { id: number; result: { tools?: { name: string }[] } }
    pending.get(response.id)?.(response.result); pending.delete(response.id)
  })
  const request = (id: number, method: string, params: unknown) => new Promise<{ tools?: { name: string }[] }>(resolve => {
    pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  try {
    await within(request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'startup-test', version: '1' } }))
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    return (await within(request(2, 'tools/list', {}))).tools?.map(tool => tool.name) ?? []
  } finally { lines.close(); await stopChild(child) }
}

function transport() {
  let frame: (event: { payload: unknown }) => void = () => {}
  const invoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => undefined)
  const emit = (id: string) => frame({ payload: JSON.stringify({ version: 1, type: 'event', topic: 'tooling.nativeBrowserCommand', payload: { id, scope: '["d:/task","one"]', operation: 'ensure' } }) })
  // Respond to the renderer acknowledgement through the real frame codec.
  invoke.mockImplementation(async (_command, args) => {
    const request = JSON.parse(String(args?.frame))
    frame({ payload: JSON.stringify({ version: 1, type: 'response', id: request.id, ok: true, result: { ok: true } }) })
  })
  const deps = { invoke, listen: async (_topic: string, handler: (event: { payload: unknown }) => void) => { frame = handler; return () => {} } }
  return { deps, emit, invoke }
}

describe('native browser startup lifecycle', () => {
  it('keeps exactly one command bridge after StrictMode replay and releases it on unmount', async () => {
    const f = transport()
    let committedClient: ServicesClient | undefined
    const { unmount } = renderHook(() => {
      // App also creates the stable ServiceManager/client during render.
      // The discarded first StrictMode render owns a different client.
      const client = useRef<ServicesClient>()
      if (!client.current) client.current = new ServicesClient(f.deps)
      committedClient = client.current
      const facade = useRef<ToolingFacade>()
      if (!facade.current) facade.current = createToolingFacade(client.current)
      const manager = { currentHealth: 'ready', client: client.current, onHealth: () => () => {} } as unknown as ServiceManager
      useEffect(() => { void client.current?.start() }, [])
      useBrowserPreview({ facade: facade.current, serviceManager: manager, projectRoot: 'D:/task', conversationId: 'one', initiallyVisible: false })
    }, { wrapper })
    act(() => f.emit('after-replay'))
    const ensures = () => vi.mocked(nativeBrowserCommand).mock.calls.filter(([command]) => command.operation === 'ensure')
    await waitFor(() => expect(ensures()).toHaveLength(1))
    expect(f.invoke.mock.calls.filter(([, args]) => JSON.parse(String(args?.frame)).method === 'tooling.nativeBrowserCommandResult')).toHaveLength(1)
    unmount()
    vi.mocked(nativeBrowserCommand).mockClear()
    act(() => f.emit('after-unmount'))
    await Promise.resolve()
    expect(ensures()).toHaveLength(0)
    await committedClient?.stop()
  })

  it('opens through the real host frame loop and advertises real MCP tools with the sidebar closed', async () => {
    const f = await hostFixture()
    const manager = { currentHealth: 'ready', client: f.client, onHealth: () => () => {} } as unknown as ServiceManager
    const { result, unmount } = renderHook(() => {
      const facade = useRef<ToolingFacade>()
      if (!facade.current) facade.current = createToolingFacade(f.client)
      useBrowserPreview({ facade: facade.current, serviceManager: manager, projectRoot: f.root, conversationId: 'one', initiallyVisible: false })
      return facade.current
    }, { wrapper })
    try {
      // Use the declared entry in both development and public source checkouts.
      // Preparation remains explicit; the test never downloads or installs tools.
      await f.client.request('tooling.setLocalOverride', { id: 'playwright', path: await repositoryBrowserEntry() })
      // The first send must create the browser without opening the sidebar.
      const runtime = await act(() => within(result.current.resolveProfile({ surface: 'work', projectRoot: f.root, projectKey: f.root, conversationId: 'one', computerUse: false, permissionLevel: 'workspace_write' })))
      expect(vi.mocked(nativeBrowserCommand).mock.calls.filter(([command]) => command.operation === 'ensure')).toHaveLength(1)
      expect(runtime?.unavailableCapabilities.some(item => item.id === 'playwright')).toBe(false)
      expect(runtime?.mcpConfigPath).toBeTruthy()
      const config = JSON.parse(await fs.readFile(runtime!.mcpConfigPath!, 'utf8')) as { mcpServers: Record<string, { command: string; args: string[] }> }
      const browser = config.mcpServers['trylo-browser']!
      expect(browser).toBeDefined()
      expect(browser.args).toContain('--native-browser-mcp')
      const tools = await listMcpTools(browser.command, browser.args, f.root)
      expect(tools).toContain('browser_navigate')
      expect(tools).toContain('browser_click')

      const state = await act(() => within(result.current.nativeBrowserOpen({ projectRoot: f.root, conversationId: 'one' })))
      expect(state.state).toBe('running')
      expect(state.tabs[0]?.id).toBe('real-target')
      expect(vi.mocked(nativeBrowserCommand).mock.calls.filter(([command]) => command.operation === 'ensure')).toHaveLength(2)

      // Native failures must return the actual cause, then allow retry.
      vi.mocked(nativeBrowserCommand).mockRejectedValueOnce(new Error('WebView2 creation rejected'))
      await expect(within(result.current.nativeBrowserOpen({ projectRoot: f.root, conversationId: 'failed' }))).rejects.toThrow('WebView2 creation rejected')
      await act(async () => { await expect(within(result.current.nativeBrowserOpen({ projectRoot: f.root, conversationId: 'one' }))).resolves.toMatchObject({ state: 'running' }) })
    } finally { unmount(); await f.close() }
  }, 30_000)
})
