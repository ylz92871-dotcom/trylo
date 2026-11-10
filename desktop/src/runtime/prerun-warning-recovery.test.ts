import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  ProcessService,
  RecoverableProcess,
  RetainedProcessOutput,
} from '../host-adapter/process-service'
import type { ChatMessage } from '../components/chat/types'
import type { RuntimeWarningEvent } from '../host-adapter/loop-events'
import { applyEvents } from '../components/chat/events'
import { applyRecoveredChatEvents } from './recovered-chat-events'
import { sendWorkChat } from '../work-chat/work-chat-adapter'
import { TryloV1EventAdapter } from '../host-adapter/trylo-v1-event-adapter'

const native = vi.hoisted(() => ({
  spawns: [] as Parameters<ProcessService['spawn']>[0][],
  retained: [] as RecoverableProcess[],
  pages: new Map<string, RetainedProcessOutput>(),
  send: vi.fn(async () => {}),
}))

vi.mock('../host-adapter/index', () => ({ hostAdapter: { process: {
  spawn: async (options: Parameters<ProcessService['spawn']>[0]) => {
    native.spawns.push(options)
    return { id: `proc-${native.spawns.length}`, pid: native.spawns.length + 100,
      label: options.label, command: options.command }
  },
  send: native.send,
  closeInput: async () => {},
  stop: vi.fn(),
  list: async () => [],
  hasTeamOwner: async () => false,
  recoveryList: async () => native.retained,
  readOutput: async (id: string) => native.pages.get(id),
} } }))

vi.mock('./cli-runtime-guard', () => ({
  verifyCliRuntime: async () => ({ ok: true }),
}))

const { ConversationRunSupervisor } = await import('./conversation-run-supervisor')
const STDERR = [
  'session desktop-fixture cannot be continued: the tool catalog changed',
  'start a new session instead; resuming would reinterpret the stored transcript',
]

beforeEach(() => {
  native.spawns.length = 0
  native.retained.length = 0
  native.pages.clear()
  native.send.mockClear()
})
afterEach(() => { vi.restoreAllMocks() })

it('separates reused native counters and private Unicode scopes without exposing them', () => {
  const attempt: RecoverableProcess = { id: 'proc-1', pid: 101,
    projectKey: 'D:/private/Ā', conversationId: 'chat',
    identity: { kind: 'conversation', runId: 'run-secret', turnId: 'user-1' } }
  const warningId = (nativeAttempt: RecoverableProcess): string => {
    const events = new TryloV1EventAdapter().finalizeExit({ nativeAttempt,
      exitCode: 52, stderr: STDERR, cancelled: false })
    const warning = events.find(event => event.type === 'runtime_warning')
    if (warning?.type !== 'runtime_warning' || !warning.id) throw new Error('Missing exit warning')
    return warning.id
  }
  const first = warningId(attempt)
  expect(warningId(attempt)).toBe(first)
  expect(warningId({ ...attempt, pid: 102 })).not.toBe(first)
  expect(warningId({ ...attempt, identity: {
    kind: 'conversation', runId: 'another-run', turnId: 'user-1',
  } })).not.toBe(first)
  // These Unicode code units have the same low byte; public ids must still differ.
  expect(warningId({ ...attempt, projectKey: 'D:/private/Ȁ' })).not.toBe(first)
  expect(first).not.toMatch(/private|run-secret|user-1|chat|proc-1/)
})

it('preserves distinct protocol warnings before a native exit', () => {
  const adapter = new TryloV1EventAdapter()
  const line = JSON.stringify({ type: 'warning', code: 'observation', message: 'same issue' })
  const events = [...adapter.feed(line), ...adapter.feed(line)]
  const warnings = events.filter((event): event is RuntimeWarningEvent => event.type === 'runtime_warning')
  expect(warnings).toHaveLength(2)
  expect(new Set(warnings.map(event => event.id)).size).toBe(2)
})

it.each(['code', 'work'] as const)(
  '%s preserves one native pre-run exit across live output and retained replay',
  async (surface) => {
    let now = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    let messages: ChatMessage[] = []
    const settings = { cliPath: 'D:/fixture/main.js', cwd: 'D:/fixture/workspace' }

    for (const attempt of [1, 2]) {
      // Reconstructing the owner must still preserve distinct native attempts.
      const supervisor = new ConversationRunSupervisor()
      const turnId = `user-${attempt}`
      messages.push({ id: turnId, turnId, role: 'user', kind: 'text',
        text: 'continue', createdAt: now })
      const onEvents = (events: Parameters<typeof applyEvents>[1]) => {
        messages = applyEvents(messages, events)
      }
      if (surface === 'work') {
        await sendWorkChat(supervisor, { projectKey: 'workspace', conversationId: 'chat',
          text: 'continue', settings, permissionLevel: 'workspace_write',
          priorMessages: [], turnId, toolRuntime: null, onEvents })
      } else {
        await supervisor.runCode('workspace', 'chat', { prompt: 'continue', settings,
          codeMode: 'agent', permissionLevel: 'workspace_write', priorMessages: [],
          turnId, surface, toolRuntime: null, onEvents })
      }

      // The real Runner sees stderr/exit; native retention later returns those
      // same bytes to the real recovery adapter, before a durable result exists.
      const spawned = native.spawns[attempt - 1]!
      const process: RecoverableProcess = { id: `proc-${attempt}`, pid: attempt + 100,
        projectKey: 'workspace', conversationId: 'chat', identity: spawned.recoveryIdentity! }
      const exit = { id: process.id, pid: process.pid, code: 52, signal: null }
      for (const line of STDERR) spawned.onStderr?.(line)
      spawned.onExit?.(exit)
      expect(supervisor.hasLocalOwner('workspace', 'chat')).toBe(false)
      expect(messages.filter(message => message.kind === 'notice')).toHaveLength(attempt)

      native.retained.push(process)
      native.pages.set(process.id, { version: 1, process,
        records: STDERR.map((line, index) => ({ sequence: index + 1, stream: 'stderr', line })),
        nextSequence: STDERR.length, hasMore: false, gap: false, finished: true,
        captureComplete: true, exit, answeredRequests: [] })
      now += 427
      const receipt = await supervisor.recoverConversationOutput('workspace', 'chat', [turnId])
      expect(receipt?.live).toBe(false)
      expect(receipt?.events).toContainEqual(expect.objectContaining({ type: 'loop_end', isError: true }))
      messages = applyRecoveredChatEvents(messages, receipt!.events, turnId)
      receipt!.acknowledge()
      expect(messages.filter(message => message.kind === 'notice')).toHaveLength(attempt)
      expect(native.spawns).toHaveLength(attempt)
      expect(native.send).toHaveBeenCalledTimes(attempt)
      now += 1000
    }

    const notices = messages.filter(message => message.kind === 'notice')
    expect(new Set(notices.map(message => message.id)).size).toBe(2)
    expect(new Set(notices.map(message => message.kind === 'notice' ? message.text : '')).size).toBe(1)
  },
)
