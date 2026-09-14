// Trylo Desktop — useSettings hook. See ARCHITECTURE.md §3
// Phase 1 #8 (Settings UI).
//
// Mirrors useEditorBridge's pattern: a thin React hook that
// owns the AppSettings state and dispatches updates to the
// SettingsService. On first mount for a workspaceRoot it loads
// the persisted settings; on update() it patches state
// optimistically + writes through to the service.
//
// For the spike we keep persistence simple (one file per
// workspace, write on every update). Conflict resolution and
// debounced writes are Phase 1 polish.

import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type SettingsService,
} from '../../host-adapter';
import type { FilePath } from '../../host-adapter';

export interface UseSettingsResult {
  readonly settings: AppSettings;
  readonly update: (patch: Partial<AppSettings>) => Promise<void>;
  /** True on the first load (settings not yet fetched). */
  readonly loading: boolean;
}

export function useSettings(
  workspaceRoot: FilePath,
  service: SettingsService,
): UseSettingsResult {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    service.get(workspaceRoot).then((s) => {
      if (cancelled) return;
      setSettings(s);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [service, workspaceRoot]);

  const update = useCallback(
    async (patch: Partial<AppSettings>) => {
      const next = { ...settings, ...patch };
      setSettings(next); // optimistic
      try {
        await service.set(workspaceRoot, next);
      } catch {
        // Phase 1 polish: surface a toast and roll back. The
        // spike's service is Tauri-backed so a failure here
        // almost certainly means the user closed the workspace.
      }
    },
    [service, workspaceRoot, settings],
  );

  return { settings, update, loading };
}
