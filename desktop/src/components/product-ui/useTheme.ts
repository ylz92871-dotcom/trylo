// Trylo Desktop — useTheme. See ARCHITECTURE.md §3 Phase 1 #9
// (Theming).
//
// Three-theme state machine mapped onto <body>'s `data-theme`
// attribute:
//   - 'dark'  : force dark
//   - 'light' : force light
//   - 'auto'  : follow prefers-color-scheme
//
// The CSS in `index.css` reads `data-theme` and provides
// matching variable values. `useTheme` returns the Monaco
// theme id (`vs-dark` / `vs`) that matches the current
// selection, which the MonacoEditor uses to call
// `monaco.editor.setTheme()`.
//
// `data-theme-resolved` is a sibling attribute that App.tsx
// sets to the actual OS-resolved value when `data-theme` is
// `auto`. This lets the CSS rules above pick the right
// palette without a media query (which can't read the value of
// another attribute on the same element).

import { useEffect, useMemo, useState } from 'react';
import type { Theme } from '../../host-adapter';

export interface UseThemeResult {
  /** The theme the user picked (raw value). */
  readonly theme: Theme;
  /** 'vs-dark' | 'vs' — feed this to `monaco.editor.setTheme`. */
  readonly monacoTheme: 'vs-dark' | 'vs';
  /** Set the theme; the body attribute and the resolved attr
   *  update on the next render. */
  readonly setTheme: (next: Theme) => void;
}

function resolvedAttrFor(theme: Theme): 'light' | 'dark' {
  if (theme === 'dark') return 'dark';
  if (theme === 'light') return 'light';
  // auto: ask the OS. The CSS in index.css picks the palette
  // from `data-theme-resolved`.
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

function monacoIdFor(resolved: 'light' | 'dark'): 'vs-dark' | 'vs' {
  return resolved === 'dark' ? 'vs-dark' : 'vs';
}

export function useTheme(initial: Theme): UseThemeResult {
  const [theme, setTheme] = useState<Theme>(initial);

  // Compute the resolved attribute synchronously on first
  // render so the body picks up the right palette immediately.
  const [resolved, setResolved] = useState<'light' | 'dark'>(() =>
    resolvedAttrFor(initial),
  );

  // Update the body whenever theme or resolved changes.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const body = document.body;
    body.setAttribute('data-theme', theme);
    const nextResolved = resolvedAttrFor(theme);
    setResolved(nextResolved);
    body.setAttribute('data-theme-resolved', nextResolved);
  }, [theme]);

  // Auto theme reacts to OS preference changes.
  useEffect(() => {
    if (theme !== 'auto' || typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const update = (): void => {
      const r = mq.matches ? 'dark' : 'light';
      setResolved(r);
      document.body.setAttribute('data-theme-resolved', r);
    };
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [theme]);

  const monacoTheme = useMemo(() => monacoIdFor(resolved), [resolved]);

  return { theme, monacoTheme, setTheme };
}
