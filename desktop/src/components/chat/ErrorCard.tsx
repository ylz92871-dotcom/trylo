// Trylo Desktop — ErrorCard.
//
// v1.16.5+ (M3, Phase C4 / W-OBS-001): the unified error
// presentation for authoritative task failures. Only
// normalized errors reach this component (the Work
// presenter gates them); the renderer never classifies.
// The diagnosticId is shown muted — it is a correlation
// handle for the Diagnostics drawer, not the headline.

import type { ReactElement } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { ErrorMessage } from './types';

export interface ErrorCardProps {
  readonly message: ErrorMessage;
}

export function ErrorCard(props: ErrorCardProps): ReactElement {
  const m = props.message;
  return (
    <div className="error-card" role="alert">
      <div className="error-card__head">
        <TriangleAlert size={14} strokeWidth={2.2} aria-hidden="true" />
        <span className="error-card__title">Task failed</span>
      </div>
      <p className="error-card__body">{m.userMessage}</p>
      <span className="error-card__diag" title="Correlation id — see Diagnostics">
        id: {m.diagnosticId}
      </span>
    </div>
  );
}
