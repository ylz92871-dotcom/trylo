// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeProcessFixture } from './cli-node-process.fixture'
import type { ProcessService } from './process-service'
import type { FilePath } from './types'
import type { LoopEvent } from './loop-events'
import { CodePermissionRegistry } from '../runtime/code-permission-registry'

const host = vi.hoisted(() => ({ service: null as ProcessService | null }))
vi.mock('./index', () => ({
  hostAdapter: {
    get process() {
      return host.service
    },
  },
}))
vi.mock('../runtime/cli-runtime-guard', () => ({
  verifyCliRuntime: vi.fn(async () => ({ ok: true })),
}))
const { CodeRunController } = await import('../runtime/code-run-controller')

interface ChatRequest {
  model: string
  messages: { role: string; content: unknown }[]
}

it('continues the same Desktop journal across model switches and retains both sides of the history', async () => {
  const scratch = resolve('../_workspace/cache/tests/model-switch')
  mkdirSync(scratch, { recursive: true })
  const root = mkdtempSync(join(scratch, 'live-'))
  const home = join(root, 'home'),
    cwd = join(root, 'workspace') as FilePath
  mkdirSync(home)
  mkdirSync(cwd)
  const requests: ChatRequest[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      requests.push(JSON.parse(body) as ChatRequest)
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: { content: `saved-assistant-reply-${requests.length}` },
              finish_reason: null,
            },
          ],
        })}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`,
      )
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('local model endpoint missing')
  const service = new NodeProcessFixture({
    ...process.env,
    TRYLO_HOME: home,
    TRYLO_API_KEY: '',
    TRYLO_OPENAI_API_KEY: '',
    TEMP: root,
    TMP: root,
  })
  host.service = service
  const controller = new CodeRunController({
    projectKey: 'model-switch',
    conversationId: 'same-chat',
    permissions: new CodePermissionRegistry({ onChange() {} }),
    onChange() {},
  })
  const events: LoopEvent[] = []
  const models = ['DeepSeek-V4-Flash', 'ark-code-latest', 'DeepSeek-V4-Flash']
  const prompts = [
    'Remember user-fact-7349.',
    'Continue with the other model.',
    'Switch back and continue.',
  ]
  try {
    for (let turn = 0; turn < models.length; turn += 1) {
      await controller.run({
        prompt: prompts[turn]!,
        permissionLevel: 'read_only',
        codeMode: 'agent',
        priorMessages: [],
        settings: {
          cwd,
          cliPath: resolve(
            process.env.TRYLO_DESKTOP_CLI_ENTRY ?? '../new trylo cli/dist/cmd/trylo/main.js',
          ) as FilePath,
          cliNodeProgram: process.execPath,
          apiFormat: 'openai',
          apiHost: `http://127.0.0.1:${address.port}/v1`,
          apiModel: models[turn],
          apiKey: 'local-model-switch-test',
        },
        onEvents: (batch) => events.push(...batch),
      })
      await vi.waitFor(() => expect(controller.getViewState().running).toBe(false), {
        timeout: 30000,
      })
      await Promise.all(service.exits.values())
      const terminals = events.filter((event) => event.type === 'loop_end')
      expect(terminals, service.stderr.join('\n')).toHaveLength(turn + 1)
      expect(terminals[turn], service.stderr.join('\n')).toMatchObject({ isError: false })
      expect(requests).toHaveLength(turn + 1)
    }
    expect(requests.map((request) => request.model)).toEqual(models)
    for (const request of requests.slice(1)) {
      expect(
        request.messages.some(
          (message) =>
            message.role === 'user' && JSON.stringify(message.content).includes('user-fact-7349'),
        ),
      ).toBe(true)
      expect(
        request.messages.some(
          (message) =>
            message.role === 'assistant' &&
            JSON.stringify(message.content).includes('saved-assistant-reply-1'),
        ),
      ).toBe(true)
    }
    expect(JSON.stringify(requests[2]!.messages)).toContain(prompts[1])
    expect(JSON.stringify(requests[2]!.messages)).toContain('saved-assistant-reply-2')
    const journals = readdirSync(join(home, 'sessions')).filter((name) => name.endsWith('.ndjson'))
    expect(journals).toHaveLength(1)
    const journal = readFileSync(join(home, 'sessions', journals[0]!), 'utf8')
    expect(journal).toContain('user-fact-7349')
    expect(journal).toContain('saved-assistant-reply-1')
    expect(journal).toContain('saved-assistant-reply-3')
    expect(service.argv[0]).toContain('--session')
    const sessionId = service.argv[0]![service.argv[0]!.indexOf('--session') + 1]
    for (const args of service.argv.slice(1)) {
      expect(args[args.indexOf('--resume') + 1]).toBe(sessionId)
      expect(args).not.toContain('--session')
    }
    const metadata = JSON.parse(
      readFileSync(join(home, 'sessions', journals[0]!.replace('.ndjson', '.meta.json')), 'utf8'),
    )
    expect(metadata.migrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: ['model'],
          to: expect.objectContaining({ model: 'ark-code-latest' }),
        }),
      ]),
    )
    expect(readdirSync(join(home, 'sessions')).filter((name) => name.endsWith('.lock'))).toEqual([])
    expect(service.children.size).toBe(0)
  } finally {
    writeFileSync(
      join(root, 'receipt.json'),
      JSON.stringify(
        {
          requests,
          wire: service.wire,
          stderr: service.stderr,
          argv: service.argv,
          view: controller.getViewState(),
        },
        null,
        2,
      ),
    )
    await controller.stop()
    await service.dispose()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
}, 100000)
