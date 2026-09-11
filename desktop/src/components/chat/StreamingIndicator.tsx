// Trylo Desktop — StreamingIndicator.
//
// v1.15.9: simplified to 3 jumping dots. The rotating
// Trilo logo + label + timer from v1.15.8.b moved to
// <TurnProgress /> (above the first thinking card of
// the active turn). The footer indicator is now just a
// minimal "still working" hint — three dots that bounce
// in a wave.
//
// v1.16.5+ (Code-Work workflow sync spec §9.3): the
// indicator no longer accepts fake `status`/`currentTool`
// parameters. It consumes the REAL `ConversationRunViewState`
// and animates only when that state's primary animation is
// the three-dot footer (spec §7.2: thinking). Every other
// state renders nothing — the footer must not add a second
// loop animation next to TurnProgress or the Tool loader.

import type { ReactElement } from 'react';
import { type ConversationRunViewState, viewStateShowsFooterDots } from './view-state';

export interface StreamingIndicatorProps {
  /** The shared visible run state (spec §5.3). The dots
   *  render only when this state's primary animation is
   *  the footer (thinking). */
  readonly visibleState: ConversationRunViewState;
}

export function StreamingIndicator(props: StreamingIndicatorProps): ReactElement | null {
  if (!viewStateShowsFooterDots(props.visibleState)) return null;
  const waiting = props.visibleState === 'preparing' || props.visibleState === 'waiting_first_output';
  return (
    <div className="streaming-indicator" role="status" aria-live="polite" data-state={props.visibleState}>
      <span className="streaming-indicator__label">{waiting ? '正在准备' : '正在思考'}</span>
      <span className="streaming-indicator__dots" aria-hidden="true">
        <span className="streaming-indicator__dot" />
        <span className="streaming-indicator__dot" />
        <span className="streaming-indicator__dot" />
      </span>
    </div>
  );
}
