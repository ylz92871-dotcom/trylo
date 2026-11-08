// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { NodeProcessFixture } from './cli-node-process.fixture'
import type { ProcessService } from './process-service'
import type { FilePath } from './types'
import type { LoopEvent } from './loop-events'
import { CodePermissionRegistry } from '../runtime/code-permission-registry'
import { createToolRiskClassifier } from '../tooling/tool-risk-classifier'
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

it.each(['read_only', 'ask', 'workspace_write', 'unrestricted'] as const)(
  'real CLI %s file execution matches its displayed mode',
  async (permissionLevel) => {
    const root = mkdtempSync(join(tmpdir(), 'trylo-mode-'))
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
    const events: LoopEvent[] = []
    const registry = new CodePermissionRegistry({
      onChange() {},
      riskClassifier: createToolRiskClassifier(),
      send: async (id, line) => {
        await service.send(id as never, line)
        return true
      },
    })
    const controller = new CodeRunController({
      projectKey: 'p',
      conversationId: 'mode',
      permissions: registry,
      onChange() {},
    })
    let prompts = 0
    try {
      await controller.run({
        prompt: 'write fixture output',
        permissionLevel,
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
        onEvents: (batch) => events.push(...batch),
      })
      if (permissionLevel === 'ask') {
        await vi.waitFor(() => expect(registry.list()).toHaveLength(1), { timeout: 12000 })
        expect(existsSync(join(workspace, 'fixture-output.txt'))).toBe(false)
        prompts++
        expect(await registry.respond(registry.list()[0]!.requestId, true)).toBe(true)
      }
      await vi.waitFor(() => expect(events.some((event) => event.type === 'loop_end')).toBe(true), {
        timeout: 12000,
      })
      await Promise.all(service.exits.values())
      expect(registry.list()).toEqual([])
      expect(service.children.size).toBe(0)
      const written = existsSync(join(workspace, 'fixture-output.txt'))
      expect(written).toBe(permissionLevel !== 'read_only')
      if (written)
        expect(readFileSync(join(workspace, 'fixture-output.txt'), 'utf8')).toContain('fixture')
      expect(prompts).toBe(permissionLevel === 'ask' ? 1 : 0)
      const tools = events.filter(
        (event): event is Extract<LoopEvent, { type: 'tool_result' }> =>
          event.type === 'tool_result',
      )
      expect(tools.length).toBeGreaterThan(0)
      expect(tools.every((event) => event.ok)).toBe(permissionLevel !== 'read_only')
      if (process.env.TRYLO_PERMISSION_PROOF_DIR)
        writeFileSync(
          join(process.env.TRYLO_PERMISSION_PROOF_DIR, `${permissionLevel}.json`),
          JSON.stringify(
            {
              permissionLevel,
              prompts,
              written,
              tools,
              terminalCount: events.filter((event) => event.type === 'loop_end').length,
              processes: service.children.size,
            },
            null,
            2,
          ),
        )
    } finally {
      await controller.stop()
      await service.dispose()
    }
  },
  30000,
)
