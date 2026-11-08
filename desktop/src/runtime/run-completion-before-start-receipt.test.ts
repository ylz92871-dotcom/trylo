import { afterEach, expect, it, vi } from 'vitest'
import type { LoopEvent } from '../host-adapter/loop-events'
import { startTryloV1 } from '../host-adapter/trylo-v1-runner'
import { ConversationRunSupervisor } from './conversation-run-supervisor'

vi.mock('../host-adapter/index', () => ({ hostAdapter: { process: { list: async () => [], stop: async () => {} } } }))

vi.mock('./cli-runtime-guard', () => ({ verifyCliRuntime: async () => ({ ok: true }) }))
vi.mock('../host-adapter/trylo-v1-runner', () => ({
  startTryloV1: vi.fn(),
  stopTryloV1: vi.fn(async () => {}),
  TryloV1UnsupportedError: class extends Error {},
}))
afterEach(() => {
  vi.resetAllMocks()
})
const endings: readonly { name: string; event: LoopEvent }[] = [
  {
    name: 'completed',
    event: {
      type: 'loop_end',
      seq: 2,
      ts: 2,
      durationMs: 1,
      totalCost: 0,
      numTurns: 1,
      reason: 'completed',
      finalResult: 'done',
    },
  },
  {
    name: 'failed',
    event: {
      type: 'loop_end',
      seq: 2,
      ts: 2,
      durationMs: 1,
      totalCost: 0,
      numTurns: 1,
      reason: 'error',
      finalResult: '',
      isError: true,
    },
  },
  {
    name: 'cancelled',
    event: {
      type: 'loop_end',
      seq: 2,
      ts: 2,
      durationMs: 1,
      totalCost: 0,
      numTurns: 1,
      reason: 'cancelled',
      finalResult: '',
      isError: true,
    },
  },
]

it('terminal events win over a delayed startup receipt', async () => {
  for (const ending of endings) {
    const supervisor = new ConversationRunSupervisor()
    const events: LoopEvent[] = []
    const accepted = vi.fn()
    vi.mocked(startTryloV1).mockImplementationOnce(async (args) => {
      args.onEvents?.([ending.event])
      return { processId: 'held-idle-v1', state: () => 'terminal' }
    })
    await supervisor.runCode('project', 'hello', {
      prompt: 'hello',
      settings: { cliPath: 'fixture.js', cwd: 'D:/fixture' },
      priorMessages: [],
      permissionLevel: 'read_only',
      codeMode: 'agent',
      onEvents: (batch) => events.push(...batch),
      onPromptAccepted: accepted,
    })
    expect(events, ending.name).toEqual([ending.event])
    expect(accepted).toHaveBeenCalledOnce()
    expect(supervisor.getViewState('project', 'hello'), ending.name).toMatchObject({
      running: false,
      sendable: true,
      bindingState: 'idle',
    })
    expect(supervisor.activeCodeRuns(), ending.name).toEqual([])
    expect(supervisor.getViewState('project', 'hello').activeProcessId).toBe('held-idle-v1')
  }
})

it('retains the draft when native prompt delivery fails', async () => {
  vi.mocked(startTryloV1).mockRejectedValueOnce(new Error('write failed'))
  const accepted = vi.fn()
  const supervisor = new ConversationRunSupervisor()
  await expect(
    supervisor.runCode('project', 'failed', {
      prompt: 'hello',
      settings: { cliPath: 'fixture.js', cwd: 'D:/fixture' },
      priorMessages: [],
      permissionLevel: 'read_only',
      codeMode: 'agent',
      onEvents: () => {},
      onPromptAccepted: accepted,
    }),
  ).rejects.toThrow('write failed')
  expect(accepted).not.toHaveBeenCalled()
})
