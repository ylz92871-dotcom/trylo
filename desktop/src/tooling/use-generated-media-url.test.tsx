// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readPreviewBinary } from '../host-adapter/preview/resources'
import { useGeneratedMediaUrl } from './use-generated-media-url'
import type { BinaryRef } from './tool-result-content'
vi.mock('../host-adapter/preview/resources', () => ({ readPreviewBinary: vi.fn() }))
vi.mock('./tool-result-store', () => ({ useBinaryRefObjectUrl: () => ({ url: null, failed: false }) }))
const bytes = new Uint8Array([1, 2, 3])
const reference: BinaryRef = { id: 'image', storage: 'workspace-artifact', path: 'D:/task/out.png', mimeType: 'image/png', size: 3,
  sha256: '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81' }
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('URL', class extends URL {
    static override createObjectURL = vi.fn(() => 'blob:verified-image')
    static override revokeObjectURL = vi.fn()
  })
  vi.mocked(readPreviewBinary).mockResolvedValue(bytes)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(readPreviewBinary).mockClear() })

it('requires the actual conversation root before reading a persisted image path', async () => {
  const { result } = renderHook(() => useGeneratedMediaUrl(reference, undefined))
  await waitFor(() => expect(result.current.failed).toBe(true))
  expect(readPreviewBinary).not.toHaveBeenCalled()
})
it('uses the scoped reader, verifies bytes and releases its owned blob URL', async () => {
  const { result, unmount } = renderHook(() => useGeneratedMediaUrl(reference, 'D:/task'))
  await waitFor(() => expect(result.current.url).toBe('blob:verified-image'))
  expect(readPreviewBinary).toHaveBeenCalledWith(reference.path, 'D:/task')
  unmount()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:verified-image')
})
it('does not display a modified file as the original generation result', async () => {
  vi.mocked(readPreviewBinary).mockResolvedValue(new Uint8Array([3, 2, 1]))
  const { result } = renderHook(() => useGeneratedMediaUrl(reference, 'D:/task'))
  await waitFor(() => expect(result.current.failed).toBe(true))
  expect(URL.createObjectURL).not.toHaveBeenCalled()
})
