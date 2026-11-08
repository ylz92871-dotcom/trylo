import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../host-adapter/preview/resources', () => ({ readPreviewBinary: mock.read }));
import { usePreviewBytes } from './usePreviewBytes';
it('never exposes old bytes when an identical relative path switches project roots', async () => {
  let finish!: (bytes: Uint8Array) => void;
  mock.read.mockResolvedValueOnce(new Uint8Array([1])).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = renderHook(({ root }) => usePreviewBytes('file.pdf', undefined, root), { initialProps: { root: 'D:/one' } });
  await waitFor(() => expect(view.result.current.status).toBe('ready'));
  view.rerender({ root: 'D:/two' }); expect(view.result.current.status).toBe('loading');
  await act(async () => finish(new Uint8Array([2])));
  expect(view.result.current).toMatchObject({ status: 'ready', bytes: new Uint8Array([2]) }); view.unmount();
});
