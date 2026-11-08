// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NodeProcessFixture } from './cli-node-process.fixture'
import type { ProcessService } from './process-service'
import type { FilePath } from './types'
import type { LoopEvent } from './loop-events'
import { CodePermissionRegistry } from '../runtime/code-permission-registry'
import { setCliRuntimeResolution } from '../runtime/cli-runtime-resolution'

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

it('starts repeated keyed OpenAI turns without redundant credential subprocesses', async () => {
  resetCliRuntimeGuardForTests()
  const entry = resolve(
    process.env.TRYLO_DESKTOP_CLI_ENTRY ?? '../new trylo cli/dist/cmd/trylo/main.js',
  ) as FilePath
  setCliRuntimeResolution({
    cliScript: entry,
    cliSource: 'dev-checkout',
    nodeProgram: process.execPath,
    nodeSource: 'env',
  })
  const root = mkdtempSync(join(tmpdir(), 'trylo-startup-'))
  const home = join(root, 'home'),
    cwd = join(root, 'workspace') as FilePath
  mkdirSync(home)
  mkdirSync(cwd)
  execFileSync('git', ['init', '--quiet', cwd], { windowsHide: true })
  const requests: { elapsedMs: number; authenticated: boolean }[] = []
  let startedAt = 0
  const server = createServer((incoming, outgoing) => {
    incoming.resume()
    incoming.on('end', () => {
      requests.push({
        elapsedMs: performance.now() - startedAt,
        authenticated: incoming.headers.authorization === 'Bearer local-startup-test',
      })
      outgoing.writeHead(200, { 'content-type': 'text/event-stream' })
      outgoing.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'STARTUP_OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      )
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture endpoint')
  const service = new NodeProcessFixture({
    ...process.env,
    TRYLO_HOME: home,
    TRYLO_API_KEY: '',
    TRYLO_OPENAI_API_KEY: '',
  })
  h.service = service
  const permissions = new CodePermissionRegistry({ onChange() {}, send: async () => true })
  const controller = new CodeRunController({
    projectKey: 'startup',
    conversationId: 'conversation',
    permissions,
    onChange() {},
  })
  const measurements: {
    turn: number
    requestMs: number
    subprocesses: number
    statusSubprocesses: number
  }[] = []
  try {
    for (let turn = 0; turn < 3; turn++) {
      const offset = service.argv.length
      const events: LoopEvent[] = []
      startedAt = performance.now()
      await controller.run({
        prompt: 'Reply STARTUP_OK.',
        codeMode: 'agent',
        permissionLevel: 'workspace_write',
        priorMessages: [],
        settings: {
          cwd,
          cliPath: entry,
          cliNodeProgram: process.execPath,
          apiFormat: 'openai',
          apiHost: `http://127.0.0.1:${address.port}/v1`,
          apiModel: 'startup-test',
          apiKey: 'local-startup-test',
        },
        onEvents: (batch) => events.push(...batch),
      })
      await vi.waitFor(
        () => expect(events.filter((event) => event.type === 'loop_end')).toHaveLength(1),
        { timeout: 15000 },
      )
      await Promise.all(service.exits.values())
      expect(events.find((event) => event.type === 'loop_end')).toMatchObject({ isError: false })
      expect(requests[turn]?.authenticated).toBe(true)
      const argv = service.argv.slice(offset)
      measurements.push({
        turn: turn + 1,
        requestMs: Math.round(requests[turn]!.elapsedMs),
        subprocesses: argv.length,
        statusSubprocesses: argv.filter(
          (args) => args.includes('status') || args.includes('providers'),
        ).length,
      })
    }
    if (process.env.TRYLO_STARTUP_PROOF_FILE)
      writeFileSync(
        process.env.TRYLO_STARTUP_PROOF_FILE,
        JSON.stringify(
          {
            measurements,
            requests: requests.length,
            resumed: service.argv.some((args) => args.includes('--resume')),
            processesRemaining: service.children.size,
          },
          null,
          2,
        ),
      )
    expect(measurements.map((row) => row.statusSubprocesses)).toEqual([0, 0, 0])
    expect(measurements[0]?.subprocesses).toBe(2)
    expect(measurements.slice(1).map((row) => row.subprocesses)).toEqual([1, 1])
    expect(service.children.size).toBe(0)
  } finally {
    await controller.stop()
    await service.dispose()
    setCliRuntimeResolution(null)
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
}, 60000)
