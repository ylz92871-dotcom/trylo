import { expect, it, vi } from 'vitest'
import { createDesktopLibraryClients } from './library-clients'
import { ConversationRunSupervisor } from '../runtime/conversation-run-supervisor'
import type { ProcessHandle, ProcessService } from '../host-adapter/process-service'
import type { FilePath, ProcessId } from '../host-adapter/types'

it('waits for normal owner binding without admitting competing reads, mutations, hard stops or cancelled waiters', async () => {
  vi.useFakeTimers()
  type Spawn = Parameters<ProcessService['spawn']>[0]
  const children: {
    readonly id: ProcessId
    readonly options: Spawn
    readonly release: () => void
  }[] = []
  const pending: Promise<unknown>[] = []
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.push(promise)
    void promise.catch(() => undefined)
    return promise
  }
  const process: Pick<ProcessService, 'spawn' | 'stop' | 'send' | 'closeInput'> = {
    spawn(options) {
      const id = `binding-child-${children.length}` as ProcessId
      let release!: (handle: ProcessHandle) => void
      const handle = new Promise<ProcessHandle>((resolve) => {
        release = resolve
      })
      children.push({
        id,
        options,
        release: () => release({ id, pid: 1, command: 'fixture', label: 'TEST ONLY' }),
      })
      return handle
    },
    stop: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    closeInput: vi.fn(async () => {}),
  }
  const supervisor = new ConversationRunSupervisor(),
    scope = {
      projectKey: 'binding-fixture',
      conversationId: 'library',
      projectRoot: 'D:/binding-fixture',
    }
  const owner = supervisor.libraryApprovalPort(scope),
    recovery = supervisor.libraryRecoveryPort()
  let subscriptions = 0
  const control = {
    ...owner,
    subscribe(listener: () => void) {
      const unsubscribe = owner.subscribe?.(listener)
      subscriptions++
      return () => {
        subscriptions--
        unsubscribe?.()
      }
    },
  }
  const clients = createDesktopLibraryClients(
    { process, cliPath: 'D:/fixture/main.js' as FilePath, cwd: scope.projectRoot as FilePath },
    undefined,
    control,
  )
  const flush = () => vi.advanceTimersByTimeAsync(0)
  const finish = (index: number) => {
    const child = children[index]!
    child.options.onOutput('[]')
    child.options.onExit?.({ id: child.id, pid: 1, code: 0, signal: null })
  }
  try {
    const first = track(clients.experts.query('', new AbortController().signal))
    const second = track(clients.experts.requests(new AbortController().signal))
    const third = track(clients.experts.requests(new AbortController().signal))
    let secondState = 'waiting'
    void second.then(
      () => {
        secondState = 'returned'
      },
      () => {
        secondState = 'rejected'
      },
    )
    await flush()
    expect(children).toHaveLength(1)
    expect(owner.canStart?.()).toBe(false)
    expect(secondState).toBe('waiting')
    await expect(
      clients.experts.build('request:side-effect', new AbortController().signal),
    ).rejects.toThrow('上次库操作尚未确认停止')
    expect(children).toHaveLength(1)

    children[0]!.release()
    await flush()
    expect(children).toHaveLength(2)
    expect(secondState).toBe('waiting')
    finish(0)
    await expect(first).resolves.toEqual([])
    children[1]!.release()
    await flush()
    expect(children).toHaveLength(3)
    finish(1)
    await expect(second).resolves.toEqual([])
    children[2]!.release()
    await flush()
    finish(2)
    await expect(third).resolves.toEqual([])
    expect(subscriptions).toBe(0)
    expect(owner.canStart?.()).toBe(true)

    const blocking = track(clients.experts.query('', new AbortController().signal)),
      cancel = new AbortController()
    const cancelled = track(clients.experts.requests(cancel.signal))
    await flush()
    expect(children).toHaveLength(4)
    cancel.abort()
    await expect(cancelled).rejects.toThrow('cancelled')
    expect(subscriptions).toBe(0)
    children[3]!.release()
    await flush()
    finish(3)
    await blocking
    expect(children).toHaveLength(4)

    const timeoutIndex = children.length,
      timeoutBlock = track(clients.experts.query('', new AbortController().signal))
    const timedOut = track(clients.experts.requests(new AbortController().signal))
    await vi.advanceTimersByTimeAsync(5001)
    await expect(timedOut).rejects.toThrow('库进程仍在连接')
    expect(children).toHaveLength(timeoutIndex + 1)
    expect(owner.startState?.()).toBe('binding')
    expect(subscriptions).toBe(0)
    children[timeoutIndex]!.release()
    await flush()
    finish(timeoutIndex)
    await timeoutBlock

    const stopIndex = children.length
    const stop = new AbortController(),
      stopping = track(clients.experts.query('', stop.signal))
    const waiting = track(clients.experts.requests(new AbortController().signal))
    stop.abort()
    await expect(waiting).rejects.toThrow('上次库操作尚未确认停止')
    expect(recovery.statuses()[0]?.state).toBe('stopping')
    await expect(clients.experts.requests(new AbortController().signal)).rejects.toThrow(
      '上次库操作尚未确认停止',
    )
    expect(children).toHaveLength(stopIndex + 1)
    await vi.advanceTimersByTimeAsync(5001)
    await expect(stopping).rejects.toThrow('stop_unconfirmed')
    expect(recovery.statuses()[0]?.state).toBe('stop_unconfirmed')
    await expect(clients.experts.requests(new AbortController().signal)).rejects.toThrow(
      '上次库操作尚未确认停止',
    )
    expect(children).toHaveLength(stopIndex + 1)
    children[stopIndex]!.release()
    await flush()
    finish(stopIndex)
    await flush()
    expect(recovery.statuses()).toEqual([])
    expect(subscriptions).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    expect(process.stop).not.toHaveBeenCalled()
  } finally {
    for (let index = 0; index < children.length; index++) {
      children[index]!.release()
      await flush()
      finish(index)
    }
    await Promise.allSettled(pending)
    vi.useRealTimers()
  }
})
