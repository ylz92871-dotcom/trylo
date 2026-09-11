// Trylo Desktop — Code run lifecycle observer (P2-1, spec §7.2).
//
// The explicit observer the Code result projector implements so App no
// longer needs to guess run boundaries from raw LoopEvents. `onRunStarted`
// establishes the run's projection state SYNCHRONOUSLY (audit P1-1) — the
// event buffer exists before the first real event can arrive — while the Git
// baseline snapshot completes asynchronously behind a bounded promise shared
// with the terminal. `onRunTerminal` fires exactly once per runId across
// loop_end / session_end / process exit / cancel.

import type { LoopEvent } from '../host-adapter/loop-events';
import type { RuntimeResultScope } from '../results/result-scope';

export type CodeRunOutcome = 'completed' | 'failed' | 'cancelled' | 'exited';

export interface CodeRunLifecycleObserver {
  /** Establishes the Run-start projection state synchronously; the Git
   *  baseline snapshot then completes asynchronously under a bounded budget
   *  (spec §14) — a slow / failed baseline degrades the projection, never
   *  blocks the run. */
  onRunStarted(scope: RuntimeResultScope): Promise<void> | void;
  /** Batch of structured loop events from the running model loop. */
  onEvents(scope: RuntimeResultScope, events: readonly LoopEvent[]): void;
  /** Exactly-once, per runId. Projection must finalize idempotently. */
  onRunTerminal(
    scope: RuntimeResultScope,
    outcome: CodeRunOutcome,
  ): Promise<void> | void;
}