// Trylo Desktop — useSettings tests. See the architecture doc §3
// Phase 1 #8 (Settings UI).

import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type SettingsService,
} from '../../host-adapter';
import { useSettings } from './useSettings';
import type { FilePath } from '../../host-adapter';

function makeService(
  initial: AppSettings = DEFAULT_SETTINGS,
): SettingsService {
  const store = new Map<FilePath, AppSettings>(
    [['D:/work' as FilePath, initial]],
  );
  return {
    get: vi.fn(async (root: FilePath) => store.get(root) ?? DEFAULT_SETTINGS),
    set: vi.fn(async (root: FilePath, s: AppSettings) => {
      store.set(root, s);
    }),
  };
}

describe('useSettings', () => {
  it('loads persisted settings on mount and sets loading=false', async () => {
    const persisted = { ...DEFAULT_SETTINGS, fontSize: 18 };
    const service = makeService(persisted);
    const { result } = renderHook(() =>
      useSettings('D:/work' as FilePath, service),
    );
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.settings).toEqual(persisted);
  });

  it('falls back to defaults when the service returns nothing', async () => {
    const service = makeService();
    const { result } = renderHook(() =>
      useSettings('D:/never' as FilePath, service),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('update() patches state optimistically and calls service.set', async () => {
    const service = makeService();
    const { result } = renderHook(() =>
      useSettings('D:/work' as FilePath, service),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.update({ fontSize: 20 });
    });
    expect(result.current.settings.fontSize).toBe(20);
    expect(service.set).toHaveBeenCalledWith(
      'D:/work',
      expect.objectContaining({ fontSize: 20 }),
    );
  });
});
