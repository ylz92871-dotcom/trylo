// Trylo Desktop — ConversationRunSupervisor / CodeRunController tests.
//
// v1.16.6 (M4-A runtime ownership). Covers the spec §11.1 Code
// lifecycle requirements that moved OUT of App.tsx and into the
// supervisor:
//   - runs are keyed by (projectKey, conversationId) — two Code
//     conversations never share a process or a run state;
//   - Stop A does not affect B (scoped stop);
//   - a child that exits on its own (process.exited) clears only
//     its own conversation's binding;
//   - the warm path reuses the same conversation's idle CLI;
//   - background write-back stays on the original conversation.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessExitInfo } from '../host-adapter/process-service'

interface Spawned {
  id: string
  onOutput: (line: string) => void
  onExit: (info: ProcessExitInfo) => void
  metadata: Record<string, string | undefined>
  label: string
  promptLines: string[]
}

const spawned: Spawned[] = []
const stopCalls: string[] = []
// When true, `process.spawn` waits on a released promise so tests
// can deterministically interleave a stop during an in-flight spawn
// (guard branch, §11.1 gap #2).
let holdSpawn = false
let releaseSpawn: () => void = () => {}
let failSpawn = false
let failStop = false

vi.mock('@tauri-apps/api/core', () => {
  return {
    Channel: class {
      onmessage: ((msg: unknown) => void) | null = null
    },
    invoke: vi.fn(async () => undefined),
  }
})

vi.mock('../host-adapter/index', async () => {
  return {
    hostAdapter: {
      process: {
        spawn: async (req: {
          command: string
          args: readonly string[]
          label: string
          cwd?: string
          env?: Record<string, string>
          metadata?: Record<string, string | undefined>
          onOutput: (line: string) => void
          onExit?: (info: ProcessExitInfo) => void
        }) => {
          if (failSpawn) throw new Error('spawn unavailable')
          if (holdSpawn) {
            await new Promise<void>((resolve) => {
              releaseSpawn = resolve
            })
          }
          const id = `proc-${spawned.length + 1}`
          spawned.push({
            id,
            onOutput: req.onOutput,
            onExit: (info) => req.onExit?.(info),
            metadata: req.metadata ?? {},
            label: req.label,
            promptLines: [],
          })
          return { id, pid: spawned.length, label: req.label, command: req.command }
        },
        send: async (processId: string, line: string) => {
          const s = spawned.find((x) => x.id === processId)
          if (s) {
            s.promptLines.push(line)
            const frame = JSON.parse(line)
            if (frame.type === 'subagent_input')
              s.onOutput(
                JSON.stringify({
                  type: 'subagent_input_result',
                  requestId: frame.requestId,
                  accepted: true,
                }),
              )
          }
        },
        stop: async (processId: string) => {
          stopCalls.push(processId)
          if (failStop) throw new Error('native stop failed')
        },
        list: async () =>
          failStop
            ? spawned.map((s) => ({ id: s.id, pid: 1, label: s.label, command: 'node' }))
            : [],
      },
      fs: { readFile: async () => '', statFile: async () => ({ size: 0 }) },
    },
  }
})

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
      stopCalls.push(id)
      if (failStop) throw new Error('native stop failed')
    },
  }
})
// Import AFTER the mock.
import { ConversationRunSupervisor } from './conversation-run-supervisor'
import type { SettingsForCodeRun } from './runtime-types'

it('expires an orphaned approval when stopping its conversation, preserving other workspaces', async () => {
  const supervisor = new ConversationRunSupervisor()
  const frame = {
    kind: 'permission' as const,
    requestId: 'stale-approval',
    toolName: 'run_shell',
    input: { command: 'Get-ChildItem' },
  }
  supervisor
    .libraryApprovalPort({ projectKey: 'project-a', conversationId: 'chat' })
    .receive(frame, 'orphan-a')
  supervisor
    .libraryApprovalPort({ projectKey: 'project-b', conversationId: 'chat' })
    .receive({ ...frame, requestId: 'other-approval' }, 'other-b')
  await supervisor.stopConversation('project-a', 'chat')
  expect(supervisor.pendingCodePermissions().map((request) => request.requestId)).toEqual([
    'other-approval',
  ])
  expect(await supervisor.respondCodePermission('stale-approval', true)).toBe(false)
})

const baseSettings: SettingsForCodeRun = {
  cliPath: 'D:/cli/cli.js',
  cwd: 'D:/work',
}

function request(prompt: string) {
  return {
    prompt,
    settings: baseSettings,
    codeMode: 'agent' as const,
    // P2: the level is required. Tests use the recommended
    // default; specific runs in this file don't assert on
    // the CLI argv (a different test owns the policy mapping).
    permissionLevel: 'workspace_write' as const,
    priorMessages: [],
    onEvents: () => {},
  }
}

