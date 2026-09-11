// Trylo Desktop — Work-surface lifecycle observer.
// TRYLO-DUAL-SURFACE-LEARNING-MATURITY-SPEC §2.1 / §2.2.
//
// Builds the single observer that the three Work send paths (`handleWorkSend`,
// the Impact resume `pendingAgentRunRef.start`, and Team Work dispatch) all
// share, so Work is a FIRST-CLASS task surface for Hermes, not a demo.
//
// Frozen composition order (spec §2.1):
//   onRunStarted:
//       Promise.all([workProjector.onRunStarted(toWorkArtifactScope(scope)),
//                    listAllowlistedOut(scope) /* parallel, ≤1000ms */])
//       → stash baseline (timeout/failure ⇒ []) BEFORE returning
//       → userLearningLifecycle.onRunStarted
//   onEvents:      userLearningLifecycle.onEvents
//                  (PR-2 optionally wires workProjector.onArtifact here)
//   onRunTerminal: workProjector.onRunTerminal(toWorkArtifactScope(scope))
//                  → collectWorkFileHints → stash fileHints
//                  → mirror → trigger → userLearningLifecycle
//
// The terminal side is fire-and-forget in the CodeRunController (`Promise.
// resolve(...).catch(() => {})` — no await, no race, no deadline), so serial
// execution there is safe (spec M1). The PARALLEL requirement is start-side
// only: the projector and the baseline listing must BOTH see the pre-run
// `.trylo/out`, and both must finish within the 3000ms `captureBaseline` race.
//
// NOTE (S1): PR-2 wires the real baseline listing + generation guard. PR-1
// ships this observer with an empty baseline/fileHints stash so the observer
// itself is testable without a scanner.

import type { CodeRunLifecycleObserver, CodeRunOutcome } from '../runtime/code-run-lifecycle';
import type { RuntimeResultScope } from '../results/result-scope';
import type { WorkResultProjector } from '../results/work-result-projector';
import type { WorkArtifactScope, WorkRunOutcome } from '@trylo/work';
import type { LoopEvent } from '../host-adapter/loop-events';

/** Map the Code run outcome to the Work projector's narrower outcome set.
 *  `exited` (a process-exit terminal) is not a shape the Work store knows, so
 *  it degrades to `failed` — never `completed` (spec R9: no result ⇒ no review). */
function toWorkOutcome(outcome: CodeRunOutcome): WorkRunOutcome {
  return outcome === 'exited' ? 'failed' : outcome;
}

/** Map the Code run scope to the Work artifact scope, IGNORING `scope.mode`
 *  — the controller writes `mode: 'code'` for every run (Work included), and
 *  `WorkArtifactScope` has no `mode` field. Never branch on `scope.mode`. */
export function toWorkArtifactScope(scope: RuntimeResultScope): WorkArtifactScope {
  return {
    projectKey: scope.projectKey,
    projectRoot: scope.projectRoot,
    conversationId: scope.conversationId,
    runId: scope.runId,
    turnId: scope.turnId || undefined,
    startedAt: scope.startedAt,
  };
}

export interface WorkLifecycleObserverDeps {
  /** The scoped Work result projector (App-owned singleton). */
  readonly workProjector: WorkResultProjector;
  /** The mirror observer REFERENCE — the SAME instance Code uses (Key
   *  Decision 2), so Work and Code share `learningMirrorRef`. */
  readonly mirror: CodeRunLifecycleObserver;
  /** The trigger observer REFERENCE — the SAME instance Code uses. */
  readonly trigger: CodeRunLifecycleObserver;
  /** The User Learning lifecycle observer (trace close / enrich). */
  readonly userLearning: CodeRunLifecycleObserver;
  /**
   * Bounded `.trylo/out` allowlisted baseline listing, run in PARALLEL with
   * the projector start so BOTH see the pre-run directory (spec §2.1). Must
   * settle ≤1000–1500ms. Absent ⇒ baseline `[]`.
   */
  readonly listBaseline?: (scope: RuntimeResultScope) => Promise<readonly string[]>;
  /** Persist the serialized baseline for a runId BEFORE `onRunStarted`
   *  returns. A late listing must never overwrite it. In this design the
   *  parallel listing is awaited (≤1500ms < the 3000ms `captureBaseline`
   *  race), so the late-write path cannot occur — the baseline is always
   *  stashed before `onRunStarted` resolves (addresses S1: the projector and
   *  the observer share one timing). */
  readonly stashBaseline?: (scope: RuntimeResultScope, paths: readonly string[]) => void;
  /**
   * Bounded `.trylo/out` allowlisted listing AFTER the projector terminal.
   * Terminal side is fire-and-forget so serial is safe (spec M1). Absent ⇒
   * terminal listing `[]` (fileHints then degrades to the snapshot delta).
   */
  readonly listAllowlistedOut?: (scope: RuntimeResultScope) => Promise<readonly string[]>;
  /**
   * Compute the fileHints for the finished run from (snapshot delta ∪
   * terminal listing − baseline). PR-2 wires `collectWorkFileHints`.
   */
  readonly collectFileHints?: (scope: RuntimeResultScope, terminalRelPaths: readonly string[]) => readonly string[];
  /** Persist the fileHints for a runId so the trigger can read them. */
  readonly stashFileHints?: (scope: RuntimeResultScope, paths: readonly string[]) => void;
  /** Optionally feed an artifact discovered from a tool summary into the
   *  projector (spec §2.2 可选): proves turn-2+ ownership so the collector can
   *  recognise genuinely new files (R14) without depending on the listing
   *  alone. fileHints still derives from the baseline diff, NOT this. */
  readonly onArtifact?: (scope: RuntimeResultScope, relativePath: string) => void;
}

