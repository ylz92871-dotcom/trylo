import { fields, sequence, text } from "../../../../../validation/json-shape.js";
import { canonicalJson, contentHashOf } from "../../../../control/hash.js";
import type { CentralLearningWorkResult } from "../../../../control/coordination-contract.js";
import { isCentralLearningWorkResult } from "../../../../control/coordination-parse.js";
import { coordinationForJob } from "../../../../control/coordination-state.js";
import type { BoardState } from "../../../../control/state.js";
import type { SkillControlResult, SkillCoordinationOptions } from "./contracts.js";

const VERSION = "hermes-confirmed-review-outcome/v1";

export type SkillReviewOutcome = {
  readonly schemaVersion: 1;
  readonly scope: string; readonly issueId: string; readonly jobId: string; readonly grantId: string;
  readonly claimId: string; readonly attempt: number; readonly focusRevision: number;
  readonly reservationIds: readonly string[];
  readonly result: CentralLearningWorkResult;
};

const scopeRef = (scope: string) => `hermes-review-outcomes:${contentHashOf(scope)}`;
const outcomeId = (value: Omit<SkillReviewOutcome, "result">) => `hermes-review-outcome:${contentHashOf(value)}`;
const valid = (value: unknown): value is SkillReviewOutcome => fields(value,
  ["schemaVersion", "scope", "issueId", "jobId", "grantId", "claimId", "attempt", "focusRevision", "reservationIds", "result"])
  && value.schemaVersion === 1 && [value.scope, value.issueId, value.jobId, value.grantId, value.claimId].every(item => text(item, 512))
  && sequence(value.attempt) && value.attempt > 0 && sequence(value.focusRevision) && value.focusRevision > 0
  && Array.isArray(value.reservationIds) && value.reservationIds.length <= 64 && value.reservationIds.every(item => text(item, 512))
  && new Set(value.reservationIds).size === value.reservationIds.length && isCentralLearningWorkResult(value.result);
const binding = (value: SkillReviewOutcome) => {
  const { result: _result, ...identity } = value;
  return identity;
};

/** The native review adapter has already validated pending IDs/action/target.
 * Persist that exact returned result before terminal coordination; this is not a
 * pending-set scan, approval, instruction asset or a second usage ledger. */
export async function recordSkillReviewOutcome(options: SkillCoordinationOptions, input: {
  readonly jobId: string; readonly grantId: string; readonly claimId: string; readonly result: CentralLearningWorkResult;
}): Promise<SkillControlResult<{ readonly outcomeRef: string }>> {
  try {
    let expectedBinding: string | undefined;
    for (;;) {
      const loaded = await options.board.load();
      if (!loaded.ok) return { ok: false, reason: loaded.reason };

      const current = coordinationForJob(loaded.state, input.jobId);
      if (current === undefined || current.issue.scope !== options.scope || current.grant.scope !== options.scope
        || current.grant.domain !== "skill" || current.grant.grantId !== input.grantId || current.grant.status !== "open"
        || current.job.state !== "running" || current.grant.claim?.claimId !== input.claimId
        || current.issue.decision.kind !== "focused_learning" || current.grant.focusRevision !== current.issue.decision.revision) {
        return { ok: false, reason: "hermes_review_outcome_binding" };
      }

      const outcome: SkillReviewOutcome = { schemaVersion: 1, scope: options.scope, issueId: current.issue.issueId,
        jobId: current.job.jobId, grantId: input.grantId, claimId: input.claimId, attempt: current.job.attempt,
        focusRevision: current.grant.focusRevision, reservationIds: current.grant.reservations.map(item => item.reservationId), result: input.result };
      if (!valid(outcome)) return { ok: false, reason: "hermes_review_outcome_invalid" };

      const identity = canonicalJson(binding(outcome));
      if (expectedBinding !== undefined && expectedBinding !== identity) return { ok: false, reason: "hermes_review_outcome_binding" };
      expectedBinding = identity;

      const id = outcomeId(binding(outcome)), payloadJson = canonicalJson(outcome);
      const previous = loaded.state.rewardV2Facts?.find(fact => fact.id === id);
      if (previous !== undefined) return previous.algorithmVersion === VERSION && previous.scope === scopeRef(options.scope)
        && previous.kind === "projection" && previous.payloadJson === payloadJson ? { ok: true, outcomeRef: id }
        : { ok: false, reason: "hermes_review_outcome_conflict" };

      const written = await options.board.apply({ type: "record_reward_v2_fact", commandId: `record:${id}`, issuedAt: options.now(),
        expectedSequence: loaded.state.sequence, fact: { id, scope: scopeRef(options.scope), algorithmVersion: VERSION,
          kind: "projection", payloadJson } });

      if (written.ok) return { ok: true, outcomeRef: id };
      if (written.reason !== "reward_v2_stale") return { ok: false, reason: written.reason };
      // This reducer refusal wrote nothing. Re-read the same claim and exact
      // reservation binding; unrelated domains may advance the global sequence.
      // Unknown writes and owner changes never enter this continuation.
    }
  } catch { return { ok: false, reason: "board_unavailable" }; }
}

/** Only the immutable result of this exact expired claim may finish locally. */
export function readSkillReviewOutcome(state: BoardState, expected: Omit<SkillReviewOutcome, "result">): SkillControlResult<{
  readonly outcomeRef?: string; readonly outcome?: SkillReviewOutcome;
}> {
  const candidates = [...(state.rewardV2Facts ?? [])].reverse().filter(item => item.algorithmVersion === VERSION && item.scope === scopeRef(expected.scope));

  for (const fact of candidates) {
    let value: unknown;

    try { value = JSON.parse(fact.payloadJson); }
    catch { return { ok: false, reason: "hermes_review_outcome_corrupt" }; }

    if (!valid(value) || fact.id !== outcomeId(binding(value)) || fact.kind !== "projection" || canonicalJson(value) !== fact.payloadJson) {
      return { ok: false, reason: "hermes_review_outcome_corrupt" };
    }

    if (value.scope !== expected.scope || value.issueId !== expected.issueId || value.jobId !== expected.jobId
      || value.grantId !== expected.grantId || value.focusRevision !== expected.focusRevision) continue;

    // A crash can interrupt local reclaim before finish. Earlier confirmed
    // results still apply only when no intervening provider reservation exists.
    if (canonicalJson(value.reservationIds) !== canonicalJson(expected.reservationIds) || value.attempt > expected.attempt) continue;

    if (value.attempt === expected.attempt && value.claimId !== expected.claimId) return { ok: false, reason: "hermes_review_outcome_corrupt" };

    return { ok: true, outcomeRef: fact.id, outcome: value };
  }

  return { ok: true };
}
