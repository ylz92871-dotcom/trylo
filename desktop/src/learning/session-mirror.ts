// Trylo Desktop — Hermes session mirror hook (lifecycle wiring).
//
// Mirrors a committed Code conversation into the Hermes SessionDB so
// `session_search` can recall it (migration spec §7.4 / arch §6.4).
//
// Ownership: Desktop owns the conversation and decides WHEN to mirror (a run
// reached terminal); the projection is Desktop's job (session-projection.ts)
// and the index is Hermes'. The mirror is a rebuildable cache — losing it
// degrades recall, never correctness.
//
// Failure policy: the observer NEVER throws and never awaits the upload on
// the run's critical path. A mirror failure is a diagnostic, not a run
// failure: Code/Work must keep working with Hermes absent (spec §7.3).
// Detection anomalies are not retried here — the Service Host's per-session
// debounce and content-hash skip own that decision.

import type { CodeRunLifecycleObserver, CodeRunOutcome } from '../runtime/code-run-lifecycle';
import type { RuntimeResultScope } from '../results/result-scope';
import type { ConversationRecord } from '../host-adapter/conversation-history';
import type { FilePath } from '../host-adapter/types';
import type { LearningPort } from './learning-port';
import { isProjectableSession, projectSession } from './session-projection';

export interface LearningMirrorSource {
  readonly record: ConversationRecord;
  readonly workspacePath: FilePath;
  readonly model?: string;
}

export interface LearningMirrorDeps {
  /** Read lazily — the port is replaced once the Service Host is up. */
  readonly port: () => LearningPort | null;
  /** Resolve the conversation that just finished. Null ⇒ nothing to mirror
   *  (background run on a workspace the user already closed). */
  readonly resolve: (scope: RuntimeResultScope) => LearningMirrorSource | null;
  /** Diagnostic sink. Never receives conversation bodies (spec §11). */
  readonly log?: (message: string) => void;
  /** Optional gate, evaluated per-run BEFORE the mirror indexes a finished
   *  conversation. Return `false` to skip the mirror for this scope (e.g.
   *  the `hermesWorkLearning` flag is off for a Work turn). Absent ⇒ always
   *  allow. Never throws — a gate failure degrades to "allow". */
  readonly allowMirror?: (scope: RuntimeResultScope) => boolean;
}

export function createLearningMirrorObserver(deps: LearningMirrorDeps): CodeRunLifecycleObserver {
  return {
    onRunStarted() {
      // Nothing to do: the mirror indexes a COMPLETED turn, never a running
      // one, so the recalled content is always the final answer.
    },
    onEvents() {
      // Per-event mirroring would upload half-written turns.
    },
    async onRunTerminal(scope, outcome: CodeRunOutcome) {
      if (outcome !== 'completed') return;
      if (deps.allowMirror && !safeAllowMirror(deps.allowMirror, scope)) return;
      const port = deps.port();
      if (!port) return;
      let source: LearningMirrorSource | null = null;
      try {
        source = deps.resolve(scope);
      } catch (err) {
        deps.log?.(`session mirror: resolve failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (!source) return;

      try {
        const projection = projectSession({
          record: source.record,
          workspacePath: source.workspacePath,
          model: source.model,
        });
        // A conversation with no recallable turn (empty draft) is not worth
        // an upload — the mirror stays quiet.
        if (!isProjectableSession(projection)) return;
        const result = await port.syncSession(projection);
        if (!result.ok) {
          deps.log?.(`session mirror: ${result.error ?? 'sync failed'}`);
        }
      } catch (err) {
        // Never let the mirror poison the run lifecycle.
        deps.log?.(`session mirror: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

/** Gate the mirror defence-in-depth: a throwing gate must degrade to "allow"
 *  (the mirror is a rebuildable cache — losing it never breaks correctness). */
function safeAllowMirror(
  gate: (scope: RuntimeResultScope) => boolean,
  scope: RuntimeResultScope,
): boolean {
  try {
    return gate(scope);
  } catch {
    return true;
  }
}
