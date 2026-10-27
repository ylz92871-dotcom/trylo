import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useState } from 'react'
import {
  ConversationRunSupervisor,
  useConversationRunViewState,
} from './conversation-run-supervisor'
import { IDLE_CODE_VIEW_STATE } from './runtime-types'
import { yieldForSendFeedback } from './send-feedback'
import { sendWorkChat } from '../work-chat/work-chat-adapter'

const h = vi.hoisted(() => ({ run: vi.fn(), stop: vi.fn() }))
// This rendering/preparation fixture has no native conversation processes.
vi.mock('../host-adapter/index', () => ({ hostAdapter: { process: { list: async () => [], stop: async () => {} } } }))
vi.mock('./code-run-controller', () => ({
  CodeRunController: class {
    run = h.run
    stop = h.stop
    getViewState = () => IDLE_CODE_VIEW_STATE
    getActiveRun = () => null
    hasPrewarm = () => ({ processId: null, ready: false })
  },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const request = {
  prompt: 'hello',
  turnId: 'user-1',
  settings: { cliPath: 'cli.js', cwd: 'D:/work' },
  codeMode: 'agent' as const,
  permissionLevel: 'workspace_write' as const,
  priorMessages: [],
  onEvents: () => {},
}
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('shows the sent message and busy state while tool preparation is still pending', async () => {
  const profile = deferred<null>()
  const supervisor = new ConversationRunSupervisor({ resolveToolRuntime: () => profile.promise })
  function Chat() {
    const [messages, setMessages] = useState<string[]>([])
    const view = useConversationRunViewState(supervisor, 'project', 'chat')
    return (
      <>
        <button
          onClick={() => {
            setMessages(['hello'])
            void supervisor.runCode('project', 'chat', request)
          }}
        >
          Send
        </button>
        <p>{messages.join('')}</p>
        <output>{view.running ? 'Preparing' : 'Idle'}</output>
      </>
    )
  }
  render(<Chat />)
  fireEvent.click(screen.getByText('Send'))
  expect(screen.getByText('hello')).toBeTruthy()
  expect(screen.getByText('Preparing')).toBeTruthy()
  expect(h.run).not.toHaveBeenCalled()
  expect(supervisor.activeCodeRuns()).toMatchObject([{ conversationId: 'chat', runId: 'user-1' }])
  await act(async () => {
    profile.resolve(null)
  })
  expect(h.run).toHaveBeenCalledOnce()
  expect(screen.getByText('Idle')).toBeTruthy()
})

it('does not start a stopped request when its tool preparation finishes later', async () => {
  const profile = deferred<null>()
  const supervisor = new ConversationRunSupervisor({ resolveToolRuntime: () => profile.promise })
  const sent = supervisor.runCode('project', 'chat', request)
  await supervisor.stopConversation('project', 'chat')
  profile.resolve(null)
  await sent
  expect(h.run).not.toHaveBeenCalled()
  expect(supervisor.getViewState('project', 'chat').sendable).toBe(true)
})

it('owns Work capability preparation before runCode and prevents duplicate submission', async () => {
  const supervisor = new ConversationRunSupervisor()
  const preparation = supervisor.beginSend('project', 'work', 'work-turn')!
  expect(supervisor.getViewState('project', 'work')).toMatchObject({
    running: true,
    sendable: false,
  })
  expect(supervisor.beginSend('project', 'work')).toBeNull()
  expect(supervisor.getViewState('project', 'other').running).toBe(false)
  await sendWorkChat(supervisor, {
    ...request,
    text: request.prompt,
    projectKey: 'project',
    conversationId: 'work',
    toolRuntime: null,
    sendPreparation: preparation,
  })
  expect(h.run).toHaveBeenCalledOnce()
  expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ surface: 'work', prompt: 'hello' }))
  expect(h.run.mock.calls[0]![0]).not.toHaveProperty('sendPreparation')
  expect(supervisor.getViewState('project', 'work').running).toBe(false)
})

it('keeps a stopped preflight from reviving or clearing a newer send', async () => {
  const supervisor = new ConversationRunSupervisor()
  const old = supervisor.beginSend('project', 'chat', 'old')!
  await supervisor.stopConversation('project', 'chat')
  const next = supervisor.beginSend('project', 'chat', 'new')!
  await supervisor.runCode('project', 'chat', { ...request, sendPreparation: old })
  old.finish()
  expect(old.signal.aborted).toBe(true)
  expect(next.isCurrent()).toBe(true)
  expect(h.run).not.toHaveBeenCalled()
  expect(supervisor.getViewState('project', 'chat').runId).toBe('new')
  next.finish()
})

it.each(['stopWorkspace', 'stopAll', 'removeConversation'] as const)(
  '%s cancels preparation even without a controller',
  async (action) => {
    const supervisor = new ConversationRunSupervisor()
    const preparation = supervisor.beginSend('project', 'chat')!
    if (action === 'stopAll') await supervisor.stopAll()
    else if (action === 'stopWorkspace') await supervisor.stopWorkspace('project')
    else await supervisor.removeConversation('project', 'chat')
    await supervisor.runCode('project', 'chat', { ...request, sendPreparation: preparation })
    expect(preparation.signal.aborted).toBe(true)
    expect(h.run).not.toHaveBeenCalled()
    expect(supervisor.activeCodeRuns()).toEqual([])
  },
)

it('honors Stop during the legacy argument fallback as well as tool resolution', async () => {
  const args = deferred<readonly string[]>()
  const supervisor = new ConversationRunSupervisor({ resolveCodeCliArgs: () => args.promise })
  const sent = supervisor.runCode('project', 'chat', request)
  await supervisor.stopConversation('project', 'chat')
  args.resolve([])
  await sent
  expect(h.run).not.toHaveBeenCalled()
})

it('releases preparing state when startup fails so the user can retry', async () => {
  h.run.mockRejectedValueOnce(new Error('spawn unavailable'))
  const supervisor = new ConversationRunSupervisor()
  await expect(supervisor.runCode('project', 'chat', request)).rejects.toThrow('spawn unavailable')
  expect(supervisor.getViewState('project', 'chat').sendable).toBe(true)
  await supervisor.runCode('project', 'chat', request)
  expect(h.run).toHaveBeenCalledTimes(2)
})

it('allows a paint before synchronous preparation and clears the fallback timer', async () => {
  vi.useFakeTimers()
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const ready = vi.fn()
  const waiting = yieldForSendFeedback().then(ready)
  frames.shift()!(0)
  await Promise.resolve()
  expect(ready).not.toHaveBeenCalled()
  frames.shift()!(16)
  await waiting
  expect(ready).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('continues in a background WebView with no animation frames', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const waiting = yieldForSendFeedback()
  await vi.advanceTimersByTimeAsync(50)
  await waiting
  expect(cancelAnimationFrame).toHaveBeenCalledWith(1)
  expect(vi.getTimerCount()).toBe(0)
})
