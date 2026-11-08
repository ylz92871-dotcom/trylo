// @vitest-environment node
import { expect, it, onTestFinished, vi } from 'vitest'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createToolRiskClassifier } from '../tooling/tool-risk-classifier'
import { NodeProcessFixture } from './cli-node-process.fixture'
import type { ProcessService } from './process-service'
import type { FilePath } from './types'
import type { LoopEvent } from './loop-events'
import type { ResolvedToolRuntime } from '../tooling/types'
import { applyEvents } from '../components/chat/events'
import { toolPreviewState } from '../tooling/tool-preview-state'
import { createNativeBrowserEngine } from './native-browser-engine.fixture'

const h = vi.hoisted(() => ({ service: null as ProcessService | null }))
vi.mock('./index', () => ({
  hostAdapter: {
    get process() {
      return h.service
    },
  },
}))
vi.mock('../runtime/cli-runtime-guard', () => ({
  verifyCliRuntime: vi.fn(async () => ({ ok: true })),
}))
const { CodeRunController } = await import('../runtime/code-run-controller')
const { CodePermissionRegistry } = await import('../runtime/code-permission-registry')

it.each([
  { surface: 'code', level: 'ask', denied: false },
  { surface: 'code', level: 'workspace_write', denied: false },
  { surface: 'code', level: 'unrestricted', denied: false },
  { surface: 'code', level: 'ask', denied: true },
  { surface: 'work', level: 'workspace_write', denied: false },
  { surface: 'code', level: 'workspace_write', denied: false, local: true },
  { surface: 'code', level: 'workspace_write', denied: true, local: true },
  { surface: 'code', level: 'unrestricted', denied: false, local: true },
] as const)(
  'Desktop $surface $level (local=$local, denied=$denied) uses its actual scoped MCP browser and honors approval',
  async (scenario) => {
    const { surface, level: permissionLevel, denied } = scenario
    const local = 'local' in scenario && scenario.local
    const scenarioTag = local ? 'local-page' : 'remote-page'
    const root = mkdtempSync(join(tmpdir(), 'trylo-browser-controller-'))
    const home = join(root, 'home'),
      workspace = join(root, 'workspace') as FilePath
    mkdirSync(home)
    mkdirSync(workspace)
    writeFileSync(join(workspace, 'package.json'), '{}')
    execFileSync('git', ['init', '--quiet', workspace], { windowsHide: true })
    writeFileSync(
      join(workspace, 'index.html'),
      `<!doctype html><button onclick="this.textContent='CLI_BROWSER_OK'">Open</button>`,
    )
    const browser = await createNativeBrowserEngine(
      join(root, 'chromium'),
      workspace,
      'cli-browser-proof',
    )
    onTestFinished(() => browser.dispose())
    const outputs: { topic: string; data: Record<string, unknown> }[] = []
    const { createToolingServices } =
      // @ts-expect-error Node sidecar exposes JavaScript, exercised through its real public API.
      await import('../../../desktop-services/src/tooling/index.mjs')
    const tooling = createToolingServices({
      appDataDir: root,
      ...(process.env.TRYLO_BROWSER_HOST_ENTRY
        ? { hostEntrypoint: process.env.TRYLO_BROWSER_HOST_ENTRY }
        : {}),
      emit: (topic: string, data: Record<string, unknown>) => {
        outputs.push({ topic, data })
        if (topic === 'tooling.nativeBrowserCommand')
          void browser.command(data as never).then(
            (result) => tooling.nativeBrowserCommandResult({ id: data.id, result }),
            (error) => tooling.nativeBrowserCommandResult({ id: data.id, error: String(error) }),
          )
      },
    })
    const requests: {
      tools?: { function: { name: string } }[]
      messages: { role: string; content?: string }[]
    }[] = []
    const server = createServer((incoming, outgoing) => {
      let body = ''
      incoming.setEncoding('utf8')
      incoming.on('data', (chunk) => {
        body += chunk
      })
      incoming.on('end', async () => {
        if (incoming.url === '/task') {
          outgoing.end(
            '<title>Trylo CLI proof</title><button onclick="this.textContent=\'CLI_BROWSER_OK\'">Verify</button>',
          )
          return
        }
        if (incoming.method !== 'POST') {
          outgoing.writeHead(404)
          outgoing.end()
          return
        }
        const request = JSON.parse(body) as (typeof requests)[number]
        requests.push(request)
        const results = request.messages.filter((message) => message.role === 'tool')
        const port = (server.address() as { port: number }).port
        const call =
          results.length === 0
            ? {
                name: 'mcp__trylo-browser__browser_navigate',
                arguments: JSON.stringify({
                  url: local
                    ? pathToFileURL(join(workspace, 'index.html')).href
                    : `http://127.0.0.1:${port}/task`,
                }),
              }
            : results.length === 1 && !denied
              ? {
                  name: 'mcp__trylo-browser__browser_evaluate',
                  arguments: JSON.stringify({
                    function:
                      "() => { const b=document.querySelector('button'); b.click(); return b.textContent; }",
                  }),
                }
              : null
        outgoing.writeHead(200, { 'content-type': 'text/event-stream' })
        const delta = (value: Record<string, unknown>, finish: string | null = null) =>
          outgoing.write(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`,
          )
        delta({
          content: call
            ? '正在验证浏览器操作。'
            : denied
              ? '用户拒绝了浏览器操作。'
              : '已验证 CLI_BROWSER_OK。',
        })
        if (call)
          delta({
            tool_calls: [
              { index: 0, id: `call-${results.length}`, type: 'function', function: call },
            ],
          })
        delta({}, call ? 'tool_calls' : 'stop')
        outgoing.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const service = new NodeProcessFixture({
      ...process.env,
      TRYLO_HOME: home,
      TRYLO_API_KEY: '',
      TRYLO_OPENAI_API_KEY: '',
    })
    h.service = service
    let approvalRequests = 0
    const registry = new CodePermissionRegistry({
      riskClassifier: createToolRiskClassifier(),
      onChange: () => {
        for (const request of registry.list()) {
          approvalRequests++
          void registry.respond(request.requestId, !denied)
        }
      },
      send: async (id, line) => {
        await service.send(id as never, line)
        return true
      },
    })
    const controller = new CodeRunController({
      projectKey: 'p',
      conversationId: 'cli-browser-proof',
      onChange: () => {},
      permissions: registry,
    })
    const events: LoopEvent[] = []
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      const scope = { projectRoot: workspace, conversationId: 'cli-browser-proof' }
      const runtime = await tooling.resolveProfile({ ...scope, surface, computerUse: false })
      expect(runtime.ok).toBe(true)
      expect(runtime.serverNames, JSON.stringify(runtime.unavailableCapabilities)).toContain(
        'trylo-browser',
      )
      let finished: () => void = () => {}
      const terminal = new Promise<void>((done) => {
        finished = done
      })
      const run = controller.run({
        prompt: 'Open the test page, click its button, and report the observed result.',
        permissionLevel,
        codeMode: 'agent',
        priorMessages: [],
        surface,
        requestedProfileId: `${surface}.core.v1`,
        toolRuntime: runtime as ResolvedToolRuntime,
        settings: {
          cliPath: (process.env.TRYLO_BROWSER_CLI_ENTRY ??
            resolve(
              process.env.TRYLO_DESKTOP_CLI_ENTRY ?? '../new trylo cli/dist/cmd/trylo/main.js',
            )) as FilePath,
          cliNodeProgram: process.env.TRYLO_BROWSER_CLI_NODE ?? process.execPath,
          cwd: workspace,
          providerId: 'openai-compatible',
          apiFormat: 'openai',
          apiHost: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
          apiModel: 'local-contract',
          apiKey: 'local-contract',
        },
        onEvents: (batch) => {
          events.push(...batch)
          if (batch.some((event) => event.type === 'loop_end')) finished()
        },
      })
      await Promise.race([
        (async () => {
          await run
          await terminal
          await Promise.all(service.exits.values())
        })(),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error('CLI browser proof exceeded its deadline')),
            60000,
          )
        }),
      ])
      expect(
        requests[0]?.tools?.some(
          (tool) => tool.function.name === 'mcp__trylo-browser__browser_navigate',
        ),
        JSON.stringify({
          terminal: events.filter((event) => event.type === 'loop_end'),
          stderr: service.stderr,
          requestTools: requests.map((request) => request.tools?.map((tool) => tool.function.name)),
          toolResults: events.filter((event) => event.type === 'tool_result'),
        }),
      ).toBe(true)
      expect(events.filter((event) => event.type === 'loop_end')).toMatchObject([
        { isError: denied },
      ])
      expect(approvalRequests).toBe(permissionLevel === 'unrestricted' ? 0 : denied ? 1 : 2)
      const observed = await browser.observe()
      const browserStates = outputs.filter((event) => event.topic === 'tooling.nativeBrowserState')
      expect(browserStates.length).toBeGreaterThan(0)
      expect(browserStates.every((event) => event.data.scope === browser.scope)).toBe(true)
      expect(browser.commands.every((command) => command.scope === browser.scope)).toBe(true)
      expect(observed.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
      if (process.env.TRYLO_BROWSER_PROOF_DIR) {
        const name = `cli-${surface}-${permissionLevel}-${scenarioTag}-denied-${denied}`
        writeFileSync(join(process.env.TRYLO_BROWSER_PROOF_DIR, `${name}.png`), observed.png)
        writeFileSync(
          join(process.env.TRYLO_BROWSER_PROOF_DIR, `${name}.json`),
          JSON.stringify(
            {
              surface,
              permissionLevel,
              denied,
              approvalRequests,
              terminal: events.filter((event) => event.type === 'loop_end'),
              toolResults: events.filter((event) => event.type === 'tool_result'),
              browserStateCount: browserStates.length,
              browserScopes: [...new Set(browserStates.map((event) => event.data.scope))],
              observed: { url: observed.url, text: observed.text, pngBytes: observed.png.length },
              computerControl: false,
              nativeWebView: false,
            },
            null,
            2,
          ),
        )
      }
      const state = toolPreviewState(applyEvents([], events), 'browser', { running: false })
      if (denied) {
        expect(state.stepCount).toBe(1)
        expect(events.some((event) => event.type === 'tool_result' && !event.ok)).toBe(true)
        expect(outputs.some((event) => event.topic === 'tooling.viewportFrame')).toBe(false)
        expect(
          events.some((event) => event.type === 'tool_result' && event.output.includes('### Page')),
        ).toBe(false)
        expect(observed.url.startsWith('about:blank')).toBe(true)
        expect(observed.text).not.toContain('CLI_BROWSER_OK')
        return
      }
      expect(state.stepCount).toBe(2)
      expect(state.actions?.every((action) => action.status === '已完成')).toBe(true)
      expect(
        events.some(
          (event) => event.type === 'tool_result' && event.output.includes('CLI_BROWSER_OK'),
        ),
      ).toBe(true)
      expect(
        events.some(
          (event) =>
            event.type === 'runtime_warning' && event.code === 'desktop_profile_unavailable',
        ),
      ).toBe(false)
      if (local) expect(observed.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+\/index\.html$/)
      else
        expect(observed.url).toBe(
          `http://127.0.0.1:${(server.address() as { port: number }).port}/task`,
        )
      expect(observed.text).toBe('CLI_BROWSER_OK')
      expect(service.children.size).toBe(0)
    } finally {
      clearTimeout(deadline)
      await controller.stop()
      await service.dispose()
      tooling.dispose()
      await browser.dispose()
      server.closeAllConnections()
      server.close()
    }
  },
  120000,
)
