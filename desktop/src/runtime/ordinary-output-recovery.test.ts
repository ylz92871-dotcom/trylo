import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  ProcessService,
  RecoverableProcess,
  RetainedProcessOutput,
} from '../host-adapter/process-service'
import type { ChatMessage } from '../components/chat/types'
import { deriveConversationRunViewState } from '../components/chat/view-state'
import { ConversationRunSupervisor } from './conversation-run-supervisor'
import { applyRecoveredChatEvents } from './recovered-chat-events'
import {
  disposeRestoredConversationObservers,
  watchRestoredConversation,
} from './watch-restored-conversation'
import {
  persistedConversationRecoveryRun,
  selectConversationOutput,
} from './recovery-output-selection'

const native = vi.hoisted(
  () =>
    ({
      spawn: vi.fn(),
      send: vi.fn(),
      closeInput: vi.fn(),
      stop: vi.fn(),
      list: vi.fn(),
      recoveryList: vi.fn(),
      readOutput: vi.fn(),
      hasTeamOwner: vi.fn(),
    }) satisfies ProcessService,
)
vi.mock('../host-adapter/index', () => ({ hostAdapter: { process: native } }))

const process: RecoverableProcess = {
  id: 'ordinary-root',
  pid: 777,
  projectKey: 'workspace',
  conversationId: 'chat',
  identity: { kind: 'conversation', runId: 'native-run', turnId: 'old-turn' },
}
const liveRoot = {
  id: process.id,
  pid: process.pid,
  label: 'trylo-cli-v1',
  command: 'node',
  metadata: {
    projectKey: process.projectKey,
    conversationId: process.conversationId,
    runId: 'native-run',
  },
}
const line = (sequence: number, frame: unknown) => ({
  sequence,
  stream: 'stdout' as const,
  line: JSON.stringify(frame),
})
function page(patch: Partial<RetainedProcessOutput> = {}): RetainedProcessOutput {
  return {
    version: 1,
    process,
    records: [],
    nextSequence: 0,
    hasMore: false,
    gap: false,
    finished: false,
    captureComplete: true,
    exit: null,
    answeredRequests: [],
    ...patch,
  }
}
function terminal() {
  return {
    type: 'run_result',
    status: 'completed',
    finishReason: 'stop',
    sessionId: 's',
    turnId: 'cli-turn',
    iterations: 1,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    durationMs: 1,
    lastMessage: 'done',
  }
}
const initialMessages: readonly ChatMessage[] = [
  {
    id: 'old-user',
    kind: 'text',
    role: 'user',
    text: 'old request',
    turnId: 'old-turn',
    createdAt: 1,
  },
  {
    id: 'new-user',
    kind: 'text',
    role: 'user',
    text: 'why did it stop?',
    turnId: 'failed-new-turn',
    createdAt: 2,
  },
  {
    id: 'failed-send',
    kind: 'error',
    role: 'system',
    userMessage: 'previous execution is detached',
    diagnosticId: 'fixture-detached',
    createdAt: 3,
  },
]
const detaches: (() => void)[] = []
beforeEach(() => {
  vi.useFakeTimers()
  native.list.mockResolvedValue([liveRoot])
  native.recoveryList.mockResolvedValue([process])
  native.readOutput.mockResolvedValue(page())
  native.hasTeamOwner.mockResolvedValue(false)
})
afterEach(() => {
  for (const stop of detaches.splice(0)) stop()
  disposeRestoredConversationObservers()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.resetAllMocks()
})
function observe(supervisor = new ConversationRunSupervisor(), onRecovered?: () => void) {
  let messages = [...initialMessages]
  const errors: unknown[] = []
  const stop = watchRestoredConversation({
    projectKey: 'workspace',
    conversationId: 'chat',
    runtime: supervisor,
    turnIds: () => ['old-turn', 'failed-new-turn'],
    onError: (error) => errors.push(error),
    onRecovered: (receipt) => {
      messages = applyRecoveredChatEvents(messages, receipt.events, receipt.process.identity.turnId)
      onRecovered?.()
    },
  })
  detaches.push(stop)
  return { supervisor, stop, errors, messages: () => messages }
}

