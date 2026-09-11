// Trylo Desktop — implicit learning trigger (lifecycle wiring).
// See migration spec §7.6 and architecture doc §6.5.
//
// Fires an implicit review after a Code run reaches terminal. Every trigger
// decision (stability gate, cooldown, idempotency, single-flight) lives in the
// legacy orchestrator behind `learning.reviewImplicit` — this hook only
// decides WHEN to call it and WHAT evidence to hand over.
//
// Ownership: Desktop owns the conversation, so Desktop decides what counts as
// evidence. Only the evidence capsule crosses the boundary: never the raw
// event log and never the user's literal prompt (arch §6.5).
//
// Failure policy: the review runs detached (`void`) and its failure is a
// diagnostic only. A learning run must never block or fail the user's task
// (spec §7.6: 失败只记 diagnostics，不阻断主功能).

import type { CodeRunLifecycleObserver, CodeRunOutcome } from '../runtime/code-run-lifecycle';
import type { RuntimeResultScope } from '../results/result-scope';
import type { LearningCliConfig, LearningConfig } from '../services-host/methods';
import type { LearningPort } from './learning-port';
import { projectSession } from './session-projection';
import { deriveReviewMode } from './work-hermes-policy';
import type { LearningMirrorSource } from './session-mirror';
import { savePendingOrigin, extractSkillNameFromTarget } from '../components/user-learning/pending-origin';

export interface LearningTriggerConfig {
  readonly enabled: boolean;
  readonly cli: LearningCliConfig;
  readonly learning?: LearningConfig;
}

export interface LearningTriggerDeps {
  /** Read lazily — the port is replaced once the Service Host is up. */
  readonly port: () => LearningPort | null;
  /** Resolve the conversation that just finished. */
  readonly resolve: (scope: { projectRoot: string; conversationId: string }) => LearningMirrorSource | null;
  /** Desktop settings for the shadow run, resolved for this run's workspace.
   *  Null ⇒ learning is off (no CLI configured). */
  readonly config: (scope: { projectRoot: string }) => LearningTriggerConfig | null;
  /** Diagnostic sink. Never receives conversation bodies (spec §11). */
  readonly log?: (message: string) => void;
  /**
   * Dual-plane gate. When false, this completed turn belongs to User Learning
   * (Cognition / pending Impact) and must not spawn a Hermes skill review.
   * Receives the finished scope so the gate reads THIS conversation's record —
   * not a global message ref (spec §2.3). Absent ⇒ always allow.
   */
  readonly allowReview?: (scope: RuntimeResultScope) => boolean;
  /**
   * The allowlisted `.trylo/out` deliverables collected for this run, read
   * from the shared stash at trigger time. Empty in PR-1 (the observer stashes
   * `[]`); PR-2 wires `collectWorkFileHints`. Absent ⇒ no file hints.
   */
  readonly fileHints?: (scope: RuntimeResultScope) => readonly string[];
  /** Diagnostics sink for the Work-surface wiring (spec §Observability). */
  readonly diagnostics?: import('./learning-diagnostics').LearningDiagnosticsSink;
}

