import { afterEach, expect, it, vi } from 'vitest'
import { RecoveredConversationStop } from './recovered-conversation-stop'
import type { LiveProcessInfo } from '../host-adapter/process-service'

const target: LiveProcessInfo = {
  id: 'original',
  pid: 123,
  label: 'trylo-cli-v1',
  command: 'node',
  metadata: { projectKey: 'workspace', conversationId: 'chat', runId: 'original-turn' },
}
const sibling: LiveProcessInfo = {
  ...target,
  id: 'sibling',
  pid: 456,
  metadata: { ...target.metadata, conversationId: 'different-chat' },
}
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})
function fixture(input: 'exit' | 'hang' | 'refuse' | 'missing' = 'exit', failForce = false) {
  const live = new Set([target.id, sibling.id])
  const list = vi.fn(async () => [target, sibling].filter((root) => live.has(root.id)))
  const stop = vi.fn(async (id: string) => {
    if (failForce) throw new Error('native force refused')
    live.delete(id)
  })
  const send = vi.fn(async (id: string, message: string) => {
    expect(id).toBe(target.id)
    expect(JSON.parse(message)).toMatchObject({
      type: 'control_request',
      request: { subtype: 'interrupt' },
    })
    if (input === 'hang') return new Promise<void>(() => {})
    if (input === 'refuse') throw new Error('stdin unavailable')
    live.delete(id)
  })
  const port = { list, stop, ...(input === 'missing' ? {} : { send }) }
  const owner = new RecoveredConversationStop(
    async () => port,
    vi.fn(),
    () => new Promise((resolve) => setTimeout(resolve, 50)),
    () => Date.now(),
  )
  return { owner, live, list, send, stop }
}

it('a reconstructed execution receives graceful interrupt and exits without native force', async () => {
  const f = fixture()
  await expect(f.owner.assertAvailable('workspace', 'chat', new Set())).rejects.toThrow(
    '旧执行仍在运行',
  )
  await f.owner.stop('workspace', 'chat')
  expect(f.send).toHaveBeenCalledOnce()
  expect(f.stop).not.toHaveBeenCalled()
  expect(f.owner.view('workspace', 'chat')).toBeNull()
  expect(f.live.has(sibling.id)).toBe(true)
})

it('a stuck stdin waits the same graceful window before immutable-id force fallback', async () => {
  vi.useFakeTimers()
  const f = fixture('hang')
  const stopping = f.owner.stop('workspace', 'chat')
  await vi.advanceTimersByTimeAsync(0)
  expect(f.send).toHaveBeenCalledOnce()
  expect(f.stop).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(2999)
  expect(f.stop).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  await stopping
  expect(f.stop).toHaveBeenCalledOnce()
  expect(f.stop).toHaveBeenCalledWith(target.id)
  expect(f.live.has(sibling.id)).toBe(true)
})

it('a refused interrupt falls back, but a live force-refused root stays owned and retryable', async () => {
  vi.useFakeTimers()
  const f = fixture('refuse', true)
  await expect(f.owner.stop('workspace', 'chat')).rejects.toThrow('native force refused')
  expect(f.send).toHaveBeenCalledOnce()
  expect(f.owner.view('workspace', 'chat')).toMatchObject({
    running: true,
    sendable: false,
    error: true,
    activeProcessId: target.id,
  })
  expect(f.live.has(target.id)).toBe(true)
  expect(f.live.has(sibling.id)).toBe(true)
  await vi.advanceTimersByTimeAsync(50)
})

it('a stop receipt cannot release an original id that the reaper still lists', async () => {
  vi.useFakeTimers()
  const f = fixture('refuse')
  f.stop.mockImplementation(async () => {})
  const stopping = f.owner.stop('workspace', 'chat')
  const rejected = expect(stopping).rejects.toThrow('尚未确认旧执行进程退出')
  await vi.advanceTimersByTimeAsync(5100)
  await rejected
  expect(f.owner.view('workspace', 'chat')).toMatchObject({
    running: true,
    sendable: false,
    activeProcessId: target.id,
  })
  expect(f.live.has(sibling.id)).toBe(true)
})

it('old ports without stdin retain explicit force-stop fixture compatibility', async () => {
  const f = fixture('missing')
  await f.owner.stop('workspace', 'chat')
  expect(f.send).not.toHaveBeenCalled()
  expect(f.stop).toHaveBeenCalledOnce()
  expect(f.stop).toHaveBeenCalledWith(target.id)
  expect(f.live.has(sibling.id)).toBe(true)
})