function loopEnd(): void {
  spawned[0]!.onOutput(
    JSON.stringify({
      type: 'run_result',
      status: 'completed',
      sessionId: 'fixture-session',
      turnId: 'fixture-turn',
      finishReason: 'stop',
      iterations: 1,
      durationMs: 1,
      lastMessage: 'done',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }),
  )
}

beforeEach(() => {
  spawned.length = 0
  stopCalls.length = 0
  holdSpawn = false
  failSpawn = false
  failStop = false
  releaseSpawn = () => {}
})

afterEach(() => {
  spawned.length = 0
  stopCalls.length = 0
  holdSpawn = false
  failSpawn = false
  releaseSpawn = () => {}
})

describe('ConversationRunSupervisor (M4-A Code lifecycle)', () => {
  it('steers a live turn without creating a second run or process', async () => {
    const sup = new ConversationRunSupervisor()
    await sup.runCode('proj', 'convA', request('start'))
    const before = sup.getViewState('proj', 'convA')
    const linesBefore = spawned[0]!.promptLines.length

    // Round-3 P0-5: reason-typed. The frame really reached the running CLI —
    // that is the only success claim anyone can honestly make here.
    await expect(sup.steerCode('proj', 'convA', '改用更简单的方案')).resolves.toEqual({
      kind: 'delivered',
    })

    const after = sup.getViewState('proj', 'convA')
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.promptLines).toHaveLength(linesBefore + 1)
    expect(spawned[0]!.promptLines.at(-1)).toContain('改用更简单的方案')
    expect(after.runId).toBe(before.runId)
    expect(after.running).toBe(true)
  })

  it('stopTask sends a correlated new CLI subagent cancellation', async () => {
    const sup = new ConversationRunSupervisor()
    await sup.runCode('proj', 'convA', request('start'))
    await expect(sup.stopTask('proj', 'convA', 'tool-seat-w')).resolves.toBe(true)
    const last = spawned[0]!.promptLines.at(-1)
    expect(last).toBeTruthy()
    const parsed = JSON.parse(last!.trim()) as {
      type: string
      action: string
      target: string
    }
    expect(parsed.type).toBe('subagent_input')
    expect(parsed.action).toBe('cancel')
    expect(parsed.target).toBe('tool-seat-w')
    expect(spawned).toHaveLength(1)
  })

  it('keeps two conversations fully independent', async () => {
    const sup = new ConversationRunSupervisor()
    await sup.runCode('proj', 'convA', request('a'))
    await sup.runCode('proj', 'convB', request('b'))
    expect(spawned).toHaveLength(2)
    const pidA = sup.getViewState('proj', 'convA').activeProcessId
    const pidB = sup.getViewState('proj', 'convB').activeProcessId
    expect(pidA).not.toBe(pidB)
  })

  it('Stop A does not affect B (scoped stop)', async () => {
    const sup = new ConversationRunSupervisor()
    await sup.runCode('proj', 'convA', request('a'))
    await sup.runCode('proj', 'convB', request('b'))
    await sup.stopConversation('proj', 'convA')
    expect(stopCalls).toContain('proc-1')
    expect(stopCalls).not.toContain('proc-2')
    expect(sup.getViewState('proj', 'convA').running).toBe(false)
    expect(sup.getViewState('proj', 'convB').running).toBe(true)
  })

  it('a child exit clears only its own conversation binding', async () => {
    const sup = new ConversationRunSupervisor()
    await sup.runCode('proj', 'convA', request('a'))
    await sup.runCode('proj', 'convB', request('b'))
    // A's child dies mid-run → A is marked failed/stopped; B is untouched.
    spawned[0]!.onExit({ id: 'proc-1', pid: 1, code: 1, signal: null })
    const viewA = sup.getViewState('proj', 'convA')
    expect(viewA.running).toBe(false)
    expect(viewA.activeProcessId).toBeNull()
    expect(viewA.error).toBe(true) // died while busy = crash
    expect(sup.getViewState('proj', 'convB').running).toBe(true)
  })

  it('an idle child exiting is not an error', async () => {
    const sup = new ConversationRunSupervisor()
    await sup.runCode('proj', 'convA', request('a'))
    loopEnd() // idle
    spawned[0]!.onExit({ id: 'proc-1', pid: 1, code: 0, signal: null })
    expect(sup.getViewState('proj', 'convA').running).toBe(false)
    expect(sup.getViewState('proj', 'convA').error).toBe(false)
  })

  it('activeCodeRuns reflects in-flight runs only', async () => {
    const sup = new ConversationRunSupervisor()
    await sup.runCode('proj', 'convA', request('a'))
    await sup.runCode('proj', 'convB', request('b'))
    expect(sup.activeCodeRuns()).toHaveLength(2)
    loopEnd()
    const active = sup.activeCodeRuns()
    expect(active).toHaveLength(1)
    expect(active[0]!.conversationId).toBe('convB')
  })

  // ── Audit corrections (M4-A follow-up) ───────────────────────

  it('removeConversation ends a run even when it is not (and cannot be) the visible one (P0-1)', async () => {
    const sup = new ConversationRunSupervisor()
    await sup.runCode('proj', 'convA', request('a'))
    await sup.runCode('proj', 'convB', request('b'))
    // Deleting convA while its (possibly background) run is in
    // flight must stop THAT run and drop its controller — it must
    // not become an orphan that keeps projecting to a deleted
    // conversation, and Stop B is untouched.
    await sup.removeConversation('proj', 'convA')
    expect(stopCalls).toContain('proc-1')
    expect(stopCalls).not.toContain('proc-2')
    // Controller is gone → getViewState falls back to idle default.
    expect(sup.getViewState('proj', 'convA').running).toBe(false)
    expect(sup.getViewState('proj', 'convB').running).toBe(true)
    expect(sup.activeCodeRuns().map((r) => r.conversationId)).toEqual(['convB'])
  })

  it('retains a conversation controller when native stop fails during removal', async () => {
    const sup = new ConversationRunSupervisor()
    await sup.runCode('proj', 'conv-kept', request('keep the owner'))
    failStop = true
    try {
      await expect(Promise.resolve(sup.removeConversation('proj', 'conv-kept'))).rejects.toThrow(
        'native stop failed',
      )
      expect(sup.getViewState('proj', 'conv-kept')).toMatchObject({ running: true, error: true })
      expect(sup.activeCodeRuns().map((run) => run.conversationId)).toContain('conv-kept')
    } finally {
      failStop = false
      await sup.stopAll()
    }
  })

  it('stopWorkspace stops+disposes every run of a project, leaves others (P1-2)', async () => {
    const sup = new ConversationRunSupervisor()
    await sup.runCode('proj', 'convA', request('a'))
    await sup.runCode('proj', 'convB', request('b'))
    await sup.runCode('proj2', 'convC', request('c'))
    expect(spawned).toHaveLength(3)
    expect(sup.getViewState('proj', 'convB').activeProcessId).toBe('proc-2')
    await sup.stopWorkspace('proj')
    expect([...stopCalls].sort()).toEqual(['proc-1', 'proc-2'])
    expect(stopCalls).not.toContain('proc-3')
    expect(sup.getViewState('proj', 'convA').running).toBe(false)
    expect(sup.getViewState('proj', 'convB').running).toBe(false)
    expect(sup.getViewState('proj2', 'convC').running).toBe(true)
    expect(sup.activeCodeRuns().map((r) => r.conversationId)).toEqual(['convC'])
  })

  it('a stop during pre-spawn checks cancels before any process exists (§11.1 gap #2)', async () => {
    const sup = new ConversationRunSupervisor()
    holdSpawn = true
    const runPromise = sup.runCode('proj', 'convA', request('a'))
    await Promise.resolve() // the run is still in pre-spawn checks
    await sup.stopConversation('proj', 'convA') // supersede it there
    holdSpawn = false
    releaseSpawn()
    await runPromise
    // Round-3 P1-10: the runtime guard made pre-spawn cancellable — the
    // generation check after it returns quietly, so nothing ever spawns:
    // no orphan to stop later, and no late spawn sets a wrong "running"
    // state on the (now stopping) conversation.
    expect(spawned).toHaveLength(0)
    expect(stopCalls).toHaveLength(0)
    expect(sup.getViewState('proj', 'convA').running).toBe(false)
  })

  it('surfaces spawning immediately while an additive baseline is pending', async () => {
    const sup = new ConversationRunSupervisor()
    let releaseBaseline: () => void = () => {}
    let baselineStarted = false
    const runPromise = sup.runCode('proj', 'convA', {
      ...request('with baseline'),
      lifecycleObserver: {
        onRunStarted: () => {
          baselineStarted = true
          return new Promise<void>((resolve) => {
            releaseBaseline = resolve
          })
        },
        onEvents: () => {},
        onRunTerminal: () => {},
      },
    })
    await vi.waitFor(() => expect(baselineStarted).toBe(true))
    const pending = sup.getViewState('proj', 'convA')
    expect(pending.bindingState).toBe('spawning')
    expect(pending.running).toBe(true)
    expect(pending.sendable).toBe(false)
    releaseBaseline()
    await runPromise
  })

  it('finalizes result lifecycle and marks the view failed when cold spawn fails', async () => {
    const sup = new ConversationRunSupervisor()
    failSpawn = true
    const terminal = vi.fn()
    await expect(
      sup.runCode('proj', 'convA', {
        ...request('cannot start'),
        lifecycleObserver: {
          onRunStarted: () => {},
          onEvents: () => {},
          onRunTerminal: terminal,
        },
      }),
    ).rejects.toThrow('spawn unavailable')
    expect(terminal).toHaveBeenCalledOnce()
    expect(terminal.mock.calls[0]?.[1]).toBe('failed')
    const view = sup.getViewState('proj', 'convA')
    expect(view.running).toBe(false)
    expect(view.error).toBe(true)
  })
})