export function createLearningTriggerObserver(deps: LearningTriggerDeps): CodeRunLifecycleObserver {
  return {
    onRunStarted() {
      // Reviews run AFTER a turn finishes — never before.
    },
    onEvents() {
      // Per-event triggering would review half-written turns.
    },
    onRunTerminal(scope, outcome: CodeRunOutcome) {
      // Only a COMPLETED turn is evidence. A cancelled or failed run is not a
      // "stable task turn" — the orchestrator would skip it anyway, so we do
      // not even spend a request on it.
      if (outcome !== 'completed') return;
      if (deps.allowReview && !safeAllowReview(deps.allowReview, scope)) {
        deps.log?.(`learning trigger: review skipped`);
        deps.diagnostics?.record({ type: 'learning.work_review_skipped', reasonCode: 'gated' });
        return;
      }

      const config = deps.config(scope);
      if (!config || !config.enabled || !config.cli?.cliPath) return;
      const port = deps.port();
      if (!port) return;

      let source: LearningMirrorSource | null = null;
      try {
        source = deps.resolve(scope);
      } catch (err) {
        deps.log?.(`learning trigger: resolve failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (!source) return;

      const projection = projectSession({
        record: source.record,
        workspacePath: source.workspacePath,
        model: source.model,
      });
      // The last turn that actually produced an answer is the evidence.
      const turn = [...projection.turns].reverse().find((candidate) => candidate.resultText.trim().length > 0);
      if (!turn) return;

      // Derive the review mode from the record (Work → 'office'), never by
      // hardcoding 'agent' (spec §2.3).
      const mode = deriveReviewMode(source.record);
      // The allowlisted `.trylo/out` deliverables for this run, read from the
      // shared stash. Empty in PR-1; PR-2 wires `collectWorkFileHints`.
      const fileHints = deps.fileHints ? deps.fileHints(scope) : [];
      // PR-6 copyPlan context — captured to consts so the async closure below
      // keeps its narrowing (`source` is a reassigned `let`).
      const wsPath = source.workspacePath;
      const sessionId = projection.id;
      const turnId = scope.turnId ?? '';

      // Detached on purpose: the review spawns its own CLI turn and can take
      // minutes. Awaiting it here would hold the run's terminal hook open.
      void port
        .reviewImplicit({
          workspaceRoot: wsPath,
          sessionId,
          turnId,
          mode,
          resultText: turn.resultText,
          taskGoal: turn.prompt,
          interrupted: false,
          // Only bounded summaries from persisted tool cards cross the
          // boundary. Input/output bodies never do; the orchestrator applies
          // the evidence-capsule allowlist and limits once more.
          events: turn.events ?? [],
          fileHints,
          config: config.learning ?? {},
          cli: config.cli,
        })
        .then((result) => {
          deps.diagnostics?.record({
            type: 'learning.work_review_triggered',
            product: mode === 'office' ? 'work' : 'code',
            reasonCode: result.reasonCode,
          });
          // PR-6 (§2.8): when the review staged a pending Skill and this turn
          // produced `.trylo/out` deliverables, write the copyPlan into the
          // pending-origin map (sourceRel + skillName from the pending target).
          // The apply-time copy reads this map — never re-scans `.trylo/out`.
          if (result.pendingId && fileHints.length > 0) {
            const firstHint = fileHints[0];
            if (firstHint) {
              void writePendingOriginCopyPlan(port, {
                pendingId: result.pendingId,
                sourceRel: firstHint,
                workspaceRoot: wsPath,
                turnId,
                sessionId,
              }).catch(() => undefined);
            }
          }
        })
        .catch((err: unknown) => {
          deps.log?.(`learning trigger: ${err instanceof Error ? err.message : String(err)}`);
        });
    },
  };
}

/** Gate the review defence-in-depth: a throwing gate must degrade to "allow"
 *  so a bad predicate can never silently skip a legitimate review. */
function safeAllowReview(
  gate: (scope: RuntimeResultScope) => boolean,
  scope: RuntimeResultScope,
): boolean {
  try {
    return gate(scope);
  } catch {
    return true;
  }
}

/**
 * PR-6 (§2.8): write the copyPlan for a staged pending Skill into the
 * pending-origin map. The `skillName` comes from the pending target —
 * obtained via `pendingDetail` — never from the opaque apply result.
 * No `skillName` in the target → entry still written WITHOUT skillName, so
 * the apply-time copy skips (Skill text still applies).
 */
async function writePendingOriginCopyPlan(
  port: LearningPort,
  input: {
    readonly pendingId: string;
    readonly sourceRel: string;
    readonly workspaceRoot: string;
    readonly turnId: string;
    readonly sessionId: string;
  },
): Promise<void> {
  let skillName: string | undefined;
  try {
    const detail = await port.pendingDetail({ subsystem: 'skills', id: input.pendingId });
    if (detail.ok && detail.detail) {
      const target = detail.detail.target ?? detail.detail.item ?? detail.detail.pending ?? detail.detail.payload;
      skillName = extractSkillNameFromTarget(target);
    }
  } catch {
    // No skillName → the apply-time copy skips (spec §5 rule 7).
  }
  savePendingOrigin(input.pendingId, {
    origin: 'skill-review',
    label: input.sourceRel.split('/').pop() ?? input.sourceRel,
    sourceRel: input.sourceRel,
    ...(skillName ? { skillName } : {}),
    workspaceRoot: input.workspaceRoot,
    sessionId: input.sessionId,
    turnId: input.turnId,
    createdAt: Date.now(),
  });
}
