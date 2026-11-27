import { useSyncExternalStore } from 'react';
import { syncNativeWindowTheme } from '../host-adapter/native-shell';
import { isMacPlatform } from '../utils/platform';
import { prefersReducedMotion } from '../utils/use-presence-transition';

export type Appearance = 'light' | 'dark' | 'system';
export interface ThemeTransitionOrigin {
  readonly x: number;
  readonly y: number;
}
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

type ViewTransitionDoc = Document & {
  startViewTransition?: (update: () => void) => { readonly ready: Promise<void> };
};

function applyFallbackTransition(root: HTMLElement): void {
  root.dataset.themeTransition = 'true';
  if (themeTransitionTimer !== undefined) clearTimeout(themeTransitionTimer);
  themeTransitionTimer = setTimeout(() => {
    delete root.dataset.themeTransition;
    themeTransitionTimer = undefined;
  }, 180);
}

function apply(syncNative = false, origin?: ThemeTransitionOrigin): void {
  const nextTheme = resolvedAppearance();
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    const themeChanged = lastAppliedTheme !== null && lastAppliedTheme !== nextTheme;
    lastAppliedTheme = nextTheme;

    if (themeChanged && !prefersReducedMotion()) {
      const vtDoc = document as ViewTransitionDoc;
      if (typeof vtDoc.startViewTransition === 'function') {
        const x = origin?.x ?? (typeof window !== 'undefined' ? window.innerWidth / 2 : 0);
        const y = origin?.y ?? (typeof window !== 'undefined' ? window.innerHeight / 2 : 0);
        const maxX = typeof window !== 'undefined' ? Math.max(x, window.innerWidth - x) : 0;
        const maxY = typeof window !== 'undefined' ? Math.max(y, window.innerHeight - y) : 0;
        const radius = Math.hypot(maxX, maxY);
        const transition = vtDoc.startViewTransition(() => {
          root.dataset.theme = nextTheme;
        });
        void transition.ready
          .then(() => {
            if (typeof root.animate !== 'function') return;
            try {
              root.animate(
                {
                  clipPath: [
                    `circle(0px at ${x}px ${y}px)`,
                    `circle(${radius}px at ${x}px ${y}px)`,
                  ],
                },
                {
                  duration: 360,
                  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
                  pseudoElement: '::view-transition-new(root)',
                },
              );
            } catch {
              /* Some headless/older engines lack pseudoElement animation; CSS handles the rest. */
            }
          })
          .catch(() => undefined);
      } else {
        applyFallbackTransition(root);
        root.dataset.theme = nextTheme;
      }
    } else {
      root.dataset.theme = nextTheme;
    }
  }
  if (syncNative) void syncNativeWindowTheme(preference);
  listeners.forEach((listener) => listener());
}

export function setAppearance(value: Appearance, origin?: ThemeTransitionOrigin): void {
  nativeSystemTheme = null;
  preference = value;
  try { localStorage.setItem(KEY, value); } catch { /* See session fallback above. */ }
  apply(true, origin);
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
