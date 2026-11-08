import { fields, sequence } from "../../../validation/json-shape.js";
import { isAllocationBasis } from "../allocation-shape.js";
import { isCentralLearningAllowance } from "../coordination-parse.js";
import { SEQUENTIAL_ALLOCATION_LIMITS } from "../sequential-allocation-contract.js";
import { isCentralDecisionStageSource } from "./stage-projection.js";
import type { CentralPursuitInput } from "./pursuit-contract.js";

function compatibleOutcomeSupport(target: CentralPursuitInput["candidates"][number]["target"]): boolean {
  if (target?.kind !== "deadline" || target.grossSupport === undefined) return true;
  const support = target.grossSupport;
  // A binary objective has possible outcomes zero and one. A narrow interval
  // around its mean cannot certify an upper bound for a missed-deadline family.
  return support !== null && Number.isFinite(support.minimum) && Number.isFinite(support.maximum)
    && support.minimum <= 0 && support.maximum >= 1;
}

/** Prediction validates outcome/objective semantics; this boundary binds actual
 * executable stages, physical envelopes and the current canonical Board prefix. */
export function validCentralPursuitInput(input: CentralPursuitInput): boolean {
  if (!fields(input, ["schemaVersion", "board", "basis", "candidates", "observations", "horizon"])
    || input.schemaVersion !== 1 || !isAllocationBasis(input.basis)
    || input.basis.utilityUnit !== "qualified_objective_completions"
    || input.board === null || typeof input.board !== "object" || !sequence(input.board.sequence)
    || input.board.sequence !== input.basis.boardSequence || !Array.isArray(input.board.jobs)
    || !sequence(input.horizon) || input.horizon < 1 || input.horizon > SEQUENTIAL_ALLOCATION_LIMITS.horizon
    || !Array.isArray(input.candidates) || input.candidates.length > 30) return false;
  return input.candidates.every(candidate => isCentralDecisionStageSource(candidate?.source)
    && candidate.opportunity !== null && typeof candidate.opportunity === "object"
    && candidate.opportunity.instanceRef === candidate.source.domainStage.stageRef
    && candidate.opportunity.stage === candidate.source.domainStage.kind
    && candidate.opportunity.offer !== null && typeof candidate.opportunity.offer === "object"
    && candidate.opportunity.offer.owner?.plane === "agent"
    && candidate.opportunity.offer.policyRef === candidate.source.domainStage.policyRef
    && compatibleOutcomeSupport(candidate.target)
    && isCentralLearningAllowance({ schemaVersion: 2, unit: "total_model_tokens",
      maxTokens: candidate.opportunity.offer.reserve?.tokens, maxCalls: candidate.opportunity.offer.reserve?.calls,
      maxSteps: candidate.opportunity.offer.reserve?.steps, maxPromptChars: candidate.opportunity.offer.maxPromptChars }));
}
