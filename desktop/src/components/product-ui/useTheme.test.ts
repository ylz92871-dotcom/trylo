// Trylo Desktop — useTheme tests. See ARCHITECTURE.md §3
// Phase 1 #9 (Theming).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTheme } from './useTheme';

describe('useTheme', () => {
  beforeEach(() => {
    document.body.removeAttribute('data-theme');
    document.body.removeAttribute('data-theme-resolved');
  });
  afterEach(() => {
    document.body.removeAttribute('data-theme');
    document.body.removeAttribute('data-theme-resolved');
  });

  it('writes data-theme and data-theme-resolved on mount', () => {
    renderHook(() => useTheme('dark'));
    expect(document.body.getAttribute('data-theme')).toBe('dark');
    expect(document.body.getAttribute('data-theme-resolved')).toBe('dark');
  });

  it('returns vs-dark for the dark theme', () => {
    const { result } = renderHook(() => useTheme('dark'));
    expect(result.current.monacoTheme).toBe('vs-dark');
  });

  it('returns vs for the light theme', () => {
    const { result } = renderHook(() => useTheme('light'));
    expect(result.current.monacoTheme).toBe('vs');
  });

  it('setTheme updates the body attribute', () => {
    const { result } = renderHook(() => useTheme('dark'));
    act(() => result.current.setTheme('light'));
    expect(document.body.getAttribute('data-theme')).toBe('light');
    expect(result.current.monacoTheme).toBe('vs');
  });

  it('auto theme resolves to the OS preference', () => {
    // jsdom doesn't ship matchMedia. Stub it so the hook's
    // resolve path doesn't throw. We leave the default
    // `matches: false` so the resolved attr lands on 'light'.
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    renderHook(() => useTheme('auto'));
    expect(document.body.getAttribute('data-theme')).toBe('auto');
    expect(document.body.getAttribute('data-theme-resolved')).toBe('light');
  });
});
