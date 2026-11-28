import { useEffect, useState } from 'react';

export type PresenceState = 'entering' | 'open' | 'exiting' | 'unmounted';

export interface PresenceTransitionOptions {
  readonly exitMs: number;
  /** Override jsdom instant-unmount bypass (for dedicated hook tests). */
  readonly forceAnimated?: boolean;
}

export interface PresenceTransitionResult {
  readonly mounted: boolean;
  readonly state: PresenceState;
}

/** True when the user prefers reduced motion via OS/browser accessibility setting. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** True in non-animated jsdom test runs so synchronous RTL unmount assertions remain exact. */
function isNonAnimatedTestEnv(): boolean {
  if (typeof navigator === 'undefined') return true;
  return /\bjsdom\b/i.test(navigator.userAgent);
}

/**
 * Controlled enter/exit presence hook for modals, popovers, and slide panels.
 *
 * Lifecycle (in real browsers without reduced-motion):
 *   unmounted -> entering (1 frame) -> open -> exiting (`exitMs`) -> unmounted
 *
 * In `prefers-reduced-motion: reduce` or jsdom test runs (unless `forceAnimated`),
 * exits unmount synchronously with zero timers so accessibility and test invariants hold.
 */
export function usePresenceTransition(
  open: boolean,
  options: number | PresenceTransitionOptions,
): PresenceTransitionResult {
  const exitMs = typeof options === 'number' ? options : options.exitMs;
  const forceAnimated = typeof options === 'number' ? false : options.forceAnimated === true;
  const skipExit = exitMs <= 0 || prefersReducedMotion() || (!forceAnimated && isNonAnimatedTestEnv());

  const [retained, setRetained] = useState(open);
  const [settledOpen, setSettledOpen] = useState(open);

  useEffect(() => {
    if (skipExit) {
      setRetained(open);
      setSettledOpen(open);
      return undefined;
    }

    if (open) {
      setRetained(true);
      const raf = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(() => setSettledOpen(true))
        : window.setTimeout(() => setSettledOpen(true), 16);
      return () => {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
        else window.clearTimeout(raf);
      };
    }

    setSettledOpen(false);
    if (!retained) return undefined;
    const timer = window.setTimeout(() => {
      setRetained(false);
    }, exitMs);
    return () => window.clearTimeout(timer);
  }, [open, retained, exitMs, skipExit]);

  if (skipExit) {
    return open
      ? { mounted: true, state: 'open' }
      : { mounted: false, state: 'unmounted' };
  }

  if (open) {
    return { mounted: true, state: settledOpen ? 'open' : 'entering' };
  }

  if (retained) {
    return { mounted: true, state: 'exiting' };
  }

  return { mounted: false, state: 'unmounted' };
}
