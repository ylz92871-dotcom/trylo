// Trylo Desktop — context-window ring. See v1.16.0.
//
// v1.16.2.6: FINAL simplification. The previous
// "click to open a popover with usage + a Compact now
// action" design kept failing in the browser — the
// popover was being clipped or not rendering, the user
// got no visible feedback, the click appeared to do
// nothing. We're not going to keep iterating on the
// popover. The new design is the simplest possible
// thing that works:
//
//   - The ring is a plain <button>.
//   - Click fires onCompact directly. No popover, no
//     state machine, no portal, no positioning.
//   - The button briefly shows a "✓" confirmation
//     when clicked (1.5s), so the user has clear
//     visual feedback that the action was registered.
//   - The tooltip (title attribute) explains what
//     happens: "Click to compact the current context.
//     Writes /compact to the CLI. Requires tauri:dev
//     to actually run."
//   - The label next to the ring still shows the
//     current token count, e.g. "47k".
//
// Context % is shown as a number next to the label
// (e.g. "47k · 24%"). The user can read it directly
// without opening a popover.
//
// Trade-off vs v1.16.2.5: no fancy popover, no per-
// model display, no "No live CLI" badge. We accept
// the trade-off because the popover kept breaking
// and the user just wants the feature to work.
//
// Data flow (unchanged):
//   CLI emits turn_end.usage.input_tokens
//     -> events.ts applyTurnEnd
//     -> App.tsx derives currentContextTokens
//     -> this component
//   Click -> onCompact() -> App.tsx writes /compact
//     to stdin -> CLI summarises + emits compact events.

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { formatTokenCountShort } from '../../host-adapter/context-windows';

export interface ContextRingProps {
  readonly used: number;
  readonly total: number;
  /** Optional. When provided, the ring is clickable and
   *  calls onCompact on click. When undefined, the ring
   *  is a passive gauge. */
  readonly onCompact?: () => void;
}

function tierClass(pct: number): string {
  if (pct < 60) return 'safe';
  if (pct < 85) return 'warm';
  if (pct < 95) return 'hot';
  return 'danger';
}

export function ContextRing(props: ContextRingProps): ReactElement {
  const { used, total, onCompact } = props;
  const hasData = used > 0;
  // 2026-09-04: an EMPTY conversation now renders a visible "0%" ring
  // instead of a bare 20px track that looked like a missing element.
  // The arc clamps to a small minimum so the gauge reads as a ring.
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const arcPct = hasData ? Math.max(pct, 2) : 2;
  const tier = tierClass(pct);
  const shortLabel = hasData ? formatTokenCountShort(used) : '0';
  const compactTitle = onCompact
    ? 'Click to compact the current context. Writes /compact to the CLI. Run `pnpm tauri:dev` to actually trigger the compaction.'
    : 'Context window usage';
  const interactive = typeof onCompact === 'function';

  // v1.16.2.6: brief ✓ confirmation after click. 1.5s.
  // Auto-resets. No popover, no portal, no positioning.
  const [justFired, setJustFired] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const handleClick = (): void => {
    onCompact?.();
    setJustFired(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setJustFired(false);
      timer.current = null;
    }, 1500);
  };

  return (
    <button
      type="button"
      className={`context-ring context-ring--${tier}${interactive ? ' context-ring--clickable' : ''}`}
      title={compactTitle}
      aria-label={compactTitle}
      onClick={interactive ? handleClick : undefined}
      disabled={!interactive}
    >
      {/* SVG ring gauge showing context usage percentage */}
      <svg
        className="context-ring__gauge"
        width="20"
        height="20"
        viewBox="0 0 20 20"
        aria-hidden="true"
      >
        {/* Background track */}
        <circle
          cx="10"
          cy="10"
          r="8"
          fill="none"
          stroke="var(--border, rgba(255, 255, 255, 0.12))"
          strokeWidth="2.5"
        />
        {/* Foreground arc — stroke-dasharray draws the filled portion */}
        <circle
          cx="10"
          cy="10"
          r="8"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${(arcPct / 100) * 50.27} 50.27`}
          transform="rotate(-90 10 10)"
          className={`context-ring__arc context-ring__arc--${tier}`}
        />
      </svg>
      {(justFired || hasData) && (
        <span className="context-ring__label">
          {justFired ? '✓ Sent' : `${shortLabel}${hasData ? ` · ${Math.round(pct)}%` : ''}`}
        </span>
      )}
    </button>
  );
}
