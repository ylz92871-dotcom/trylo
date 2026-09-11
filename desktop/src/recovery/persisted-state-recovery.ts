// Trylo Desktop — defensive recovery for stale persisted state
// (C-Edge P2-4 / audit L2).
//
// The persisted conversation history may carry:
//   - `results.work.latestRun.status === 'collecting'` (the type
//     allows it even though no current writer sets it; future
//     projectors might)
//   - `session.taskId` (Work) — bound to a work-runtime task
//   - `session.turnId` (Work) — paired with taskId
//   - `ConversationRunSupervisor` (Code) — holds live controllers by
//     `projectKey::conversationId`
//
// On hydrate we cannot trust any of these proxies. The recovery
// verdict for each is driven by the runtime registry:
//   - active  → leave the result as-is
//   - stale   → mark `degraded`, keep the artifacts, append a warning
//   - missing → the binding never existed; keep the result, no
//                change, no warning (a future turn will overwrite it)
//
// The recovery module never destroys data. It overlays a warning and
// status correction so the user can tell "this was running, but the
// runtime is gone" apart from "this is what actually happened".

import type {
  ResultRunStatus,
  StoredConversationResults,
  StoredWorkResult,
  StoredWorkRunDelta,
} from '../results/conversation-result-types';

export type RecoveryState = 'active' | 'stale' | 'missing-binding';

export interface RecoveryVerifiers {
  /** True when the work-runtime registry still has a non-terminal
   *  task for this conversation. */
  readonly isWorkTaskActive: (
    projectKey: string,
    taskId: string,
    turnId: string,
  ) => boolean;
  /** True when the conversation has a live Code controller in the
   *  supervisor (spawning or busy or even idle after a turn). */
  readonly isCodeRunActive: (projectKey: string, conversationId: string) => boolean;
}

export interface RecoveryInput {
  readonly projectKey: string;
  readonly conversationId: string;
  /** Persisted proxy: work taskId. `null` means no binding. */
  readonly workTaskId: string | null;
  readonly workTurnId: string | null;
  /** Verifiers come from the App's runtime holders. */
  readonly verifiers: RecoveryVerifiers;
  readonly now?: () => number;
}

export interface RecoveryReport {
  readonly work: RecoveryState;
  readonly code: RecoveryState;
  /** Warnings to attach to the corrected result (English; short). */
  readonly warnings: readonly string[];
  /** Whether anything was actually rewritten. */
  readonly changed: boolean;
}

export interface RecoveryOutcome {
  readonly results: StoredConversationResults | undefined;
  readonly report: RecoveryReport;
}

const SCHEMA_VERSION = 1;
const WARNING_MAX = 240;

function clipWarning(s: string, max: number = WARNING_MAX): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** Compute the work-task verdict WITHOUT mutating anything. */
function workVerdict(
  input: RecoveryInput,
): { state: RecoveryState; warning?: string } {
  if (input.workTaskId === null || input.workTaskId === '') {
    return { state: 'missing-binding' };
  }
  if (input.verifiers.isWorkTaskActive(
    input.projectKey,
    input.workTaskId,
    input.workTurnId ?? '',
  )) {
    return { state: 'active' };
  }
  return {
    state: 'stale',
    warning: clipWarning(
      `The work task that produced this result is no longer running. The result is kept as a best-effort snapshot.`,
    ),
  };
}

/** Apply a work-stale correction to the persisted work slice. We
 *  never erase createdIds/updatedIds — they are the user-visible
 *  "this run made these things" record. We only demote the status
 *  and append a warning. */
function degradeWorkRun(
  work: StoredWorkResult,
  warning: string,
): StoredWorkResult {
  if (!work.latestRun) return work;
  const prior: StoredWorkRunDelta = work.latestRun;
  // A run that was already failed/cancelled/cancelled by a previous
  // recovery should stay as-is. We only flip "collecting" or
  // "completed" → "degraded".
  if (prior.status === 'failed' || prior.status === 'cancelled' || prior.status === 'degraded') {
    return work;
  }
  const next: StoredWorkRunDelta = {
    ...prior,
    status: 'degraded',
    warning: clipWarning(prior.warning ? `${prior.warning} · ${warning}` : warning),
  };
  return { ...work, latestRun: next };
}

