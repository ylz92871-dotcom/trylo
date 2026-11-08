import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ read: vi.fn(), decode: vi.fn() }));
vi.mock('../../host-adapter/preview/resources', () => ({ readPreviewBinary: mock.read }));
vi.mock('../../preview/providers/raster', () => ({ decodeRasterPage: mock.decode }));
import { ImagePreview } from './ImagePreview';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); mock.read.mockReset(); mock.decode.mockReset(); });
function setup() {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const create = vi.fn(() => 'blob:image-preview'); const revoke = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke });
  return { create, revoke };
}
it('reads memory-backed archive images without a host path and releases the image URL', async () => {
  const urls = setup(); const view = render(<ImagePreview path="archive/image.png" bytes={new Uint8Array([1, 2, 3])} />);
  await screen.findByRole('img'); expect(mock.read).not.toHaveBeenCalled(); expect(urls.create).toHaveBeenCalledTimes(1);
  view.unmount(); expect(urls.revoke).toHaveBeenCalledWith('blob:image-preview');
});
it('hides old project images immediately while an identical relative path loads from a new root', async () => {
  setup(); mock.read.mockResolvedValueOnce(new Uint8Array([1])).mockImplementationOnce(() => new Promise(() => {}));
  const view = render(<ImagePreview path="image.png" allowedRoot="D:/one" />);
  await screen.findByRole('img'); view.rerender(<ImagePreview path="image.png" allowedRoot="D:/two" />);
  expect(screen.queryByRole('img')).toBeNull(); await waitFor(() => expect(mock.read).toHaveBeenCalledTimes(2));
});
it.each([
  ['saved.data', [73, 73, 42, 0, 8, 0, 0, 0], 'tiff'],
  ['wrong.heic', [77, 77, 0, 42, 0, 0, 0, 8], 'tiff'],
  ['saved.download', [0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99], 'heif'],
])('uses image bytes to choose the decoder for %s and cancels it on close', async (path, header, format) => {
  setup(); const bytes = Uint8Array.from(header as number[]);
  mock.decode.mockResolvedValue({ blob: new Blob(['decoded'], { type: 'image/png' }), pageCount: 2 });
  const view = render(<ImagePreview path={path as string} bytes={bytes} />);
  await screen.findByRole('img');
  expect(mock.decode).toHaveBeenCalledWith(bytes, format, 0, expect.any(AbortSignal));
  expect(screen.getByRole('button', { name: '下一幅图像' })).toBeTruthy();
  const signal = mock.decode.mock.calls[0]![3] as AbortSignal;
  view.unmount(); expect(signal.aborted).toBe(true);
});
it('uses a known PNG header instead of a misleading HEIC extension', async () => {
  const urls = setup();
  render(<ImagePreview path="wrong.heic" bytes={Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])} />);
  await screen.findByRole('img');
  expect(mock.decode).not.toHaveBeenCalled();
  expect(urls.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'image/png' }));
});
