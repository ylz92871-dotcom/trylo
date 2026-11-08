import { afterEach, expect, it, vi } from 'vitest'
import { ServicesClient } from './services-client'
import { encodeFrame } from './frames'
import { createToolingFacade } from '../tooling/tooling-facade'

afterEach(() => {
  vi.useRealTimers()
})

it.each(['code', 'work'] as const)(
  'retains a fast %s profile reply while the renderer listener is still registering',
  async (surface) => {
    vi.useFakeTimers()
    let handler: ((event: { payload: unknown }) => void) | undefined
    let register!: () => void
    const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      const request = JSON.parse(String(args?.frame))
      handler?.({
        payload: encodeFrame({
          version: 1, type: 'response', id: request.id, ok: true,
          result: { ok: true, profileId: surface + '.core.v1' },
        }),
      })
    })
    const client = new ServicesClient({
      invoke,
      listen: (_event, listener) => new Promise((resolve) => {
        register = () => {
          handler = listener
          resolve(() => { handler = undefined })
        }
      }),
    })
    const startup = client.start()
    const reply = createToolingFacade(client).resolveProfile({
      surface, projectKey: 'workspace', projectRoot: 'D:/fixture',
      conversationId: 'original-chat', permissionLevel: 'ask',
    }, { required: surface === 'work' }).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    )
    register()
    await startup
    await vi.advanceTimersByTimeAsync(120_000)
    const outcome = await reply
    expect(outcome.error).toBeNull()
    expect(outcome.value).toMatchObject({ ok: true, profileId: surface + '.core.v1' })
    expect(invoke).toHaveBeenCalledOnce()
    await client.stop()
  },
)

it('does not send a delayed request after its client lifecycle has been stopped', async () => {
  let register!: () => void
  const unsubscribe = vi.fn()
  const invoke = vi.fn(async () => {})
  const client = new ServicesClient({
    invoke,
    listen: () => new Promise((resolve) => { register = () => resolve(unsubscribe) }),
  })
  const startup = client.start()
  const reply = client.request('tooling.health', {}).catch((error: unknown) => error)
  await client.stop()
  register()
  await startup
  expect(await reply).toMatchObject({ code: 'NOT_CONNECTED' })
  expect(invoke).not.toHaveBeenCalled()
  expect(unsubscribe).toHaveBeenCalledOnce()
})
