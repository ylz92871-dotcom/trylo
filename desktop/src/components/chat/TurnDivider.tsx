// Trylo Desktop — TurnDivider.
//
// v1.9: a thin line + "Turn N" label between agent turns.
// Renders when a turn_start event arrives; the status used
// to be appended ("done" / "error") but was removed as UI
// noise (2026-09-03) — the divider is informational only.

import type { ReactElement } from 'react';
import type { TurnMessage } from './types';

export interface TurnDividerProps {
  readonly message: TurnMessage;
}

export function TurnDivider(props: TurnDividerProps): ReactElement {
  const m = props.message;
  return (
    <div className="turn-divider" role="separator" aria-label={`Turn ${m.turn}`}>
      <span className="turn-divider__label">
        Turn {m.turn}
        {m.depth > 0 ? ` (sub ${m.depth})` : ''}
      </span>
    </div>
  );
}
