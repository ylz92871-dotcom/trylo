// Trylo Desktop — TurnProgress.
//
// v1.15.9: new. Replaces the rotating "think" icon that
// used to live inside ThinkingCard. Renders a rotating
// Trilo brand logo + elapsed time. The "is the model
// working right now" indicator that used to live inside
// every thinking card is now hoisted into its own row
// above the first thinking card of the turn. The timer
// counts from `turnStartedAt` (set in App.onSend when the
// user hits send), so the user sees "0:00 → 0:01 → ..."
// from the moment their message is in flight.
//
// v1.16.4: per-turn freeze. The timer now lives on the
// user message (ChatMessage.turnStartedAt) — not on a
// top-level state — so multiple turns coexist
// independently. When the first model output arrives
// for the turn, events.ts sets `finalElapsedMs` on the
// user message; TurnProgress freezes the display at
// "已工作 0:12" forever. The spinner + live count
// continues only when the turn is still active (no
// freeze yet) AND this row belongs to the active turn
// (last user message and the CLI is still running).
// See App.tsx isTurnActive and the MessageList wiring.

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Logo } from '../brand/Logo';

export interface TurnProgressProps {
  /** Unix ms when this turn started. The row is hidden
   *  when null (e.g. history messages without a
   *  recorded send time). */
  readonly turnStartedAt: number | null;
  /** v1.16.4: set once the first model output has
   *  arrived. The row renders a frozen
   *  "已工作 0:12" instead of a live counter when
   *  defined. */
  readonly finalElapsedMs?: number;
  /** v1.16.4: true when this turn is the active one
   *  (last user message AND CLI still running). When
   *  false, the row is static — it shows
   *  `finalElapsedMs` if set, or nothing useful
   *  otherwise. */
  readonly isActive: boolean;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function TurnProgress(props: TurnProgressProps): ReactElement | null {
  const [now, setNow] = useState(() => Date.now());
  const tickRef = useRef<number | null>(null);
  useEffect(() => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (props.turnStartedAt === null) return;
    // Only tick while the turn is still active. Once
    // frozen, the displayed value is constant and we
    // stop the interval — that's also what fixes the
    // "second turn sends and the first row's spinner
    // pauses weirdly" bug: each row runs its own
    // interval only for its own active window.
    if (!props.isActive) return;
    if (props.finalElapsedMs !== undefined) return;
    tickRef.current = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      if (tickRef.current !== null) {
        window.clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [props.turnStartedAt, props.isActive, props.finalElapsedMs]);

  if (props.turnStartedAt === null) return null;
  const elapsedMs = props.finalElapsedMs ?? now - props.turnStartedAt;
  // v1.16.4: a spinner + live counter is only shown
  // when the turn is BOTH still waiting for first
  // output AND the active turn. Once frozen (or once
  // a later turn starts), the row is a static label
  // — no animation, no ticking.
  const isLive = props.isActive && props.finalElapsedMs === undefined;
  return (
    <div className="turn-progress" role="status" aria-live="polite">
      <span
        className="turn-progress__logo"
        aria-hidden="true"
      >
        <Logo size={16} decorative />
      </span>
      <span className="turn-progress__timer">
        {isLive ? formatElapsed(elapsedMs) : `已工作 ${formatElapsed(elapsedMs)}`}
      </span>
    </div>
  );
}
