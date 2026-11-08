// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NodeProcessFixture } from './cli-node-process.fixture'
import type { ProcessService } from './process-service'
import type { FilePath, ProcessId } from './types'
import type { LoopEvent } from './loop-events'
import { setCliRuntimeResolution } from '../runtime/cli-runtime-resolution'
import { CodePermissionRegistry } from '../runtime/code-permission-registry'
import { applyEvents } from '../components/chat/events'
import { computeFileChanges } from '../components/chat/file-change'
import type { ToolMessage } from '../components/chat/types'

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

it('carries actual edit, multi-file patch, overwrite and notebook mutations from a real CLI to chat', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trylo-file-diff-'))
  const home = join(root, 'home'),
    cwd = join(root, 'workspace') as FilePath
  mkdirSync(home)
  mkdirSync(cwd)
  writeFileSync(join(cwd, 'index.html'), 'old\r\n')
  writeFileSync(join(cwd, 'snake.js'), 'old();\n')
  writeFileSync(join(cwd, 'gone.txt'), 'remove me\n')
  writeFileSync(
    join(cwd, 'analysis.ipynb'),
    JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        {
          id: 'cell',
          cell_type: 'code',
          metadata: {},
          execution_count: null,
          outputs: [],
          source: ['x = 1'],
        },
      ],
    }),
  )
  const steps = [
    { name: 'edit_file', arguments: { path: 'index.html', patch: '@@\n-old\n+edited\n' } },
    {
      name: 'apply_patch',
      arguments: {
        patch:
          '*** Begin Patch\n*** Update File: index.html\n@@\n-edited\n+patched\n*** Add File: fresh.txt\n+hello\n*** Update File: snake.js\n*** Move to: game.js\n@@\n-old();\n+new();\n*** Delete File: gone.txt\n*** End Patch',
      },
    },
    { name: 'write_file', arguments: { path: 'index.html', content: 'replaced\n' } },
    {
      name: 'notebook_edit',
      arguments: { path: 'analysis.ipynb', cell_id: 'cell', new_source: 'x = 2' },
    },
  ]
  let requests = 0
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const step = steps[requests++]
      const delta = step
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call-${requests}`,
                type: 'function',
                function: {
                  name: step.name,
                  arguments: JSON.stringify(step.arguments),
                },
              },
            ],
          }
        : { content: 'done' }
      response.write(
        'data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\n',
      )
      response.end(
        'data: ' +
          JSON.stringify({
            choices: [{ delta: {}, finish_reason: step ? 'tool_calls' : 'stop' }],
          }) +
          '\n\ndata: [DONE]\n\n',
      )
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server address missing')
  const entry = resolve(
    process.env.TRYLO_DESKTOP_CLI_ENTRY ?? '../new trylo cli/dist/cmd/trylo/main.js',
  ) as FilePath
  resetCliRuntimeGuardForTests()
  setCliRuntimeResolution({
    cliScript: entry,
    cliSource: 'dev-checkout',
    nodeProgram: process.execPath,
    nodeSource: 'env',
  })
  const service = new NodeProcessFixture({
    ...process.env,
    TRYLO_HOME: home,
    TRYLO_API_KEY: '',
    TRYLO_OPENAI_API_KEY: '',
  })
  h.service = service
  const controller = new CodeRunController({
    projectKey: 'diff',
    conversationId: 'diff',
    onChange() {},
    permissions: new CodePermissionRegistry({
      onChange() {},
      send: async (id, line) => {
        await service.send(id as ProcessId, line)
        return true
      },
    }),
  })
  const events: LoopEvent[] = []
  try {
    await controller.run({
      prompt: 'Exercise file mutation presentation.',
      codeMode: 'agent',
      permissionLevel: 'unrestricted',
      priorMessages: [],
      settings: {
        cwd,
        cliPath: entry,
        cliNodeProgram: process.execPath,
        apiFormat: 'openai',
        apiHost: `http://127.0.0.1:${address.port}/v1`,
        apiModel: 'local-diff-fixture',
        apiKey: 'local-fixture',
      },
      onEvents: (batch) => events.push(...batch),
    })
    await vi.waitFor(
      () => expect(events.filter((event) => event.type === 'loop_end')).toHaveLength(1),
      { timeout: 20000 },
    )
    await Promise.all(service.exits.values())
    expect(events.find((event) => event.type === 'loop_end')).toMatchObject({ isError: false })
    const tools = applyEvents([], events).filter(
      (message): message is ToolMessage => message.kind === 'tool',
    )
    expect(tools).toHaveLength(4)
    expect(tools.every((message) => message.status === 'done')).toBe(true)
    const changes = tools.map((message) =>
      computeFileChanges(message.tool, message.input, message.outputContent),
    )
    expect(changes[0]?.[0]).toMatchObject({ path: 'index.html', additions: 1, deletions: 1 })
    expect(changes[1]).toHaveLength(4)
    expect(changes[1]?.map((change) => change.operation)).toEqual([
      'patched',
      'created',
      'moved',
      'deleted',
    ])
    expect(changes[1]?.every((change) => change.basis === 'result')).toBe(true)
    expect(changes[2]?.[0]).toMatchObject({
      operation: 'overwritten',
      basis: 'content',
      isNew: false,
    })
    expect(changes[3]?.[0]?.lines.map((line) => line.text)).toEqual(['x = 2'])
    expect(readFileSync(join(cwd, 'index.html'), 'utf8')).toBe('replaced\n')
    expect(readFileSync(join(cwd, 'fresh.txt'), 'utf8')).toBe('hello\n')
    expect(readFileSync(join(cwd, 'game.js'), 'utf8')).toBe('new();\n')
    const cellSource: unknown = JSON.parse(readFileSync(join(cwd, 'analysis.ipynb'), 'utf8'))
      .cells[0].source
    expect(Array.isArray(cellSource) ? cellSource.join('') : cellSource).toBe('x = 2')
    expect(existsSync(join(cwd, 'snake.js')) || existsSync(join(cwd, 'gone.txt'))).toBe(false)
    expect(requests).toBe(5)
    expect(service.children.size).toBe(0)
    if (process.env.TRYLO_FILE_DIFF_PROOF)
      writeFileSync(
        process.env.TRYLO_FILE_DIFF_PROOF,
        JSON.stringify(
          {
            entry,
            requests,
            toolStatuses: tools.map((message) => message.status),
            changes,
            childrenAfter: service.children.size,
          },
          null,
          2,
        ),
      )
  } finally {
    await controller.stop()
    await service.dispose()
    setCliRuntimeResolution(null)
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    rmSync(root, { recursive: true, force: true })
  }
}, 35000)
