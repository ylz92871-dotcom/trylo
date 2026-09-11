// Trylo Desktop — focus capture / restore (C-Edge P2-4 a11y).
//
// A pair of one-liners used by any panel / overlay that takes focus
// from the page and must give it back on close. The store lives on
// the module so a single open / close cycle is symmetric regardless
// of how many call sites participate.

const FOCUS_KEY = '__trylo_last_focus__';

declare global {
  interface Window {
    [FOCUS_KEY]?: HTMLElement | null;
  }
}

/** Snapshot the current `document.activeElement` so a later
 *  `restoreFocus()` can put focus back where the user was. Safe to
 *  call when nothing is focused (records `null`). */
export function captureFocus(): void {
  if (typeof document === 'undefined') return;
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    window[FOCUS_KEY] = active;
  }
}

/** Restore focus to the element captured by the most recent
 *  `captureFocus()`. Clears the snapshot. No-op when nothing was
 *  captured or the element is no longer in the DOM. */
export function restoreFocus(): void {
  if (typeof window === 'undefined') return;
  const target = window[FOCUS_KEY];
  window[FOCUS_KEY] = undefined;
  if (!target || !target.isConnected) return;
  try {
    target.focus();
  } catch {
    /* best-effort: the element may have been re-rendered */
  }
}

/** Test seam: clear the captured focus without restoring. */
export function resetCapturedFocus(): void {
  if (typeof window !== 'undefined') {
    window[FOCUS_KEY] = undefined;
  }
}
