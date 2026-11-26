import { useSyncExternalStore } from 'react';
import { syncNativeWindowTheme } from '../host-adapter/native-shell';
import { isMacPlatform } from '../utils/platform';
import { prefersReducedMotion } from '../utils/use-presence-transition';

export type Appearance = 'light' | 'dark' | 'system';
const KEY = 'trylo.appearance.v1';
const listeners = new Set<() => void>();
const media = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function defaultAppearance(): Appearance {
  return isMacPlatform() ? 'system' : 'light';
}

function parseSavedAppearance(raw: string | null): Appearance {
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  return defaultAppearance();
}

let preference: Appearance = defaultAppearance();
let nativeSystemTheme: 'light' | 'dark' | null = null;
let lastAppliedTheme: 'light' | 'dark' | null = null;
let themeTransitionTimer: ReturnType<typeof setTimeout> | undefined;

try {
  preference = parseSavedAppearance(localStorage.getItem(KEY));
} catch { /* A restricted webview can still use a session preference. */ }

export function resolvedAppearance(): 'light' | 'dark' {
  if (preference !== 'system') return preference;
  if (nativeSystemTheme !== null) return nativeSystemTheme;
  return media?.matches ? 'dark' : 'light';
}

function apply(syncNative = false): void {
  const nextTheme = resolvedAppearance();
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    if (lastAppliedTheme !== null && lastAppliedTheme !== nextTheme && !prefersReducedMotion()) {
      root.dataset.themeTransition = 'true';
      if (themeTransitionTimer !== undefined) clearTimeout(themeTransitionTimer);
      themeTransitionTimer = setTimeout(() => {
        delete root.dataset.themeTransition;
        themeTransitionTimer = undefined;
      }, 180);
    }
    lastAppliedTheme = nextTheme;
    root.dataset.theme = nextTheme;
  }
  if (syncNative) void syncNativeWindowTheme(preference);
  listeners.forEach((listener) => listener());
}

export function setAppearance(value: Appearance): void {
  nativeSystemTheme = null;
  preference = value;
  try { localStorage.setItem(KEY, value); } catch { /* See session fallback above. */ }
  apply(true);
}

export function refreshSystemAppearance(nativeTheme?: 'light' | 'dark'): void {
  nativeSystemTheme = nativeTheme ?? null;
  if (preference === 'system') apply(false);
}

media?.addEventListener('change', () => {
  nativeSystemTheme = null;
  apply(false);
});
if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
  if (event.key !== KEY) return;
  nativeSystemTheme = null;
  preference = parseSavedAppearance(event.newValue);
  apply(true);
});
apply(true);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useAppearance(): { preference: Appearance; theme: 'light' | 'dark' } {
  const snapshot = useSyncExternalStore(subscribe, () => `${preference}:${resolvedAppearance()}`);
  const [choice, theme] = snapshot.split(':') as [Appearance, 'light' | 'dark'];
  return { preference: choice, theme };
}
