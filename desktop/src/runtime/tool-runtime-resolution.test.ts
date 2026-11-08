// Trylo Desktop — Tool Profile resolution through the run path.
//
// Spec TRYLO-CORE-AGENT-TOOL-EXTENSION-TECHNICAL-SPEC §4.2 / §4.3 / §9.
// Pins the three contracts PR-1 must not break:
//   1. Work asks for `work.core.v1` and never inherits Code's Hermes argv.
//   2. Code without a Profile keeps the legacy Hermes degrade path, and a
//      resolver outage changes nothing observable.
//   3. A Profile change (or a permission change) never reuses a live
//      process — the full runtime contract decides, not the argv.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessExitInfo } from '../host-adapter/process-service'
import type { ResolvedToolRuntime } from '../tooling/types'
import { createToolRiskClassifier } from '../tooling/tool-risk-classifier'
import { TRACE_SUCCESS, traceLines } from '../host-adapter/trylo-v1-fixtures'

const spawned: Spawned[] = []
const stopCalls: string[] = []

interface Spawned {
  id: string
  onOutput: (line: string) => void
  onExit: (info: ProcessExitInfo) => void
  metadata: Record<string, string | undefined>
  label: string
  args: readonly string[]
  env: Record<string, string>
  promptLines: string[]
}

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage: ((msg: unknown) => void) | null = null
  },
  invoke: vi.fn(async () => undefined),
}))

vi.mock('../host-adapter/index', async () => ({
  hostAdapter: {
    process: {
      spawn: async (req: {
        command: string
        args: readonly string[]
        label: string
        env?: Record<string, string>
        metadata?: Record<string, string | undefined>
        onOutput: (line: string) => void
        onExit?: (info: ProcessExitInfo) => void
      }) => {
        const id = `proc-${spawned.length + 1}`
        spawned.push({
          id,
          onOutput: req.onOutput,
          onExit: (info) => req.onExit?.(info),
          metadata: req.metadata ?? {},
          label: req.label,
          args: req.args,
          env: req.env ?? {},
          promptLines: [],
        })
        return { id, pid: spawned.length, label: req.label, command: req.command }
      },
      send: async (processId: string, line: string) => {
        const s = spawned.find((x) => x.id === processId)
        if (s) s.promptLines.push(line)
      },
      stop: async (processId: string) => {
        stopCalls.push(processId)
      },
      list: async () => [],
    },
    fs: { readFile: async () => '', statFile: async () => ({ size: 0 }) },
  },
}))

// Round-3 P1-10: the pre-spawn runtime guard stays out of these suites (its
// own suite proves it with an injected probe); the mocked hostAdapter would
// otherwise hang every run on the real probe timeout.
vi.mock('./cli-runtime-guard', () => ({
  verifyCliRuntime: vi.fn(async () => ({ ok: true })),
  resetCliRuntimeGuardForTests: vi.fn(),
}))

vi.mock('../host-adapter/trylo-v1-runner', async (original) => {
  const actual = await original<typeof import('../host-adapter/trylo-v1-runner')>()
  return {
    ...actual,
    stopTryloV1: async (id: string) => {
      const { hostAdapter } = await import('../host-adapter/index')
      await hostAdapter.process.stop(id)
    },
  }
})
// Import AFTER the mock.
import { ConversationRunSupervisor } from './conversation-run-supervisor'
import type { SettingsForCodeRun } from './runtime-types'

const baseSettings: SettingsForCodeRun = {
  cliPath: 'D:/cli/cli.js',
  cwd: 'D:/work',
  apiKey: 'sk-test',
  apiFormat: 'openai',
  apiHost: 'https://api.example.com',
  apiModel: 'model-a',
  systemPrompt: 'global prompt',
}

function request(
  prompt: string,
  permissionLevel: SettingsForCodeRun extends never
    ? never
    : 'read_only' | 'ask' | 'workspace_write' | 'unrestricted' = 'workspace_write',
) {
  return {
    prompt,
    settings: baseSettings,
    codeMode: 'agent' as const,
    permissionLevel,
    priorMessages: [],
    onEvents: () => {},
  }
}

