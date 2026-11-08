// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NodeProcessFixture } from './cli-node-process.fixture'
import type { ProcessService } from './process-service'
import type { FilePath } from './types'
import type { LoopEvent } from './loop-events'
import { setCliRuntimeResolution } from '../runtime/cli-runtime-resolution'
import { CodePermissionRegistry } from '../runtime/code-permission-registry'

const h = vi.hoisted(() => ({ service: null as ProcessService | null }))
vi.mock('./index', () => ({
  hostAdapter: {
    get process() {
      return h.service
    },
    fs: { statFile: (file: string) => statSync(file) },
  },
}))
const { CodeRunController } = await import('../runtime/code-run-controller')
const { resetCliRuntimeGuardForTests } = await import('../runtime/cli-runtime-guard')

it('delivers later short reasoning through the real CLI before the HTTP stream finishes', async () => {
  const entry = resolve(
    process.env.TRYLO_DESKTOP_CLI_ENTRY ?? '../new trylo cli/dist/cmd/trylo/main.js',
  ) as FilePath
  const root = mkdtempSync(join(tmpdir(), 'trylo-cadence-'))
  const home = join(root, 'home'),
    cwd = join(root, 'workspace') as FilePath
  mkdirSync(home)
  mkdirSync(cwd)
  resetCliRuntimeGuardForTests()
  setCliRuntimeResolution({
    cliScript: entry,
    cliSource: 'dev-checkout',
    nodeProgram: process.execPath,
    nodeSource: 'env',
  })
  let finishResponse: (() => void) | undefined
  let sendReasoning: ((text: string) => void) | undefined
  let responseEnded = false
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const frame = (delta: Record<string, string>) =>
        response.write(
          'data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\n',
        )
      sendReasoning = (text) => {
        frame({ reasoning_content: text })
      }
      sendReasoning('first')
      finishResponse = () => {
        if (responseEnded) return
        frame({ content: 'done' })
        responseEnded = true
        response.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      }
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('local server missing')
  const service = new NodeProcessFixture({
    ...process.env,
    TRYLO_HOME: home,
    TRYLO_API_KEY: '',
    TRYLO_OPENAI_API_KEY: '',
  })
  h.service = service
  const controller = new CodeRunController({
    projectKey: 'cadence',
    conversationId: 'conversation',
    permissions: new CodePermissionRegistry({ onChange() {}, send: async () => true }),
    onChange() {},
  })
  const events: LoopEvent[] = []
  try {
    await controller.run({
      prompt: 'Reply done.',
      codeMode: 'agent',
      permissionLevel: 'workspace_write',
      priorMessages: [],
      settings: {
        cwd,
        cliPath: entry,
        cliNodeProgram: process.execPath,
        apiFormat: 'openai',
        apiHost: `http://127.0.0.1:${address.port}/v1`,
        apiModel: 'cadence',
        apiKey: 'local-cadence-test',
      },
      onEvents: (batch) => events.push(...batch),
    })
    await vi.waitFor(() => expect(finishResponse).toBeTypeOf('function'), { timeout: 45000 })
    await vi.waitFor(
      () =>
        expect(
          events.some((event) => event.type === 'thinking' && event.preview === 'first'),
          JSON.stringify({
            state: controller.getViewState(),
            events,
            stderr: service.stderr,
            wire: service.wire.filter((line) => line.startsWith('{')).slice(-8),
          }),
        ).toBe(true),
      { timeout: 1000 },
    )
    for (const fragment of [' second', ' third']) {
      sendReasoning!(fragment)
      const expected = fragment === ' second' ? 'first second' : 'first second third'
      await vi.waitFor(
        () =>
          expect(
            events.some(
              (event) => event.type === 'thinking' && event.preview === expected && event.partial,
            ),
          ).toBe(true),
        { timeout: 1000 },
      )
      expect(responseEnded).toBe(false)
    }
    expect(responseEnded).toBe(false)
    expect(events.some((event) => event.type === 'loop_end')).toBe(false)
    finishResponse!()
    await vi.waitFor(
      () => expect(events.filter((event) => event.type === 'loop_end')).toHaveLength(1),
      { timeout: 10000 },
    )
    await Promise.all(service.exits.values())
    expect(events.find((event) => event.type === 'loop_end')).toMatchObject({ isError: false })
    expect(service.children.size).toBe(0)
  } finally {
    finishResponse?.()
    await controller.stop()
    await service.dispose()
    setCliRuntimeResolution(null)
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
}, 70000)
