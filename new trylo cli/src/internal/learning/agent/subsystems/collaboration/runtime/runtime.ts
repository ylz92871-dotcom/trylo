import { contentHashOf, sha256Hex } from "../../../../control/hash.js";
import type { createCollaborationLearning } from "../domain/index.js";
import type { CollaborationContext, CollaborationFact, CollaborationSelection, CollaborationResult } from "../domain/contracts.js";
import type { CollaborationRound, SubagentCollaborationPort } from "../../../../../subagent/collaboration.js";

type Learning = ReturnType<typeof createCollaborationLearning>;

type Prepared = { readonly selection: CollaborationSelection; readonly context: CollaborationContext;
  readonly round: CollaborationRound; fieldingId?: string };

type RuntimeOptions = {
  readonly learning: Learning;
  readonly scope: string;
  readonly now: () => string;
  readonly enabled: () => boolean;
  readonly warn: (reason: string) => void;
  readonly maxPromptChars?: number;
};

const SELECTION_SKIPS = new Set(["dependency_not_applicable", "no_applicable_practice", "explicit_correction",
  "negative_feedback", "prompt_budget_exceeded", "collect_disabled"]);

function contextFor(scope: string, round: CollaborationRound): CollaborationContext {
  return { scope, teamRunId: round.teamRunId, taskId: round.taskId, memberId: round.memberId,
    role: round.role, round: round.round,
    // Only a declared prerequisite or canonical handoff establishes cooperation.
    // Role names and a model's wording cannot turn independent work into a dependency.
    dependency: round.dependencies.length > 0 || round.handoff !== undefined ? "artifact" : "independent" };
}

function roundId(round: Pick<CollaborationRound, "teamRunId" | "taskId" | "memberId" | "round">): string {
  return contentHashOf([round.teamRunId, round.taskId, round.memberId, round.round]);
}

/** Bounded request advice and observations; analysis is invoked independently, never by this execution hook. */
export function createCollaborationRuntime(options: RuntimeOptions): SubagentCollaborationPort {
  const prepared = new Map<string, Prepared>();
  let warned = false;
  const warn = (reason: string): void => {
    if (warned) return;
    warned = true;
    options.warn(`collaboration_learning_degraded:${reason}`);
  };
  const record = async (fact: CollaborationFact): Promise<boolean> => {
    const result = await options.learning.record(fact);
    if (!result.ok) warn(result.reason);
    return result.ok;
  };
  const observe = async (round: CollaborationRound, result: CollaborationResult, item?: Prepared): Promise<void> => {
    const key = roundId(round), context = item?.context ?? contextFor(options.scope, round);

    await record({ schemaVersion: 1, kind: "episode", factId: `collab-episode-${contentHashOf([options.scope, key])}`,
      scope: options.scope, recordedAt: options.now(), context,
      assignmentRef: `assignment-sha256:${sha256Hex(round.assignment)}`,
      ...(round.handoff === undefined ? {} : { handoff: round.handoff }), result });

    if (item?.fieldingId !== undefined) await record({ schemaVersion: 1, kind: "outcome",
      factId: `collab-outcome-${contentHashOf([options.scope, key])}`, scope: options.scope,
      recordedAt: options.now(), fieldingId: item.fieldingId, result });
  };

  return {
    async prepare(round, signal) {
      if (!options.enabled() || signal.aborted) return undefined;

      const key = roundId(round), context = contextFor(options.scope, round);

      try {
        const selection = await options.learning.prepare(context, options.maxPromptChars ?? 1200);
        if (!options.enabled() || signal.aborted) return undefined;
        if (selection.kind === "skip" && !SELECTION_SKIPS.has(selection.reason)) warn(selection.reason);
        if (prepared.size >= 64) {
          warn("pending_round_capacity");
          return undefined;
        }
        prepared.set(key, { selection, context, round });
        return selection.kind === "selected" ? selection.guidance : undefined;
      } catch {
        // Learning failures degrade this optional boundary; execution retains its own error/status contract.
        warn("prepare_unavailable");
        return undefined;
      }
    },
    async dispatched(round, requestId, guidance) {
      const item = prepared.get(roundId(round));
      if (!options.enabled() || item?.selection.kind !== "selected" || guidance !== item.selection.guidance) return;

      const { selection, context } = item;
      const factId = `collab-fielding-${contentHashOf([options.scope, roundId(round), requestId])}`;

      try {
        const written = await record({ schemaVersion: 1, kind: "fielding", factId, scope: options.scope,
          recordedAt: options.now(), context, versionId: selection.versionId, proposalId: selection.proposalId,
          requestId, correctionIds: selection.correctionIds });
        if (written) item.fieldingId = factId;
      } catch {
        // No receipt is claimed if the Board rejected or could not persist dispatch.
        warn("fielding_unavailable");
      }
    },
    async completed(round, output) {
      const key = roundId(round), item = prepared.get(key);

      prepared.delete(key);

      if (!options.enabled() || item === undefined) return;

      const result: CollaborationResult = { status: "completed", check: "unverified", reworkCount: 0,
        missingFields: [], capability: "unknown", source: "member_report", evidenceRefs: [`output-sha256:${sha256Hex(output)}`] };

      try {
        await observe(round, result, item);
      } catch {
        // Member completion never becomes a false learning success when persistence fails.
        warn("observation_unavailable");
      }
    },
    async ended(identity, status, errorCode) {
      const key = roundId(identity), item = prepared.get(key);

      prepared.delete(key);

      // A completed round already published its observation. Idle cancellation cannot rewrite it.
      if (item === undefined || !options.enabled()) return;

      const result: CollaborationResult = { status: status === "cancelled" ? "cancelled"
        : status === "failed" || status === "timed_out" ? "failed" : "unknown",
      check: "unverified", reworkCount: 0, missingFields: [], capability: "unknown", source: "member_report",
      evidenceRefs: [`runtime-status:${status}`, ...(errorCode === undefined ? [] : [`runtime-error:${errorCode}`])] };

      try { await observe(item.round, result, item); }
      catch {
        // Terminal state comes from Runtime. Learning persistence cannot change it.
        warn("terminal_observation_unavailable");
      }
    },
  };
}