/** Pure recovery policy. Returns the corrected snapshot and a
 *  structured report. The `changed` bit tracks whether the caller
 *  has any work to do, not whether some verifier returned false —
 *  a missing work task on a conversation with no `work` slice
 *  doesn't change anything. */
export function recoverConversation(
  input: RecoveryInput,
  hasWork: boolean,
  hasCode: boolean,
): RecoveryOutcome {
  const work = workVerdict(input);
  const codeState: RecoveryState = input.verifiers.isCodeRunActive(
    input.projectKey,
    input.conversationId,
  )
    ? 'active'
    : 'stale';

  const warnings: string[] = [];
  if (work.warning && hasWork) warnings.push(work.warning);
  if (codeState === 'stale' && hasCode) {
    warnings.push(clipWarning(
      `The Code run that produced this result is no longer running. The result is kept as a best-effort snapshot.`,
    ));
  }

  const changed =
    (work.state === 'stale' && hasWork) ||
    (codeState === 'stale' && hasCode);
  return {
    results: undefined,
    report: {
      work: work.state,
      code: codeState,
      warnings,
      changed,
    },
  };
}

/** Convenience: produce a new `StoredConversationResults` with the
 *  recovery corrections applied. Returns the input unchanged when
 *  nothing needs to change. */
export function applyRecovery(
  prior: StoredConversationResults | undefined,
  input: RecoveryInput,
): RecoveryOutcome {
  if (!prior || prior.schemaVersion !== SCHEMA_VERSION) {
    // Either nothing to recover, or the schema is too old to safely
    // rewrite. The normaliser already strips these out, so the input
    // shape is the caller's problem.
    return {
      results: prior,
      report: {
        work: input.workTaskId ? 'stale' : 'missing-binding',
        code: 'missing-binding',
        warnings: [],
        changed: false,
      },
    };
  }
  const report = recoverConversation(input, prior.work !== undefined, prior.code !== undefined);
  if (!report.report.changed) {
    return { results: prior, report: report.report };
  }
  let next: StoredConversationResults = prior;
  if (report.report.work === 'stale' && prior.work) {
    const w = report.report.warnings[0];
    if (w) {
      const rewritten = degradeWorkRun(prior.work, w);
      if (rewritten !== prior.work) {
        next = { ...next, work: rewritten };
      }
    }
  }
  if (report.report.code === 'stale' && prior.code?.latestRun) {
    const codeMetaStatus: ResultRunStatus = prior.code.latestRun.meta.status;
    if (
      codeMetaStatus === 'failed' ||
      codeMetaStatus === 'cancelled' ||
      codeMetaStatus === 'degraded'
    ) {
      // No rewrite; the audit demands "never pretend success", which
      // is satisfied by ALSO not pretending freshness. The report
      // still records the stale binding for caller-side notice.
    } else {
      const codeWarn = report.report.warnings[report.report.warnings.length - 1];
      next = {
        ...next,
        code: {
          ...prior.code,
          latestRun: {
            ...prior.code.latestRun,
            meta: {
              ...prior.code.latestRun.meta,
              status: 'degraded',
              ...(codeWarn ? { warning: codeWarn } : {}),
            },
          },
        },
      };
    }
  }
  // A "rewrite" only counts when the next snapshot is not the same
  // object reference as the prior. `degradeWorkRun` returns the same
  // object when the status is already terminal; this check makes
  // `changed` faithful.
  const actuallyRewritten = next !== prior;
  return {
    results: actuallyRewritten ? next : prior,
    report: { ...report.report, changed: actuallyRewritten },
  };
}
