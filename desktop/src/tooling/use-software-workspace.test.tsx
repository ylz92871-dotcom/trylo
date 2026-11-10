import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useSoftwareWorkspace } from './use-software-workspace'
import type { ToolingFacade } from './tooling-facade'
import {
  softwareScopeKey,
  type SoftwareFrame,
  type SoftwareResult,
  type SoftwareState,
} from './software-workspace-types'

const scope = { projectRoot: 'D:/project', conversationId: 'chat' }
const state: SoftwareState = {
  scope: softwareScopeKey(scope),
  sessionId: 'native-1',
  revision: 1,
  state: 'running',
  detail: '',
  control: 'agent',
  inFlight: 0,
  applications: [],
  windows: [{ id: '10', title: 'CAD', dialog: false, rect: [0, 0, 800, 600] }],
}
const frame: SoftwareFrame = {
  sessionId: 'native-1',
  seq: 1,
  windowId: '10',
  mode: 'window',
  title: 'CAD',
  dialog: false,
  data: 'image',
  mimeType: 'image/jpeg',
  width: 800,
  height: 600,
  timestamp: 100,
}
function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  return {
    promise: new Promise<T>((yes, no) => {
      resolve = yes
      reject = no
    }),
    resolve: (value: T) => resolve(value),
    reject: (error: Error) => reject(error),
  }
}

describe('software workspace observations', () => {
  it('coalesces pulls and rejects a late screenshot after changing view', async () => {
    const picture = pending<SoftwareResult>()
    const request = vi.fn().mockResolvedValueOnce(state).mockReturnValueOnce(picture.promise)
    const facade = { softwareWorkspace: request } as unknown as ToolingFacade
    const hook = renderHook(() => useSoftwareWorkspace({ ...scope, facade }))
    let pull!: Promise<void>
    await act(async () => {
      pull = hook.result.current.refresh()
      await Promise.resolve()
    })
    expect(hook.result.current.refresh()).toBe(pull)
    act(() => hook.result.current.setMode('model'))
    await act(async () => {
      picture.resolve(frame)
      await pull
    })
    expect(hook.result.current.frame).toBeUndefined()
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('does not carry a failed observation or pixels into another conversation', async () => {
    const observed = pending<SoftwareResult>()
    const facade = {
      softwareWorkspace: vi.fn().mockReturnValue(observed.promise),
    } as unknown as ToolingFacade
    const hook = renderHook(
      ({ conversationId }) => useSoftwareWorkspace({ ...scope, conversationId, facade }),
      { initialProps: { conversationId: 'chat' } },
    )
    let pull!: Promise<void>
    act(() => {
      pull = hook.result.current.refresh()
    })
    hook.rerender({ conversationId: 'other-chat' })
    await act(async () => {
      observed.reject(new Error('old process disconnected'))
      await pull
    })
    expect(hook.result.current.error).toBe('')
    expect(hook.result.current.frame).toBeUndefined()
  })
})
