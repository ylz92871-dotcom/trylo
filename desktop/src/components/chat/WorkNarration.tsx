// Trylo Desktop — WorkNarration (redesign spec §5.3).
//
// One white narration line per phase: "what I understood /
// what I'm doing / why I moved on". The mapper upserts the
// `narration:${runId}:${phaseId}` message in place, so a
// growing narration never stacks rows.

import { memo, type ReactElement } from 'react';
import type { WorkNarrationLine } from './types';

export interface WorkNarrationProps {
  readonly message: WorkNarrationLine;
}

function WorkNarrationImpl(props: WorkNarrationProps): ReactElement {
  const { message } = props;
  return (
    <p
      className="work-narration"
      role="listitem"
      data-phase={message.phaseId}
    >
      {message.text}
    </p>
  );
}

export const WorkNarration = memo(WorkNarrationImpl);