it('disposes an interrupted observation waiter after force and exit confirmation finish', async () => {
  vi.useFakeTimers()
  const root = {
    id: 'root',
    pid: 1,
    label: 'trylo-cli-v1',
    command: 'node',
    metadata: { projectKey: 'p', conversationId: 'c' },
  }
  let calls = 0
  const list = vi.fn(async () => {
    calls++
    if (calls === 1) return [root]
    if (calls === 2) return new Promise<never>(() => {})
    return []
  })
  const owner = new RecoveredConversationStop(
    async () => ({
      list,
      send: async () => {
        throw new Error('input channel refused')
      },
      stop: async () => {},
    }),
    () => {},
  )
  await owner.stop('p', 'c')
  expect(owner.view('p', 'c')).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

it('disposes the default pause timer after an interrupt fails during polling', async () => {
  vi.useFakeTimers()
  const root = {
    id: 'root',
    pid: 1,
    label: 'trylo-cli-v1',
    command: 'node',
    metadata: { projectKey: 'p', conversationId: 'c' },
  }
  let live = true
  const owner = new RecoveredConversationStop(
    async () => ({
      list: async () => (live ? [root] : []),
      send: () =>
        new Promise<void>((_resolve, reject) =>
          setTimeout(() => reject(new Error('input refused')), 1),
        ),
      stop: async () => {
        live = false
      },
    }),
    () => {},
  )
  const stopping = owner.stop('p', 'c')
  await vi.advanceTimersByTimeAsync(1)
  await stopping
  expect(owner.view('p', 'c')).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

function leaseFixture(releaseAfter?: number, originalPresent = true) {
  let live = originalPresent
  let held = true
  let observedExitAt: number | undefined
  const target = {
    id: 'original',
    pid: 123,
    label: 'trylo-cli-v1',
    command: 'node',
    metadata: { projectKey: 'workspace', conversationId: 'chat', runId: 'turn' },
  }
  const list = vi.fn(async () => {
    if (!live && observedExitAt === undefined) observedExitAt = Date.now()
    return live ? [target] : []
  })
  const hasTeamOwner = vi.fn(async () => held)
  const send = vi.fn(async () => {
    live = false
    if (releaseAfter !== undefined)
      setTimeout(() => {
        held = false
      }, releaseAfter)
  })
  const stop = vi.fn(async () => {
    live = false
  })
  const port = { list, hasTeamOwner, send, stop }
  const owner = new RecoveredConversationStop(
    async () => port,
    vi.fn(),
    undefined,
    () => Date.now(),
  )
  return { owner, list, hasTeamOwner, send, stop, observedExitAt: () => observedExitAt }
}

it('waits for an observed exited root to release its native lease after output drain', async () => {
  vi.useFakeTimers()
  const f = leaseFixture(200)
  const stopping = f.owner.stop('workspace', 'chat')
  let completed = false
  const result = stopping.then(
    () => {
      completed = true
    },
    (error) => error,
  )
  await vi.advanceTimersByTimeAsync(0)
  expect(completed).toBe(false)
  expect(f.owner.view('workspace', 'chat')).not.toBeNull()
  await vi.advanceTimersByTimeAsync(200)
  expect(await result).toBeUndefined()
  expect(f.stop).not.toHaveBeenCalled()
  expect(f.owner.view('workspace', 'chat')).toBeNull()
  expect(vi.getTimerCount()).toBe(0)
})

it('retains ownership if lease release cannot be confirmed within the existing native wait', async () => {
  vi.useFakeTimers()
  const f = leaseFixture()
  const stopping = f.owner.stop('workspace', 'chat')
  let completed = false
  let completedAt: number | undefined
  const result = stopping.then(
    () => {
      completed = true
    },
    (error) => {
      completedAt = Date.now()
      return error
    },
  )
  await vi.advanceTimersByTimeAsync(4999)
  expect(completed).toBe(false)
  expect(f.hasTeamOwner.mock.calls.length).toBeGreaterThan(1)
  await vi.advanceTimersByTimeAsync(101)
  expect(await result).toBeInstanceOf(Error)
  expect(completedAt! - f.observedExitAt()!).toBeLessThanOrEqual(5000)
  expect(f.stop).not.toHaveBeenCalled()
  expect(f.owner.view('workspace', 'chat')).toMatchObject({
    running: true,
    sendable: false,
    error: true,
  })
  expect(vi.getTimerCount()).toBe(0)
})

it('immediately refuses a peer lease when this stop never observed an original root', async () => {
  vi.useFakeTimers()
  const f = leaseFixture(undefined, false)
  await expect(f.owner.stop('workspace', 'chat')).rejects.toThrow('另一个 Trylo 窗口')
  expect(f.hasTeamOwner).toHaveBeenCalledOnce()
  expect(f.send).not.toHaveBeenCalled()
  expect(f.stop).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
