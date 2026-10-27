import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { usePlatformModels } from './use-platform-models';
import { readPlatformModels, subscribePlatformModels } from './platform-models';

vi.mock('./platform-models', () => ({ readPlatformModels: vi.fn(), subscribePlatformModels: vi.fn(() => () => {}) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const text = { id: 'Qwen3.8-Flash-Next', chat: true, pool: 'free' as const, remaining: 1000 };

it('syncs authorized text once per model and excludes specialist models', async () => {
  vi.mocked(readPlatformModels).mockResolvedValue({ owner: 'owner', models: [text, text, { ...text, id: 'OCR', chat: false }] });
  const { result } = renderHook(() => usePlatformModels(true));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.models).toEqual([text]); expect(result.current.message).toBe('');
});
it('clears old-account options immediately and ignores its delayed catalogue after logout', async () => {
  let finish!: (value: Awaited<ReturnType<typeof readPlatformModels>>) => void;
  vi.mocked(readPlatformModels).mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockRejectedValueOnce(Error('请先登录 Trylo 账号。'));
  const { result } = renderHook(() => usePlatformModels(true));
  await act(async () => { vi.mocked(subscribePlatformModels).mock.calls.at(-1)![0](); });
  await act(async () => { finish({ owner: 'old', models: [text] }); });
  expect(result.current.models).toEqual([]); expect(result.current.message).toMatch(/先登录/);
});
it('shows grant and offline states without inserting a hardcoded free model', async () => {
  vi.mocked(readPlatformModels).mockResolvedValueOnce({ owner: 'owner', models: [], reason: '当前账号暂无模型授权' }).mockRejectedValueOnce(Error('模型服务暂时不可用'));
  const { result } = renderHook(() => usePlatformModels(true));
  await waitFor(() => expect(result.current.message).toMatch(/暂无模型授权/));
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(result.current.models).toEqual([]); expect(result.current.message).toMatch(/暂时不可用/);
});