function observeConversation(supervisor: ConversationRunSupervisor, conversationId: string) {
  const stop = watchRestoredConversation({
    projectKey: 'workspace',
    conversationId,
    runtime: supervisor,
    turnIds: () => ['old-turn'],
    onRecovered: () => undefined,
    onError: (error) => { throw error },
  })
  detaches.push(stop)
}

it('keeps both idle Code and Work conversations idle without waking each other', async () => {
  native.list.mockResolvedValue([])
  native.recoveryList.mockResolvedValue([])
  const supervisor = new ConversationRunSupervisor()
  const states: string[] = []
  detaches.push(supervisor.subscribe(() => {
    for (const id of ['code-chat', 'work-chat']) {
      states.push(deriveConversationRunViewState({
        ...supervisor.getViewState('workspace', id), messages: initialMessages,
      }))
    }
  }))
  observeConversation(supervisor, 'code-chat')
  await vi.advanceTimersByTimeAsync(0)
  observeConversation(supervisor, 'work-chat')
  await vi.advanceTimersByTimeAsync(100)

  expect(states.filter((state) => state !== 'idle')).toEqual([])
  expect(native.recoveryList).toHaveBeenCalledTimes(2)
  expect(native.list).toHaveBeenCalledTimes(2)
  expect(native.stop).not.toHaveBeenCalled()
  expect(native.spawn).not.toHaveBeenCalled()
})

it('polls two restored live conversations at the observation cadence without mutual wakeups', async () => {
  const roots = ['code-chat', 'work-chat'].map((conversationId) => ({
    ...process, id: conversationId + '-root', conversationId,
  }))
  native.recoveryList.mockResolvedValue(roots)
  native.list.mockResolvedValue(roots.map((root) => ({
    ...liveRoot, id: root.id, metadata: { ...liveRoot.metadata, conversationId: root.conversationId },
  })))
  native.readOutput.mockImplementation(async (id) => page({ process: roots.find((root) => root.id === id)! }))
  const supervisor = new ConversationRunSupervisor()
  observeConversation(supervisor, 'code-chat')
  await vi.advanceTimersByTimeAsync(0)
  observeConversation(supervisor, 'work-chat')
  await vi.advanceTimersByTimeAsync(2100)

  expect(native.readOutput.mock.calls.filter(([id]) => id === roots[0]!.id)).toHaveLength(3)
  expect(native.readOutput.mock.calls.filter(([id]) => id === roots[1]!.id)).toHaveLength(3)
  for (const id of ['code-chat', 'work-chat']) {
    expect(supervisor.getViewState('workspace', id)).toMatchObject({
      running: true, recoveryState: { kind: 'streaming', turnId: 'old-turn' },
    })
  }
  expect(native.stop).not.toHaveBeenCalled()
  expect(native.spawn).not.toHaveBeenCalled()
})

it('does not rescan an idle conversation for updates from another running conversation', async () => {
  native.list.mockResolvedValue([])
  native.recoveryList.mockResolvedValue([])
  const supervisor = new ConversationRunSupervisor()
  observeConversation(supervisor, 'work-chat')
  await vi.advanceTimersByTimeAsync(0)
  const reads = native.recoveryList.mock.calls.length
  const sending = supervisor.beginSend('workspace', 'code-chat', 'new-code-turn')!
  await vi.advanceTimersByTimeAsync(1)
  sending.finish()
  await vi.advanceTimersByTimeAsync(1)
  expect(native.recoveryList).toHaveBeenCalledTimes(reads)
  expect(supervisor.getViewState('workspace', 'work-chat').running).toBe(false)
})

it('rechecks its own conversation after the local execution owner releases it', async () => {
  native.list.mockResolvedValue([])
  native.recoveryList.mockResolvedValue([])
  const supervisor = new ConversationRunSupervisor()
  const sending = supervisor.beginSend('workspace', 'code-chat', 'new-code-turn')!
  observeConversation(supervisor, 'code-chat')
  await vi.advanceTimersByTimeAsync(0)
  expect(native.recoveryList).not.toHaveBeenCalled()
  sending.finish()
  await vi.advanceTimersByTimeAsync(1)
  expect(native.recoveryList).toHaveBeenCalledOnce()
  expect(supervisor.getViewState('workspace', 'code-chat').running).toBe(false)
})