function runtime(profileId: string, revision = '1'): ResolvedToolRuntime {
  return {
    profileId,
    profileRevision: revision,
    surface: profileId.startsWith('work.') ? 'work' : 'code',
    mcpConfigPath: 'D:/profiles/mcp.json',
    mcpConfigHash: `hash-${profileId}-${revision}`,
    permissionSettingsPath: 'D:/profiles/settings.json',
    permissionSettingsHash: `sHash-${profileId}`,
    cliArgs: [
      '--mcp-config',
      'D:/profiles/mcp.json',
      '--settings',
      'D:/profiles/settings.json',
      '--strict-mcp-config',
    ],
    spawnEnv: { TRYLO_TOOL_PROFILE: profileId },
    serverNames: ['trylo-office'],
    packageHealth: [],
    unavailableCapabilities: [],
    strictMcpConfig: true,
    resolvedAt: 0,
  }
}

/** Finish the turn started on process `index`. */

beforeEach(() => {
  spawned.length = 0
  stopCalls.length = 0
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Tool Profile resolution (spec §4.2/§4.3)', () => {
  it('a Work run asks for its own Profile and spawns with the Profile argv', async () => {
    const seen: string[] = []
    const sup = new ConversationRunSupervisor({
      resolveToolRuntime: async (ctx) => {
        seen.push(`${ctx.surface}:${ctx.requestedProfileId ?? ''}`)
        return runtime('work.core.v1')
      },
    })
    await sup.runCode('proj', 'convA', {
      ...request('work task'),
      surface: 'work',
      requestedProfileId: 'work.core.v1',
    })

    expect(seen).toEqual(['work:work.core.v1'])
    // §4.2: the Profile flags travel with the spawn.
    expect(spawned[0]!.args).not.toContain('--strict-mcp-config')
    expect(spawned[0]!.args).not.toContain('D:/profiles/mcp.json')
    // §4.2: the Profile's process env reaches the child, and it may not
    // overwrite the auth env.
    expect(spawned[0]!.env.TRYLO_TOOL_PROFILE).toBe('work.core.v1')
    expect(spawned[0]!.env.TRYLO_OPENAI_API_KEY).toBe('sk-test')
  })

  it('an explicit toolRuntime:null skips the resolver entirely', async () => {
    let asked = 0
    const sup = new ConversationRunSupervisor({
      resolveToolRuntime: async () => {
        asked += 1
        return runtime('work.core.v1')
      },
    })
    await sup.runCode('proj', 'convA', { ...request('plain'), toolRuntime: null })
    expect(asked).toBe(0)
    expect(spawned[0]!.args).not.toContain('--strict-mcp-config')
  })

  it('a Work run without a Profile still injects TRYLO_TEAM_SURFACE and does not share a Code process', async () => {
    const sup = new ConversationRunSupervisor({
      resolveToolRuntime: async () => null,
    })
    await sup.runCode('proj', 'convA', { ...request('code'), surface: 'code', toolRuntime: null })

    await sup.runCode('proj', 'convA', { ...request('work'), surface: 'work', toolRuntime: null })
    expect(spawned).toHaveLength(2)
    expect(spawned[0]!.env.TRYLO_TEAM_SURFACE).toBeUndefined()
    expect(spawned[1]!.env.TRYLO_TEAM_SURFACE).toBe('work')
    expect(stopCalls).toContain('proc-1')
  })
})

