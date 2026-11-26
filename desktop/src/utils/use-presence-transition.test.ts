import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prefersReducedMotion, usePresenceTransition } from './use-presence-transition';

function mockMatchMedia(reduced: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('prefers-reduced-motion') ? reduced : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe('usePresenceTransition', () => {
  afterEach(() => {
    vi.useRealTimers();
    mockMatchMedia(false);
  });

  it('unmounts synchronously in default jsdom environment', () => {
    const { result, rerender } = renderHook(
      ({ open }) => usePresenceTransition(open, 180),
      { initialProps: { open: false } },
    );
    expect(result.current).toEqual({ mounted: false, state: 'unmounted' });

    rerender({ open: true });
    expect(result.current).toEqual({ mounted: true, state: 'open' });

    rerender({ open: false });
    expect(result.current).toEqual({ mounted: false, state: 'unmounted' });
  });

  it('runs entering -> open -> exiting -> unmounted when animated', () => {
    vi.useFakeTimers();
    mockMatchMedia(false);

    const { result, rerender } = renderHook(
      ({ open }) => usePresenceTransition(open, { exitMs: 140, forceAnimated: true }),
      { initialProps: { open: false } },
    );
    expect(result.current).toEqual({ mounted: false, state: 'unmounted' });

    rerender({ open: true });
    expect(result.current).toEqual({ mounted: true, state: 'entering' });

    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(result.current).toEqual({ mounted: true, state: 'open' });

    rerender({ open: false });
    expect(result.current).toEqual({ mounted: true, state: 'exiting' });

    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toEqual({ mounted: true, state: 'exiting' });

    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current).toEqual({ mounted: false, state: 'unmounted' });
  });

  it('cancels exit timer cleanly when re-opened mid-exit', () => {
    vi.useFakeTimers();
    mockMatchMedia(false);

    const { result, rerender } = renderHook(
      ({ open }) => usePresenceTransition(open, { exitMs: 180, forceAnimated: true }),
      { initialProps: { open: true } },
    );
    act(() => {
      vi.advanceTimersByTime(20);
    });
    expect(result.current).toEqual({ mounted: true, state: 'open' });

    rerender({ open: false });
    expect(result.current).toEqual({ mounted: true, state: 'exiting' });

    act(() => {
      vi.advanceTimersByTime(90);
    });
    rerender({ open: true });
    expect(result.current).toEqual({ mounted: true, state: 'entering' });

    // Advance well past original exitMs; must remain mounted & open.
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(result.current).toEqual({ mounted: true, state: 'open' });
  });

  it('skips exit delay when prefers-reduced-motion: reduce is active', () => {
    mockMatchMedia(true);
    expect(prefersReducedMotion()).toBe(true);

    const { result, rerender } = renderHook(
      ({ open }) => usePresenceTransition(open, { exitMs: 180, forceAnimated: true }),
      { initialProps: { open: true } },
    );
    expect(result.current).toEqual({ mounted: true, state: 'open' });

    rerender({ open: false });
    expect(result.current).toEqual({ mounted: false, state: 'unmounted' });
  });
});
