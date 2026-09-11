// Trylo Desktop — Background Activity Center (M4-D).
//
// The Activity Center is the user-visible projection of
// the run supervisor. It is NOT a decorative popover:
// it answers "what's running right now that I can't see
// in the current view?" and gives the user a way to
// (1) jump to the conversation and (2) stop a specific
// run.
//
// The popover takes a list of `ActivityItem`s that the
// host (App.tsx) has already mapped from the Code
// supervisor and the Work task registry. This component
// does not own state about what is "active" — it just
// renders what's given. A zero-length list shows an
// empty-state hint.
//
// Accessibility:
//   - The popover is `role="dialog"` with an
//     `aria-label`.
//   - Escape closes the popover and returns focus to
//     the previously focused element (the trigger).
//   - Each row exposes Stop and Jump as plain buttons
//     with `aria-label`s that include the conversation
//     title.
//   - Outside-click closes the popover.
//   - reduced-motion: no entrance animation, the
//     rows rely on the standard border + bg instead
//     of moving parts.

import { useEffect, useRef, type ReactElement } from 'react';
import { StopCircle, ArrowRight, X, Code2, Briefcase } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type ActivityKind = 'code' | 'work';

export interface ActivityItem {
  /** Stable id (runId / taskId + work or code tag). */
  readonly id: string;
  readonly kind: ActivityKind;
  /** Conversation the run belongs to. The host uses
   *  this to switch `topMode`, `codeSessionId`, etc. */
  readonly conversationId: string;
  /** Short display label for the workspace
   *  (e.g. "trylo"). */
  readonly workspaceLabel: string;
  /** Conversation title. */
  readonly title: string;
  /** Human status string, e.g. "Running", "Working",
   *  "Reconnecting". */
  readonly statusLabel: string;
  /** ms epoch when the run started. */
  readonly startedAt: number;
  /** Stops the run. The host wires this to either
   *  the Code controller or the Work runtime. */
  readonly onStop: () => void;
  /** Switches the visible conversation to the one
   *  the run belongs to. */
  readonly onJump: () => void;
}

export interface BackgroundActivityCenterProps {
  readonly open: boolean;
  readonly items: readonly ActivityItem[];
  readonly onClose: () => void;
}

const KIND_ICON: Record<ActivityKind, LucideIcon> = {
  code: Code2,
  work: Briefcase,
};

function formatElapsed(startedAt: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}:${String(remSec).padStart(2, '0')}`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}:${String(remMin).padStart(2, '0')}:${String(remSec).padStart(2, '0')}`;
}

export function BackgroundActivityCenter(
  props: BackgroundActivityCenterProps,
): ReactElement | null {
  const popoverRef = useRef<HTMLDivElement>(null);
  // Capture the focused element when the popover opens
  // so we can restore focus on close.
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!props.open) return;
    lastFocusedRef.current =
      (document.activeElement as HTMLElement | null) ?? null;
    // Focus the first interactive element (the close
    // button) so screen readers land somewhere useful.
    const closeBtn = popoverRef.current?.querySelector<HTMLButtonElement>(
      '[data-activity-close]',
    );
    closeBtn?.focus();
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        props.onClose();
      }
    }
    function onClick(e: MouseEvent): void {
      const root = popoverRef.current;
      if (!root) return;
      if (e.target instanceof Node && root.contains(e.target)) return;
      props.onClose();
    }
    window.addEventListener('keydown', onKey);
    // mousedown so we close before any other click handlers
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
      // Restore focus to the trigger.
      const last = lastFocusedRef.current;
      if (last && document.contains(last)) {
        last.focus();
      }
    };
  }, [props.open, props]);

  if (!props.open) return null;

  const count = props.items.length;
  const now = Date.now();

  return (
    <div
      ref={popoverRef}
      className="activity-center"
      role="dialog"
      aria-label="Background Activity Center"
    >
      <div className="activity-center__header">
        <span className="activity-center__title">
          Active runs
          <span className="activity-center__count" aria-label={`${count} active`}>
            {count}
          </span>
        </span>
        <button
          type="button"
          className="activity-center__close"
          onClick={props.onClose}
          aria-label="Close Activity Center"
          data-activity-close
        >
          <X size={14} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>
      {count === 0 ? (
        <div className="activity-center__empty">
          No active runs. Switch between Code and Work without
          losing work in the other mode.
        </div>
      ) : (
        <ul className="activity-center__list" role="list">
          {props.items.map((it) => {
            const Icon = KIND_ICON[it.kind];
            return (
              <li key={it.id} className="activity-row">
                <div className="activity-row__main">
                  <span
                    className={`activity-row__kind activity-row__kind--${it.kind}`}
                    aria-hidden="true"
                  >
                    <Icon size={14} strokeWidth={2.2} />
                  </span>
                  <div className="activity-row__body">
                    <div className="activity-row__title-row">
                      <span className="activity-row__title" title={it.title}>
                        {it.title}
                      </span>
                      <span className="activity-row__workspace">
                        {it.workspaceLabel}
                      </span>
                    </div>
                    <div className="activity-row__meta">
                      <span
                        className={`activity-row__status activity-row__status--${it.kind}`}
                      >
                        {it.statusLabel}
                      </span>
                      <span className="activity-row__sep">·</span>
                      <span className="activity-row__elapsed">
                        {formatElapsed(it.startedAt, now)}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="activity-row__actions">
                  <button
                    type="button"
                    className="activity-row__btn activity-row__btn--jump"
                    onClick={() => {
                      it.onJump();
                      props.onClose();
                    }}
                    aria-label={`Jump to ${it.title}`}
                    title="Jump to this conversation"
                  >
                    <ArrowRight size={13} strokeWidth={2.2} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="activity-row__btn activity-row__btn--stop"
                    onClick={it.onStop}
                    aria-label={`Stop ${it.title}`}
                    title="Stop this run"
                  >
                    <StopCircle size={13} strokeWidth={2.2} aria-hidden="true" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