it('reconnects the original ordinary turn and does not replay a prompt or stop its native root', async () => {
  native.readOutput.mockResolvedValue(
    page({
      records: [line(1, { type: 'tool_use', toolCallId: 'edit', name: 'edit_file', input: {} })],
      nextSequence: 1,
    }),
  )
  const fixture = observe()
  await vi.advanceTimersByTimeAsync(0)
  expect(native.recoveryList).toHaveBeenCalledOnce()
  expect(native.readOutput).toHaveBeenCalledWith(process.id, 0)
  expect(native.spawn).not.toHaveBeenCalled()
  expect(native.send).not.toHaveBeenCalled()
  expect(native.stop).not.toHaveBeenCalled()
  const view = fixture.supervisor.getViewState('workspace', 'chat')
  expect(view).toMatchObject({
    running: true,
    sendable: false,
    activeProcessId: process.id,
    recoveryState: { kind: 'streaming', turnId: 'old-turn' },
  })
  expect(fixture.messages().find((message) => message.kind === 'tool')?.turnId).toBe('old-turn')
  expect(fixture.messages().at(-1)?.id).toBe('failed-send')
  expect(deriveConversationRunViewState({ ...view, messages: fixture.messages() })).toBe(
    'tool_running',
  )
})

it('a later native exit releases an ordinary detached hold without another user Stop', async () => {
  const supervisor = new ConversationRunSupervisor()
  await supervisor.inspectTeamOwner('workspace', 'chat').catch(() => undefined)
  const fixture = observe(supervisor)
  await vi.advanceTimersByTimeAsync(0)
  native.list.mockResolvedValue([])
  native.readOutput.mockResolvedValue(
    page({
      records: [line(1, terminal())],
      nextSequence: 1,
      finished: true,
      exit: { id: process.id, pid: process.pid, code: 0, signal: null },
    }),
  )
  await vi.advanceTimersByTimeAsync(1000)
  expect(fixture.supervisor.getViewState('workspace', 'chat')).toMatchObject({
    running: false,
    sendable: true,
    activeProcessId: null,
  })
  expect(native.stop).not.toHaveBeenCalled()
  expect(
    fixture
      .messages()
      .some(
        (message) =>
          message.turnId === 'old-turn' && message.kind === 'turn' && message.status === 'done',
      ),
  ).toBe(true)
})

it('observes a root from a host without capture until it independently exits, without inventing success', async () => {
  native.recoveryList.mockResolvedValue([])
  const fixture = observe()
  await vi.advanceTimersByTimeAsync(0)
  const view = fixture.supervisor.getViewState('workspace', 'chat')
  expect(deriveConversationRunViewState({ ...view, messages: fixture.messages() })).toBe(
    'reconnecting',
  )
  native.list.mockResolvedValue([])
  await vi.advanceTimersByTimeAsync(1000)
  expect(fixture.supervisor.getViewState('workspace', 'chat').running).toBe(false)
  expect(fixture.messages()).toEqual(initialMessages)
  expect(native.stop).not.toHaveBeenCalled()
})

it('retains live ownership on output gaps and exposes unavailable instead of preparing', async () => {
  native.readOutput.mockResolvedValue(page({ gap: true }))
  const fixture = observe()
  await vi.advanceTimersByTimeAsync(0)
  const view = fixture.supervisor.getViewState('workspace', 'chat')
  expect(view).toMatchObject({
    running: true,
    sendable: false,
    recoveryState: { kind: 'unavailable' },
  })
  expect(deriveConversationRunViewState({ ...view, messages: fixture.messages() })).toBe('failed')
  expect(fixture.errors).toHaveLength(1)
  expect(native.stop).not.toHaveBeenCalled()
})

it('keeps an uncertain read recoverable and does not release the original live registration', async () => {
  native.recoveryList.mockRejectedValueOnce(new Error('temporary native read failure'))
  const fixture = observe()
  await vi.advanceTimersByTimeAsync(0)
  expect(fixture.supervisor.getViewState('workspace', 'chat')).toMatchObject({
    running: true,
    sendable: false,
    recoveryState: { kind: 'unavailable' },
  })
  await vi.advanceTimersByTimeAsync(1000)
  expect(fixture.supervisor.getViewState('workspace', 'chat').activeProcessId).toBe(process.id)
  expect(native.spawn).not.toHaveBeenCalled()
  expect(native.stop).not.toHaveBeenCalled()
})

