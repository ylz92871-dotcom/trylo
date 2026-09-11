// Trylo Desktop — React hook for ResultDock conversation-scoped prefs
// (C-Edge P2-4).
//
// Wraps `ResultDockPrefsStore` with `useSyncExternalStore` so the
// component re-renders when the prefs change. The hook is
// intentionally tiny: it does no derivation, no caching, no
// memoization beyond what useSyncExternalStore already gives us.

import { useSyncExternalStore } from 'react';
import {
  type ResultDockKey,
  type ResultDockPrefsStore,
  resultDockPrefsStore,
} from './result-dock-prefs';

export function useResultDockOpen(
  key: ResultDockKey,
  fallback: boolean,
  store: ResultDockPrefsStore = resultDockPrefsStore,
): boolean {
  return useSyncExternalStore(
    (listener) => store.subscribeKey(key, listener),
    () => store.getOpen(key, fallback),
    () => fallback,
  );
}
