import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { usePreviewBytes } from './usePreviewBytes';
const read = vi.hoisted(() => vi.fn());
vi.mock('../../host-adapter/preview/resources', () => ({ readPreviewBinary: read }));
describe('preview read ownership', () => {
  it('does not expose old bytes for a new path or accept late reads', async () => {
    const pending = new Map<string, (bytes: Uint8Array) => void>();
    read.mockImplementation((path: string) => new Promise((resolve) => pending.set(path, resolve)));
    const hook = renderHook(({ path }) => usePreviewBytes(path), { initialProps: { path: 'a.pdf' } });
    hook.rerender({ path: 'b.pdf' });
    act(() => pending.get('a.pdf')!(new Uint8Array([1])));
    expect(hook.result.current.status).toBe('loading');
    act(() => pending.get('b.pdf')!(new Uint8Array([2])));
    await waitFor(() => expect(hook.result.current).toEqual({ status: 'ready', bytes: new Uint8Array([2]) }));
    hook.rerender({ path: 'c.pdf' });
    expect(hook.result.current.status).toBe('loading');
  });
});