it('releases a live output-gap hold after a proven natural exit without inventing a completed result', async () => {
  native.readOutput.mockResolvedValue(page({ gap: true }))
  const fixture = observe()
  await vi.advanceTimersByTimeAsync(0)
  expect(fixture.errors[0]).toBeInstanceOf(Error)
  expect((fixture.errors[0] as Error).message).toContain('可以等待原执行结束，或主动停止')
  native.list.mockResolvedValue([])
  native.readOutput.mockResolvedValue(
    page({
      gap: true,
      finished: true,
      exit: { id: process.id, pid: process.pid, code: 0, signal: null },
    }),
  )
  await vi.advanceTimersByTimeAsync(1000)
  expect(fixture.supervisor.getViewState('workspace', 'chat')).toMatchObject({
    running: false,
    sendable: true,
  })
  expect(fixture.messages()).toEqual(initialMessages)
  expect(native.stop).not.toHaveBeenCalled()
  expect(native.send).not.toHaveBeenCalled()
})

it('uses the proven live record rather than an older completed turn retained by native', () => {
  const old = {
    ...process,
    id: 'older',
    identity: { kind: 'conversation' as const, runId: 'older-run', turnId: 'older-turn' },
  }
  expect(
    selectConversationOutput([old, process], new Set([process.id]), [
      'older-turn',
      'old-turn',
      'failed-new-turn',
    ]),
  ).toBe(process)
  expect(selectConversationOutput([old, process], new Set(), ['old-turn', 'older-turn'])).toBe(old)
  expect(() =>
    selectConversationOutput([old, process], new Set([old.id, process.id]), ['old-turn']),
  ).toThrow('多个原生执行')
  expect(() => selectConversationOutput([old, process], new Set(), [])).toThrow('原始提问')
})

it('a late read cannot write to an observer replaced for the same conversation', async () => {
  let release!: (value: RetainedProcessOutput) => void
  native.readOutput.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const oldSink = vi.fn()
  const freshSink = vi.fn()
  observe(new ConversationRunSupervisor(), oldSink)
  await vi.advanceTimersByTimeAsync(0)
  const fresh = observe(new ConversationRunSupervisor(), freshSink)
  release(page())
  await vi.advanceTimersByTimeAsync(0)
  expect(oldSink).not.toHaveBeenCalled()
  expect(freshSink).toHaveBeenCalledOnce()
  expect(fresh.supervisor.getViewState('workspace', 'chat').activeProcessId).toBe(process.id)
})

it('module disposal rejects late reads from navigation-retained observers without stopping native roots', async () => {
  let release!: (value: RetainedProcessOutput) => void
  native.readOutput.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const oldSink = vi.fn()
  const old = observe(new ConversationRunSupervisor(), oldSink)
  await vi.advanceTimersByTimeAsync(0)
  old.stop()
  disposeRestoredConversationObservers()
  const freshSink = vi.fn()
  const fresh = observe(new ConversationRunSupervisor(), freshSink)
  release(page())
  await vi.advanceTimersByTimeAsync(0)
  expect(oldSink).not.toHaveBeenCalled()
  expect(freshSink).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1000)
  expect(oldSink).not.toHaveBeenCalled()
  expect(freshSink).toHaveBeenCalledTimes(2)
  expect(fresh.supervisor.getViewState('workspace', 'chat').activeProcessId).toBe(process.id)
  expect(native.spawn).not.toHaveBeenCalled()
  expect(native.send).not.toHaveBeenCalled()
  expect(native.stop).not.toHaveBeenCalled()
})

it('navigation preserves the original scoped delivery sink while its recovered root is live', async () => {
  const delivered = vi.fn()
  const fixture = observe(new ConversationRunSupervisor(), delivered)
  await vi.advanceTimersByTimeAsync(0)
  fixture.stop()
  native.list.mockResolvedValue([])
  native.readOutput.mockResolvedValue(
    page({
      records: [line(1, terminal())],
      nextSequence: 1,
      finished: true,
      exit: { id: process.id, pid: process.pid, code: 0, signal: null },
    }),
  )
  await vi.advanceTimersByTimeAsync(1000)
  expect(delivered).toHaveBeenCalledTimes(2)
  expect(fixture.supervisor.getViewState('workspace', 'chat').running).toBe(false)
  expect(native.stop).not.toHaveBeenCalled()
})