export function createWorkLifecycleObserver(deps: WorkLifecycleObserverDeps): CodeRunLifecycleObserver {
  return {
    onRunStarted(scope) {
      // Start-side PARALLELISM is a hard requirement: the projector's own
      // `BASELINE_BUDGET_MS` scan and this listing must both observe the
      // pre-run directory, and neither may run serially after the other or
      // the 3000ms `captureBaseline` race is lost.
      const projectorP = Promise.resolve(deps.workProjector.onRunStarted(toWorkArtifactScope(scope)));
      const listingP = deps.listBaseline
        ? deps.listBaseline(scope).catch(() => [] as readonly string[])
        : Promise.resolve<readonly string[]>([]);
      const baselineP = listingP.then((paths) => {
        // Stash BEFORE return (contract §2.1 item 3): timeout/failure settles
        // the race too, degrading to `[]` rather than blocking the run.
        deps.stashBaseline?.(scope, paths);
        return paths;
      });
      return Promise.all([projectorP, baselineP]).then(() => {
        deps.userLearning.onRunStarted?.(scope);
      });
    },

    onEvents(scope, events) {
      deps.userLearning.onEvents?.(scope, events);
      if (deps.onArtifact) {
        for (const rel of extractOutArtifactPaths(events)) {
          try {
            deps.onArtifact(scope, rel);
          } catch {
            // Optional ownership enrichment must never break the run.
          }
        }
      }
    },

    async onRunTerminal(scope, outcome: CodeRunOutcome) {
      // Terminal side is fire-and-forget upstream, so serial ordering here is
      // safe and REQUIRED: the fileHints stash must exist before the trigger
      // reads it.
      await deps.workProjector.onRunTerminal(toWorkArtifactScope(scope), toWorkOutcome(outcome));
      // Terminal allowlisted listing AFTER the projector terminal (spec §2.2).
      const terminalPaths = deps.listAllowlistedOut
        ? await deps.listAllowlistedOut(scope).catch(() => [] as readonly string[])
        : [];
      const hints = deps.collectFileHints ? deps.collectFileHints(scope, terminalPaths) : [];
      deps.stashFileHints?.(scope, hints);
      // Mirror → trigger → user learning, in frozen order.
      await Promise.resolve(deps.mirror.onRunTerminal?.(scope, outcome));
      await Promise.resolve(deps.trigger.onRunTerminal?.(scope, outcome));
      await Promise.resolve(deps.userLearning.onRunTerminal?.(scope, outcome));
    },
  };
}

/**
 * Extract `.trylo/out/<relpath>` deliverable paths mentioned in a batch of
 * loop-event tool summaries (spec §2.2 可选 onEvents path). Only workspace-
 * relative deliverable-looking paths are returned; nothing else leaves the
 * event stream. Safe + cheap: a bounded regex over persisted summaries.
 *
 * Windows hardening (P2-4): tool summaries may carry backslash paths
 * (`D:\proj\.trylo\out\a.pptx` or relative `\.trylo\out\a.pptx`). The match
 * regex and the downstream validators (`isWorkDeliverablePath` /
 * `WorkArtifactStore.upsertEvent` → `isAllowlistedDeliverableRel`) all
 * normalise `\`→`/`, so the extractor normalises BEFORE matching — otherwise
 * every Windows summary is dropped here, `known` stays empty, and the
 * recovery (fail-closed) path of `collectWorkFileHints` becomes the Windows
 * default. Absolute drive prefixes are stripped after normalisation so the
 * result is the same workspace-relative form both consumers expect.
 */
export function extractOutArtifactPaths(events: readonly LoopEvent[]): readonly string[] {
  const out: string[] = [];
  for (const event of events) {
    const raw = typeof (event as { summary?: unknown }).summary === 'string'
      ? (event as { summary: string }).summary
      : String((event as { summary?: unknown }).summary ?? '');
    // Normalise separators BEFORE matching so `\.trylo\out\` matches too.
    const summary = raw.replace(/\\/g, '/');
    const matches = summary.match(/\.trylo\/out\/(?:[^\s"'\n]{1,180})/g) ?? [];
    for (const m of matches) {
      // Strip any absolute drive prefix (`D:/proj/.trylo/out/…` → `.trylo/out/…`)
      // so the extracted value is the workspace-relative identity the store
      // and the hint validators key on.
      const rel = m.slice(m.indexOf('.trylo/')).replace(/[",;)\]]+$/, '').trim();
      if (rel && !out.includes(rel)) out.push(rel);
    }
  }
  return out;
}