describe('built-in context on the common Code/Work new and resumed run path', () => {
  it.each(['code', 'work'] as const)('%s appends the current snapshot on both session turns', async (surface) => {
    let resolved = {
      ...runtime(`${surface}.core.v1`),
      spawnEnv: { TRYLO_MCP_RUNTIME_REGISTRY: 'D:/profiles/runtime.json' },
      serverNames: ['trylo-office', 'trylo-browser', 'trylo-windows'],
    }
    const supervisor = new ConversationRunSupervisor({ resolveToolRuntime: async () => resolved })
    await supervisor.runCode('proj', 'current-chat', { ...request('first turn'), surface })
    const first = spawned[0]!
    const sessionId = first.args[first.args.indexOf('--session') + 1]!
    const firstContext = first.args[first.args.indexOf('--append-system-prompt') + 1]!
    expect(first.args).toContain('--session')
    for (const server of resolved.serverNames) expect(firstContext).toContain(`server=${server}`)
    expect(firstContext).toContain('global prompt')
    expect(firstContext.split('## 本轮内置工具')).toHaveLength(2)
    for (const line of traceLines(TRACE_SUCCESS))
      first.onOutput(line.replace(/"sessionId":"[^"]*"/g, `"sessionId":"${sessionId}"`))
    first.onExit({ id: first.id as ProcessExitInfo['id'], pid: 1, code: 0, signal: null, outputComplete: true })

    resolved = { ...resolved, serverNames: ['trylo-office'], unavailableCapabilities: [
      { id: 'playwright', type: 'package' as const, reasonCode: 'runtime_changed' as const,
        userMessage: 'D:/private/browser.exe' },
    ] }
    await supervisor.runCode('proj', 'current-chat', {
      ...request('continue'), surface, computerUse: false,
    })
    const resumed = spawned[1]!
    const resumedContext = resumed.args[resumed.args.indexOf('--append-system-prompt') + 1]!
    expect(resumed.args).toContain('--resume')
    expect(resumed.args).toContain(sessionId)
    expect(resumedContext).toContain('server=trylo-office')
    expect(resumedContext).toContain('浏览器：未就绪')
    expect(resumedContext).toContain('电脑控制：本轮明确未选用')
    expect(resumedContext).not.toMatch(/server=trylo-browser|server=trylo-windows|private/)
    expect(resumedContext.split('## 本轮内置工具')).toHaveLength(2)
    expect(resumed.promptLines).toHaveLength(1)
    expect(resumed.promptLines[0]).toContain('continue')
    expect(resumed.promptLines[0]).not.toContain('first turn')
    resumed.onExit({ id: resumed.id as ProcessExitInfo['id'], pid: 2, code: 0, signal: null, outputComplete: true })
  })
})

describe('PR-2: host risk classifier on the live control-request path (§6)', () => {
  const OFFICECLI_TOOL = 'mcp__trylo-office__officecli'

  /** The PR-1 runtime shape, with an AVAILABLE officecli in its health. */
  function workRuntime(): ResolvedToolRuntime {
    return {
      ...runtime('work.core.v1'),
      packageHealth: [
        {
          id: 'officecli',
          version: '1.0.145',
          displayName: 'OfficeCLI',
          adoption: 'trial',
          serverName: 'trylo-office',
          state: 'installed',
          available: true,
          detail: 'ok',
          autoUpdate: false,
          expectedTools: ['officecli'],
          protocol: 'not-checked',
          checkedAt: 0,
          reportedVersion: null,
          versionMatches: null,
        },
      ],
    }
  }

  function controlRequestLine(requestId: string, input: Record<string, unknown>): string {
    return JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'can_use_tool', tool_name: OFFICECLI_TOOL, input },
    })
  }

  function lastStdinResponse(index: number): {
    allowed: boolean
    message?: string
    requestId: string
  } {
    const line = spawned[index]!.promptLines.at(-1)!
    const parsed = JSON.parse(line.trim())
    return {
      allowed: parsed.response.response.behavior === 'allow',
      message: parsed.response.response.message as string | undefined,
      requestId: parsed.response.request_id,
    }
  }

  it('an in-workspace read at workspace_write is auto-answered allow, no UI', async () => {
    const sup = new ConversationRunSupervisor({
      resolveToolRuntime: async () => workRuntime(),
      riskClassifier: createToolRiskClassifier(),
    })
    await sup.runCode('proj', 'convA', {
      ...request('work task'),
      surface: 'work',
      requestedProfileId: 'work.core.v1',
    })

    spawned[0]!.onOutput(controlRequestLine('req-read', { command: 'view', file: 'docs/a.docx' }))
    await vi.waitFor(() => expect(spawned[0]!.promptLines.length).toBeGreaterThan(1))
    const response = lastStdinResponse(0)
    expect(response.allowed).toBe(true)
    expect(response.requestId).toBe('req-read')
    // §6.2: 自动批准也写安全审计摘要.
    expect(sup.toolRiskAudits()).toHaveLength(1)
    expect(sup.toolRiskAudits()[0]).toMatchObject({
      behavior: 'auto_allow',
      packageId: 'officecli',
    })
    // No approval card was ever projected.
    expect(sup.pendingCodePermissions()).toEqual([])
  })

  it('read_only denies a create before any human ever sees it (PR-2 验收)', async () => {
    const sup = new ConversationRunSupervisor({
      resolveToolRuntime: async () => workRuntime(),
      riskClassifier: createToolRiskClassifier(),
    })
    await sup.runCode('proj', 'convA', {
      ...request('work task'),
      permissionLevel: 'read_only',
      surface: 'work',
      requestedProfileId: 'work.core.v1',
    })

    spawned[0]!.onOutput(
      controlRequestLine('req-create', { command: 'create', output: '.trylo/out/a.docx' }),
    )
    await vi.waitFor(() => expect(spawned[0]!.promptLines.length).toBeGreaterThan(1))
    const response = lastStdinResponse(0)
    expect(response.allowed).toBe(false)
    expect(response.message).toContain('read-only')
    expect(sup.pendingCodePermissions()).toEqual([])
  })

  it('a workspace original modification prompts — pending with the safe preview (PR-2 验收)', async () => {
    const sup = new ConversationRunSupervisor({
      resolveToolRuntime: async () => workRuntime(),
      riskClassifier: createToolRiskClassifier(),
    })
    await sup.runCode('proj', 'convA', {
      ...request('work task'),
      surface: 'work',
      requestedProfileId: 'work.core.v1',
    })

    spawned[0]!.onOutput(controlRequestLine('req-orig', { command: 'set', file: 'docs/a.docx' }))
    await vi.waitFor(() => expect(sup.pendingCodePermissions()).toHaveLength(1))
    const pending = sup.pendingCodePermissions()[0]!
    expect(pending.risk).toBe('sensitive')
    expect(pending.preview?.target).toContain('docs/a.docx')
    // The original input stays untouched for the control_response round-trip.
    expect(pending.input).toEqual({ command: 'set', file: 'docs/a.docx' })
    // No stdin write happened yet — the human is the decision surface.
    expect(spawned[0]!.promptLines).toHaveLength(1) // only the user prompt
  })

  it('an unexpected tool on the managed server is denied, never guessed', async () => {
    const sup = new ConversationRunSupervisor({
      resolveToolRuntime: async () => workRuntime(),
      riskClassifier: createToolRiskClassifier(),
    })
    await sup.runCode('proj', 'convA', {
      ...request('work task'),
      surface: 'work',
      requestedProfileId: 'work.core.v1',
    })
    spawned[0]!.onOutput(
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-drift',
        request: { subtype: 'can_use_tool', tool_name: 'mcp__trylo-office__rogue', input: {} },
      }),
    )
    await vi.waitFor(() => expect(spawned[0]!.promptLines.length).toBeGreaterThan(1))
    const response = lastStdinResponse(0)
    expect(response.allowed).toBe(false)
    expect(response.message).toContain('pinned tool set')
    expect(sup.toolRiskAudits()[0]).toMatchObject({ reasonCode: 'unknown_tool' })
  })

  it('a built-in tool is untouched by the classifier (legacy approval path)', async () => {
    const sup = new ConversationRunSupervisor({
      resolveToolRuntime: async () => workRuntime(),
      riskClassifier: createToolRiskClassifier(),
    })
    await sup.runCode('proj', 'convA', {
      ...request('work task'),
      surface: 'work',
      requestedProfileId: 'work.core.v1',
    })
    spawned[0]!.onOutput(
      JSON.stringify({
        type: 'control_request',
        request_id: 'req-bash',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } },
      }),
    )
    // Let microtasks flush — a buggy auto-respond would have written by now.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(spawned[0]!.promptLines).toHaveLength(1)
    expect(sup.pendingCodePermissions().map((r) => r.requestId)).toEqual(['req-bash'])
  })
})
