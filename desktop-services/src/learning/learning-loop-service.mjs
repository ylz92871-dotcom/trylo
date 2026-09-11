// Trylo Desktop Services — learning loop adapter (Phase 3C).
// See migration spec §7.6 and architecture doc §6.5.
//
// Thin adapter over the vendored `learning-loop/orchestrator.js`: implicit
// review after a stable task turn, explicit /learn, run status, and history
// mining search. Every trigger decision (stability gate, cooldown, idempotency,
// single-flight) stays in the legacy orchestrator — none is re-implemented
// here (spec §7.6: 沿用老判断，不新增策略).
//
// Ownership: the legacy state file (<app-data>/Trylo/learning/state-v1.json)
// is Desktop-owned storage; Hermes owns the resulting proposals. The shadow
// CLI run is invisible to the user's conversation.
//
// Failure policy: a failed learning run is a diagnostic, never a user-visible
// failure and never a block on Code/Work (spec §7.6). `historySearch` degrades
// to `{ ok:false, error }`. Nothing here throws for "Hermes missing".

import { requireLegacyVendor } from './vendor-path.mjs';

/**
 * @param {{ storageRoot: string, memento: { get: Function, update: Function },
 *           shadow: object, log?: (m: string) => void,
 *           orchestrator?: object|null, mining?: object|null }} options
 *   `orchestrator` / `mining` are test seams only.
 */
export function createLearningLoopService({
  storageRoot,
  memento,
  shadow,
  log = null,
  orchestrator: injectedOrchestrator = null,
  mining: injectedMining = null,
} = {}) {
  let orchestrator = injectedOrchestrator;
  let mining = injectedMining;
  function legacy() {
    if (!orchestrator) orchestrator = requireLegacyVendor('learning-loop/orchestrator.js');
    if (!mining) mining = requireLegacyVendor('history-mining-client.js');
    return { orchestrator, mining };
  }

  /** The VS Code ExtensionContext shape the legacy code expects. */
  const context = { globalState: memento };

  function requireRoot() {
    if (!storageRoot) throw new Error('learning loop: storage root is not configured');
  }

  function baseParams(params) {
    return {
      context,
      globalStoragePath: storageRoot,
      // Desktop owns the trace sink: diagnostics only, never conversation
      // bodies (spec §11).
      logTrace: (message) => {
        if (log) log(String(message));
      },
      showNotification: null,
      config: params.config ?? {},
    };
  }

  return {
    /** Implicit review after a stable task turn (spec §7.6). */
    async reviewImplicit(params = {}) {
      requireRoot();
      const { orchestrator: legacyOrchestrator } = legacy();
      if (params.cli) shadow.configure(params.cli);
      const result = await legacyOrchestrator.runImplicitReview({
        ...baseParams(params),
        workspaceRoot: params.workspaceRoot ?? '',
        sessionId: params.sessionId ?? '',
        turnId: params.turnId ?? '',
        mode: params.mode ?? 'agent',
        resultText: params.resultText ?? '',
        taskGoal: params.taskGoal ?? '',
        interrupted: Boolean(params.interrupted),
        hasPendingReview: Boolean(params.hasPendingReview),
        events: Array.isArray(params.events) ? params.events : [],
        fileHints: Array.isArray(params.fileHints) ? params.fileHints : [],
        verification: Array.isArray(params.verification) ? params.verification : [],
        reviewResolution: params.reviewResolution ?? null,
        iterationsAlreadyApplied: Boolean(params.iterationsAlreadyApplied),
        runInShadow: (prompt) => shadow.run(prompt, { timeoutMs: params.timeoutMs }),
      });
      return { ok: true, ...(result ?? {}) };
    },

    /** Explicit /learn (spec §7.6). */
    async learnExplicit(params = {}) {
      requireRoot();
      const { orchestrator: legacyOrchestrator } = legacy();
      if (params.cli) shadow.configure(params.cli);
      const result = await legacyOrchestrator.runExplicitLearn({
        ...baseParams(params),
        workspaceRoot: params.workspaceRoot ?? '',
        sessionId: params.sessionId ?? '',
        turnId: params.turnId ?? '',
        mode: params.mode ?? 'agent',
        learnRequest: String(params.learnRequest ?? ''),
        agentRunning: Boolean(params.agentRunning),
        hasPendingReview: Boolean(params.hasPendingReview),
        events: Array.isArray(params.events) ? params.events : [],
        fileHints: Array.isArray(params.fileHints) ? params.fileHints : [],
        verification: Array.isArray(params.verification) ? params.verification : [],
        resultSummary: params.resultSummary ?? '',
        taskGoal: params.taskGoal ?? '',
        reviewResolution: params.reviewResolution ?? null,
        runInShadow: (prompt) => shadow.run(prompt, { timeoutMs: params.timeoutMs }),
      });
      return { ok: true, ...(result ?? {}) };
    },

    /** Active learning run (single-flight visibility for the UI). */
    runStatus(params = {}) {
      const { orchestrator: legacyOrchestrator } = legacy();
      const status = legacyOrchestrator.getActiveRunStatus(params.workspaceRoot ?? null);
      return { ok: true, active: Boolean(status), run: status ?? null };
    },

    /** History mining search (read-only; validated DTOs only). */
    async historySearch(params = {}) {
      requireRoot();
      const { mining: legacyMining } = legacy();
      const result = await legacyMining.runHistorySearch({
        queries: Array.isArray(params.queries) ? params.queries : [],
        limit: params.limit,
        globalStoragePath: storageRoot,
        timeoutMs: params.timeoutMs,
      });
      return result ?? { ok: false, error: 'history search returned no result' };
    },
  };
}
