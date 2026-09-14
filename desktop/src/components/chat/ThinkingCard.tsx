// Trylo Desktop — ThinkingCard.
//
// v1.9: the card title is the SHORT `summary` field from
// the CC thinking event. The longer `preview` (up to 500
// chars) shows only on expand. Per
// C:/work/demo-ws/trylo cli/docs/THINKING_SUMMARIZATION.md,
// the summary heuristic is 3-strategy: regex match
// (action phrases), first sentence, first 8 words.
//
// v1.15.8: stable + streaming. The card is force-expanded
// while `partial === true` (the model is still streaming
// thinking tokens), and STAYS open after the stream ends
// (so the user's reading position isn't yanked away when
// the assistant reply arrives — the "summary gets
// swallowed by the final response" complaint). Click
// still toggles if the user wants to collapse manually.
//
// v1.15.9: the rotating "think" icon that used to live
// in this card moved to a separate <TurnProgress /> row,
// shown above the first thinking card of the active
// turn. The card itself is now a minimal "chevron +
// summary" disclosure. Color is brand-200 (soft gold) —
// the previous brand-500 was too prominent per user
// feedback.
//
// v1.16.4.1: TurnProgress moved OUT of this card and
// into the user message row. The thinking card now
// shows only the thinking summary. Per-turn timer
// props are kept on the type for backward compat but
// are no longer rendered here (MessageList still
// passes them through; the card just ignores them).

import { memo, useState, type ReactElement } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ThinkingMessage } from './types';

export interface ThinkingCardProps {
  readonly message: ThinkingMessage;
  /** v1.15.9: kept on the type for backward compat —
   *  no longer rendered (v1.16.4.1 moved the timer to
   *  the user message row). */
  readonly isFirstInTurn?: boolean;
  /** v1.16.4: kept on the type for backward compat —
   *  no longer rendered here. */
  readonly turnStartedAt?: number | null;
  readonly finalElapsedMs?: number;
  /** v1.16.4: kept on the type for backward compat —
   *  no longer rendered here. */
  readonly isTurnActive: boolean;
}

function ThinkingCardImpl(props: ThinkingCardProps): ReactElement {
  const m = props.message;
  // v1.15.8: default-open when streaming; the user's
  // manual toggle wins once they've clicked.
  const streaming = m.partial === true;
  // v1.15.9.h: when true, the preview body is shown at
  // its natural height (no max-height / scroll) so the
  // user sees the full thinking text without having to
  // scroll inside a small box. The "show full" / "show
  // less" button below the preview toggles this.
  const [showFull, setShowFull] = useState(false);
  // v1.15.9.j: DEFAULT COLLAPSED. The card starts in
  // summary mode. The user clicks the head to expand
  // and see the raw thinking. (v1.15.9.i was wrong:
  // it set the default to expanded because it kept the
  // `!manuallyCollapsed` shape; this renames the state
  // to `manuallyExpanded` and defaults it to false.)
  const [manuallyExpanded, setManuallyExpanded] = useState(false);
  const expanded = manuallyExpanded;
  const previewTrimmed = m.preview.trim();
  const isPlaceholder = !m.summary.trim();
  return (
    <div
      className={`thinking${expanded ? ' thinking--expanded' : ''}`}
      role="listitem"
    >
      <button
        type="button"
        className="thinking__head"
        onClick={() => setManuallyExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span
          className={`thinking__chevron disclosure-chevron${expanded ? ' disclosure-chevron--open' : ''}`}
          aria-hidden="true"
        >
          <ChevronRight size={12} strokeWidth={2.2} />
        </span>
        <span
          className={`thinking__summary${
            isPlaceholder ? ' thinking__summary--placeholder' : ''
          }`}
        >{m.summary || (streaming ? '…' : 'thinking')}</span>
      </button>
      {/* v1.16.5+ (M3, Work): the run's latest activity
          (step / progress marker) as a small status line.
          Shown only while the run is active — once the
          card freezes, the line drops with it so finished
          runs stay visually quiet. */}
      {streaming && m.activity !== undefined && m.activity.trim().length > 0 && (
        <div className="thinking__activity" aria-live="polite">
          {m.activity}
        </div>
      )}
      {/* v1.16.5+ (spec §7.4): the preview stays MOUNTED and
          the shared `.disclosure` grid row animates 0fr→1fr,
          so expand/collapse is a smooth height+opacity
          transition instead of an instant mount/unmount. */}
      {previewTrimmed.length > 0 && (
        <div className={`disclosure${expanded ? ' disclosure--open' : ''}`}>
          <div className="disclosure__inner">
            <pre
              className={`thinking__preview${showFull ? ' thinking__preview--full' : ''}`}
              ref={(el) => {
                if (el && streaming && expanded) {
                  // Auto-scroll the preview to the bottom while
                  // streaming so the user sees the latest token
                  // without having to scroll.
                  el.scrollTop = el.scrollHeight;
                }
              }}
            >{previewTrimmed}</pre>
            {m.fullLength > 500 && (
              <button
                type="button"
                className="thinking__show-full"
                onClick={() => setShowFull((v) => !v)}
              >
                {showFull ? 'show less' : 'show full'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// v1.15.8: compare EVERY field that affects the render.
// The previous comparison only checked `id`, which
// meant the in-place updates from applyThinking (which
// keep the same id) would skip the render entirely —
// the preview never grew, the user saw only the first
// emit's content. v1.15.8.b fixes that.
// v1.15.9: also compare isFirstInTurn + turnStartedAt so
// the TurnProgress row updates when the parent recomputes.
// v1.16.4: also compare finalElapsedMs + isTurnActive so
// the freeze transition and per-turn isolation work.
export const ThinkingCard = memo(ThinkingCardImpl, (prev, next) => {
  return (
    prev.message.id === next.message.id &&
    prev.message.preview === next.message.preview &&
    prev.message.summary === next.message.summary &&
    prev.message.fullLength === next.message.fullLength &&
    prev.message.partial === next.message.partial &&
    prev.message.activity === next.message.activity &&
    prev.isFirstInTurn === next.isFirstInTurn &&
    prev.turnStartedAt === next.turnStartedAt &&
    prev.finalElapsedMs === next.finalElapsedMs &&
    prev.isTurnActive === next.isTurnActive
  );
});
ThinkingCard.displayName = 'ThinkingCard';
