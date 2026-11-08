import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitFileDiffData } from '../components/code-surface/GitDiffView'
import { useDiffPreview, type DiffPreviewOptions } from './use-diff-preview'

afterEach(cleanup)

const DIFF: GitFileDiffData = {
  original: 'before',
  modified: 'after',
  binary: false,
  truncated: false,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function setup(overrides: Partial<DiffPreviewOptions> = {}) {
  const pending = deferred<GitFileDiffData>()
  const readDiff = vi.fn(() => pending.promise)
  const onOpen = vi.fn()
  const options: DiffPreviewOptions = {
    projectId: 'project-one',
    projectRoot: 'D:/project-one',
    conversationId: 'work-one',
    surface: 'work',
    readDiff,
    onOpen,
    ...overrides,
  }
  return { pending, readDiff, onOpen, options }
}

describe('useDiffPreview', () => {
  it('reads the original root, path and rename origin and preserves the host fields', async () => {
    const f = setup()
    const { result } = renderHook(() => useDiffPreview(f.options))
    act(() => result.current.open('src/new.ts', 'src/old.ts'))
    expect(f.onOpen).toHaveBeenCalledTimes(1)
    expect(f.readDiff).toHaveBeenCalledWith('D:/project-one', 'src/new.ts', 'src/old.ts')
    expect(result.current.state).toEqual({
      identity: expect.objectContaining({
        workspaceRoot: 'D:/project-one',
        conversationId: 'work-one',
        path: 'src/new.ts',
        oldPath: 'src/old.ts',
      }),
    })

    await act(async () => {
      f.pending.resolve(DIFF)
    })
    expect(result.current.state?.diff).toEqual(DIFF)
    expect(result.current.state?.error).toBeUndefined()
  })

  it.each([
    ['Work conversation', { conversationId: 'work-two' }],
    ['surface with the same conversation id', { surface: 'code' as const }],
    ['project id with the same root', { projectId: 'project-two' }],
    ['project root with the same id', { projectRoot: 'D:/moved-project-one' }],
  ])('retires a pending reply after switching %s', async (_label, change) => {
    const f = setup()
    const { result, rerender } = renderHook((options) => useDiffPreview(options), {
      initialProps: f.options,
    })
    act(() => result.current.open('src/file.ts'))
    expect(result.current.state).not.toBeNull()

    rerender({ ...f.options, ...change })
    expect(result.current.state).toBeNull()
    await act(async () => {
      f.pending.resolve(DIFF)
    })
    expect(result.current.state).toBeNull()
    expect(f.readDiff).toHaveBeenCalledTimes(1)
  })

  it('keeps the new Work conversation diff when the previous conversation replies later', async () => {
    const previous = deferred<GitFileDiffData>()
    const current = deferred<GitFileDiffData>()
    const readDiff = vi
      .fn()
      .mockReturnValueOnce(previous.promise)
      .mockReturnValueOnce(current.promise)
    const f = setup({ readDiff })
    const { result, rerender } = renderHook((options) => useDiffPreview(options), {
      initialProps: f.options,
    })
    act(() => result.current.open('same.ts'))
    rerender({ ...f.options, conversationId: 'work-two' })
    act(() => result.current.open('same.ts'))
    await act(async () => {
      current.resolve({ ...DIFF, modified: 'current Work conversation' })
    })
    await act(async () => {
      previous.resolve({ ...DIFF, modified: 'previous conversation' })
    })
    expect(result.current.state?.identity.conversationId).toBe('work-two')
    expect(result.current.state?.diff?.modified).toBe('current Work conversation')
  })

  it.each(['success', 'failure'] as const)(
    'does not reopen after close and a late %s',
    async (outcome) => {
      const f = setup()
      const { result } = renderHook(() => useDiffPreview(f.options))
      act(() => result.current.open('src/file.ts'))
      act(() => result.current.close())
      expect(result.current.state).toBeNull()
      await act(async () => {
        if (outcome === 'success') f.pending.resolve(DIFF)
        else f.pending.reject(new Error('old read failed'))
      })
      expect(result.current.state).toBeNull()
      expect(f.onOpen).toHaveBeenCalledTimes(1)
    },
  )

  it('lets the newest rename comparison win even when the target path is unchanged', async () => {
    const older = deferred<GitFileDiffData>()
    const newer = deferred<GitFileDiffData>()
    const readDiff = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const f = setup({ readDiff })
    const { result } = renderHook(() => useDiffPreview(f.options))
    act(() => result.current.open('new.ts', 'old-one.ts'))
    const firstId = result.current.state?.identity.requestId
    act(() => result.current.open('new.ts', 'old-two.ts'))
    await act(async () => {
      newer.resolve({ ...DIFF, modified: 'newest' })
    })
    await act(async () => {
      older.resolve({ ...DIFF, modified: 'stale' })
    })
    expect(result.current.state?.identity.requestId).not.toBe(firstId)
    expect(result.current.state?.identity.oldPath).toBe('old-two.ts')
    expect(result.current.state?.diff?.modified).toBe('newest')
    expect(readDiff.mock.calls).toEqual([
      ['D:/project-one', 'new.ts', 'old-one.ts'],
      ['D:/project-one', 'new.ts', 'old-two.ts'],
    ])
  })

  it('reports a current read failure without changing its identity or reopening the rail', async () => {
    const f = setup()
    const { result } = renderHook(() => useDiffPreview(f.options))
    act(() => result.current.open('src/file.ts'))
    const identity = result.current.state?.identity
    await act(async () => {
      f.pending.reject(new Error('host failure'))
    })
    expect(result.current.state).toEqual({
      identity,
      error: 'Could not load the Git diff for this change.',
    })
    expect(f.onOpen).toHaveBeenCalledTimes(1)
  })

  it('invalidates the pending identity when its view unmounts', async () => {
    const f = setup()
    const readOriginal = vi.fn(() => DIFF.original)
    const response = {
      ...DIFF,
      get original() {
        return readOriginal()
      },
    }
    const { result, unmount } = renderHook(() => useDiffPreview(f.options))
    act(() => result.current.open('src/file.ts'))
    const beforeUnmount = result.current
    unmount()
    await act(async () => {
      f.pending.resolve(response)
    })
    expect(result.current).toBe(beforeUnmount)
    expect(result.current.state?.diff).toBeUndefined()
    expect(readOriginal).not.toHaveBeenCalled()
    expect(f.onOpen).toHaveBeenCalledTimes(1)
  })
})