it('restored ordinary approvals remain human decisions and are correlated to the original process', async () => {
  native.readOutput.mockResolvedValue(
    page({
      records: [
        line(1, {
          type: 'control_request',
          request_id: 'restored-ask',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'run_shell',
            input: { command: 'example' },
          },
        }),
      ],
      nextSequence: 1,
    }),
  )
  const fixture = observe()
  await vi.advanceTimersByTimeAsync(0)
  expect(fixture.supervisor.pendingCodePermissions()).toHaveLength(1)
  expect(native.send).not.toHaveBeenCalled()
  expect(await fixture.supervisor.respondCodePermission('restored-ask', false)).toBe(true)
  expect(native.send).toHaveBeenCalledWith(process.id, expect.stringContaining('restored-ask'))
  expect(native.send.mock.calls[0]?.[1]).toContain('deny')
})

it('navigation during an initial native lookup keeps the subsequently acquired root observed', async () => {
  let release!: (processes: readonly RecoverableProcess[]) => void
  native.recoveryList.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const delivered = vi.fn()
  const fixture = observe(new ConversationRunSupervisor(), delivered)
  await vi.advanceTimersByTimeAsync(0)
  fixture.stop()
  release([process])
  await vi.advanceTimersByTimeAsync(0)
  expect(delivered).toHaveBeenCalledOnce()
  expect(fixture.supervisor.hasRecoveredConversationOwner('workspace', 'chat')).toBe(true)
  expect(native.stop).not.toHaveBeenCalled()
})

it('a view delivery failure keeps unacknowledged output for the next observation', async () => {
  native.readOutput.mockImplementation(async (_id, after) =>
    after === 0
      ? page({
          records: [line(1, { type: 'message_delta', text: 'retained answer' })],
          nextSequence: 1,
        })
      : page({ nextSequence: 1 }),
  )
  const delivered = vi.fn().mockImplementationOnce(() => {
    throw new Error('view did not commit')
  })
  const fixture = observe(new ConversationRunSupervisor(), delivered)
  await vi.advanceTimersByTimeAsync(0)
  expect(fixture.errors).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1000)
  expect(delivered).toHaveBeenCalledTimes(2)
  expect(
    fixture.messages().filter((message) => message.kind === 'text' && message.role === 'assistant'),
  ).toHaveLength(1)
  expect(native.spawn).not.toHaveBeenCalled()
  expect(native.send).not.toHaveBeenCalled()
})

it('a persisted result run id disambiguates completed compact and task roots sharing the same human turn', async () => {
  const compact: RecoverableProcess = {
    ...process,
    id: 'compact-root',
    pid: 778,
    identity: { kind: 'conversation', runId: 'compact-run', turnId: 'old-turn' },
  }
  const expected = persistedConversationRecoveryRun({
    schemaVersion: 1,
    work: {
      latestRun: {
        runId: 'compact-run',
        turnId: 'old-turn',
        startedAt: 20,
        status: 'completed',
        createdIds: [],
        updatedIds: [],
        discoveredIds: [],
      },
      artifacts: [],
      artifactCountTotal: 0,
      truncated: false,
    },
  })
  native.recoveryList.mockResolvedValue([compact, process])
  native.list.mockResolvedValue([])
  native.readOutput.mockResolvedValue(
    page({
      process: compact,
      records: [line(1, terminal())],
      nextSequence: 1,
      finished: true,
      exit: { id: compact.id, pid: compact.pid, code: 0, signal: null },
    }),
  )
  const supervisor = new ConversationRunSupervisor()
  const receipt = await supervisor.recoverConversationOutput(
    'workspace',
    'chat',
    ['old-turn'],
    expected,
  )
  expect(receipt?.process.id).toBe(compact.id)
  expect(native.readOutput).toHaveBeenCalledWith(compact.id, 0)
  expect(
    selectConversationOutput([compact, process], new Set([process.id]), ['old-turn'], expected),
  ).toBe(process)
  expect(() =>
    selectConversationOutput([compact, process], new Set(), ['old-turn'], {
      runId: 'compact-run',
      turnId: 'foreign-turn',
    }),
  ).toThrow('多个执行记录')
  expect(native.spawn).not.toHaveBeenCalled()
  expect(native.stop).not.toHaveBeenCalled()
})
