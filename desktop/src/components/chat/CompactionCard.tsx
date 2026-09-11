// Trylo Desktop — CompactionCard.
//
// v1.9: small pill that shows context was compacted.
// "180k → 40k" style. Shown for `compaction_trigger` and
// `compact (boundary)` events.
// v1.9.1: token counts are optional — replaying an old
// boundary marker may not have them. Missing values render
// as "—" (never "undefined"); when BOTH are missing the pill
// shows just "context compacted".

import type { ReactElement } from 'react';
import type { CompactionMessage } from './types';

export interface CompactionCardProps {
  readonly message: CompactionMessage;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

/** True when a token count is actually usable for display. */
function hasCount(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

export function CompactionCard(props: CompactionCardProps): ReactElement {
  const m = props.message;
  const before = hasCount(m.tokensBefore) ? formatTokens(m.tokensBefore) : '—';
  const after = hasCount(m.tokensAfter) ? formatTokens(m.tokensAfter) : '—';
  const hasAny = hasCount(m.tokensBefore) || hasCount(m.tokensAfter);
  return (
    <div className="compaction" role="listitem">
      <span className="compaction__icon" aria-hidden="true">↻</span>
      <span className="compaction__text">
        context compacted{hasAny ? ` · ${before} → ${after}` : ''}
      </span>
    </div>
  );
}
