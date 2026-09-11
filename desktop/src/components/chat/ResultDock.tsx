// Trylo Desktop — ResultDock (P2-1, spec §9 / C-Edge P2-4).
//
// The ONE shared result-summary shell for Code and Work. It only owns
// layout, collapse/expand, count, status, ARIA, keyboard, scrolling and
// reduced-motion. It never imports the Git service, the Work runtime or
// conversation history, and it does not know the internal shape of a Code
// change or a Work artifact — those come in as `children` (mode-specific
// content components). Spec §4.4 "share the shell, not a lowest-common-
// denominator item model".
//
// **C-Edge P2-4 — controlled, conversation-scoped, accessible.**
//   - `open` / `onOpenChange` / `onToggle` are controlled. The parent
//     is the conversation-scoped `ResultDockPrefsStore`; the dock
//     itself never holds UI preference state.
//   - `aria-label` carries the title only. The count is shown
//     visually in a `<span>` so we don't double-announce.
//   - Space / Enter activate the header button; Escape collapses via
//     `onToggle` (if supplied by the parent).
//   - `role="status"` stays on the warning and retry affordance so
//     screen readers always know the dock is non-empty.

import { type ReactElement, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';

export type ResultDockStatus = 'ready' | 'partial' | 'failed';

export interface ResultDockProps {
  readonly id: string;
  readonly mode: 'code' | 'work';
  readonly title: string;
  /** The REAL total of the main list — not the truncated DOM count. */
  readonly count: number;
  readonly status: ResultDockStatus;
  readonly summary?: string;
  readonly warning?: string;
  readonly truncated?: boolean;
  /** Whether to start expanded on first non-empty appearance. */
  readonly defaultOpen?: boolean;
  /**
   * Controlled open state. C-Edge P2-4: the parent owns this
   * (typically a `ResultDockPrefsStore` entry keyed by
   * `(surface, projectKey, conversationId)`) so collapse state
   * survives conversation switches and route changes.
   */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * Optional Escape handler. When provided, the header button
   * collapses the dock on Escape. Without it, Escape does nothing
   * (the page-level focus management owns dismissal).
   */
  readonly onToggle?: () => void;
  readonly onRefresh?: () => void;
  readonly children: ReactNode;
}

export function ResultDock(props: ResultDockProps): ReactElement | null {
  const { open, onOpenChange, onToggle } = props;

  // §9.3: idle with no results and no warning → not rendered. The parent
  // decides that: a zero-count ready dock is still shown when warning or
  // children present.
  const hasBody = props.count > 0 || props.warning !== undefined || props.status === 'failed';
  const shown = props.status === 'failed' || props.count > 0 || props.warning !== undefined;

  if (!shown) return null;

  const handleToggle = (): void => {
    onOpenChange(!open);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'Escape') {
      if (onToggle && open) {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      // The button's default click handler already covers the real
      // browser; this branch exists so jsdom-driven tests (which don't
      // synthesise a click from a keyDown) and any non-default
      // activation path stay in sync with the controlled state.
      e.preventDefault();
      onOpenChange(!open);
    }
  };

  return (
    <div
      className={`result-dock result-dock--${props.mode}`}
      data-mode={props.mode}
      data-status={props.status}
    >
      <button
        type="button"
        className="result-dock__head"
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
        aria-expanded={open}
        aria-controls={`${props.id}-body`}
        aria-label={props.title}
      >
        <span
          className={`result-dock__chevron disclosure-chevron${open ? ' disclosure-chevron--open' : ''}`}
          aria-hidden="true"
        >
          <ChevronRight size={12} strokeWidth={2.2} />
        </span>
        <span className="result-dock__title">{props.title}</span>
        {props.status === 'failed' ? (
          <span className="result-dock__fail-badge">失败</span>
        ) : (
          <span className="result-dock__count" aria-hidden="true">
            {props.count}
          </span>
        )}
      </button>
      {hasBody && (
        <div
          id={`${props.id}-body`}
          className={`disclosure${open ? ' disclosure--open' : ''}`}
        >
          <div className="disclosure__inner">
            {props.summary ? (
              <p className="result-dock__summary">{props.summary}</p>
            ) : null}
            {props.warning ? (
              <p className="result-dock__warning" role="status">
                {props.warning}
              </p>
            ) : null}
            {props.truncated ? (
              <p className="result-dock__truncated">
                产物较多，当前仅显示最近的项目。
              </p>
            ) : null}
            {props.status === 'failed' && props.onRefresh ? (
              <button
                type="button"
                className="result-dock__retry"
                onClick={props.onRefresh}
              >
                重试
              </button>
            ) : null}
            <div className="result-dock__content">{props.children}</div>
          </div>
        </div>
      )}
    </div>
  );
}
