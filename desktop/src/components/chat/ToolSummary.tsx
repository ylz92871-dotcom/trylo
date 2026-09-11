// Trylo Desktop — ToolSummary.
//
// v1.15.8.c: a small chip that renders at the end of a
// run of tool cards. Shows:
//   - "Ran N tools" total
//   - the kinds and counts (e.g. "Read × 3, Bash × 1")
//   - chevron for expand/collapse
//
// Borrowed from cline's ToolGroupRenderer's "completed
// tools" footer. The chip is collapsed by default —
// expanding shows the individual tool cards that came
// before it. This saves vertical space when the model
// runs many tools in one turn (e.g. 5 reads + 1 bash).

import { useState, type ReactElement } from 'react';
import { ChevronRight, ListChecks } from 'lucide-react';
import { ToolCard } from './ToolCard';
import type { ChatMessage, ToolMessage } from './types';

export interface ToolSummaryProps {
  /** The tool messages in this turn (in order). The
   *  summary summarizes them. */
  readonly tools: readonly ToolMessage[];
}

interface KindBucket {
  readonly name: string;
  count: number;
}

function bucketByKind(tools: readonly ToolMessage[]): KindBucket[] {
  const map = new Map<string, KindBucket>();
  for (const t of tools) {
    const existing = map.get(t.tool);
    if (existing) {
      existing.count += 1;
    } else {
      map.set(t.tool, { name: t.tool || 'tool', count: 1 });
    }
  }
  return Array.from(map.values());
}

export function ToolSummary(props: ToolSummaryProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  if (props.tools.length === 0) return null;

  const buckets = bucketByKind(props.tools);
  const summary = buckets
    .map((b) => `${b.name} × ${b.count}`)
    .join(' · ');

  return (
    <div className="tool-summary" role="listitem">
      <button
        type="button"
        className="tool-summary__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span
          className={`tool-summary__chevron disclosure-chevron${open ? ' disclosure-chevron--open' : ''}`}
          aria-hidden="true"
        >
          <ChevronRight size={12} strokeWidth={2.4} />
        </span>
        <span className="tool-summary__icon" aria-hidden="true">
          <ListChecks size={14} strokeWidth={2.2} />
        </span>
        <span className="tool-summary__label">
          Ran {props.tools.length} tool{props.tools.length === 1 ? '' : 's'}
        </span>
        <span className="tool-summary__breakdown">{summary}</span>
      </button>
      {/* v1.16.5+ (spec §7.4): the tool list stays mounted
          inside the shared `.disclosure` grid row so expand
          is a height+opacity transition, not an instant
          mount. */}
      <div className={`disclosure${open ? ' disclosure--open' : ''}`}>
        <div className="disclosure__inner">
          <div className="tool-summary__list">
            {props.tools.map((t) => (
              <ToolCard key={t.id} message={t} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Helper used by MessageList / a new wrapper to find the
 *  contiguous run of tool messages at the end of a turn
 *  (between the last user message and the end of msgs),
 *  so the ToolSummary can render exactly once. */
export function findTrailingTools(
  msgs: readonly ChatMessage[],
): ToolMessage[] {
  const out: ToolMessage[] = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m) break;
    if (m.kind === 'tool') {
      out.push(m);
      continue;
    }
    // Stop at the first non-tool message in this turn.
    if (m.kind === 'text' && m.role === 'user') break;
    if (m.kind === 'text' && m.role === 'assistant' && !m.frozen) break;
    if (m.kind === 'thinking') break;
    if (m.kind === 'notice' || m.kind === 'turn' || m.kind === 'compaction') break;
  }
  return out.reverse();
}
