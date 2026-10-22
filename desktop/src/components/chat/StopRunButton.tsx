import type { ReactElement } from 'react';
import { Square } from 'lucide-react';

/** The approved round stop control; it cancels the current run, not a resumable pause. */
export function StopRunButton({ onStop, className }: {
  readonly onStop: () => void;
  readonly className: string;
}): ReactElement {
  return <button type="button" className={className} onClick={onStop}
    title="停止当前任务" aria-label="Stop">
    <Square size={12} fill="currentColor" strokeWidth={2.2} aria-hidden="true" />
  </button>;
}
