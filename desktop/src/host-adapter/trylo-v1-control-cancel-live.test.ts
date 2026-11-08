// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NodeProcessFixture } from './cli-node-process.fixture'
import type { ProcessService } from './process-service'
import type { FilePath } from './types'
import { CodePermissionRegistry } from '../runtime/code-permission-registry'
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
it('interrupts a real CLI waiting for approval, seals cancellation and releases its session lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'trylo-cancel-'))
  const home = join(root, 'home'),
    workspace = join(root, 'workspace') as FilePath
  mkdirSync(home)
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'package.json'), '{}')
  execFileSync('git', ['init', '--quiet', workspace], { windowsHide: true })
  const service = new NodeProcessFixture({
    ...process.env,
    TRYLO_HOME: home,
    TRYLO_API_KEY: '',
    TRYLO_OPENAI_API_KEY: '',
  })
  h.service = service
  const permissions = new CodePermissionRegistry({
    onChange() {},
    send: async (id, line) => {
      await service.send(id as never, line)
      return true
    },
  })
  const controller = new CodeRunController({
    projectKey: 'p',
    conversationId: 'cancel',
    permissions,
    onChange() {},
  })
  try {
    await controller.run({
      prompt: 'write the fixture',
      permissionLevel: 'ask',
      codeMode: 'agent',
      priorMessages: [],
      settings: {
        cwd: workspace,
        cliPath: resolve(
          process.env.TRYLO_DESKTOP_CLI_ENTRY ?? '../new trylo cli/dist/cmd/trylo/main.js',
        ) as FilePath,
        cliNodeProgram: process.execPath,
        providerId: 'fixture-write',
      },
      onEvents() {},
    })
    await vi.waitFor(() => expect(permissions.list()).toHaveLength(1), { timeout: 12000 })
    expect(existsSync(join(workspace, 'fixture-output.txt'))).toBe(false)
    await controller.stop()
    await Promise.all(service.exits.values())
    const terminals = service.wire.flatMap((line) => {
      try {
        const frame = JSON.parse(line) as { type: string; status: string }
        return frame.type === 'run_result' ? [frame] : []
      } catch {
        return []
      }
    })
    expect(terminals).toMatchObject([{ status: 'cancelled' }])
    expect(service.children.size).toBe(0)
    expect(permissions.list()).toEqual([])
    expect(existsSync(join(workspace, 'fixture-output.txt'))).toBe(false)
    expect(readdirSync(join(home, 'sessions')).filter((name) => name.endsWith('.lock'))).toEqual([])
    if (process.env.TRYLO_INTERACTION_PROOF_DIR)
      writeFileSync(
        join(process.env.TRYLO_INTERACTION_PROOF_DIR, 'cancel-live.json'),
        JSON.stringify(
          {
            terminalStatus: 'cancelled',
            terminalCount: terminals.length,
            processesRemaining: service.children.size,
            pendingApprovals: permissions.list().length,
            fileWritten: false,
            sessionLockReleased: true,
          },
          null,
          2,
        ),
      )
  } finally {
    await controller.stop()
    await service.dispose()
  }
}, 30000)
