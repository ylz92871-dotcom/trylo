import type { BoardState } from "../state.js";
import type { LearningAllocationResources } from "../allocation-contract.js";
import type { SequentialAllocationPlan } from "../sequential-allocation-contract.js";
import type { CentralResponseForecast, CentralResponseForecastInput, CentralResponseForecastQuery } from "./prediction-input.js";
import type { CentralTimingFee, CentralTimingReadiness, CentralTimingResult, CentralTimingTarget } from "./timing-contract.js";
import type { CentralDecisionStageInput, CentralDecisionStageProjection } from "./stage-projection.js";

export type CentralDecisionCandidate = {
  readonly opportunityId: string;
  /** The domain's actual macro-stage identity; domainStage.stageRef must equal the
   * forecast opportunity's instanceRef. Never a fabricated model-call checkpoint. */
  readonly source: Omit<CentralDecisionStageInput, "board" | "scope" | "budgetId" | "offer">;
  /** Business calendar/usage declarations are separate from the canonical worker state. */
  readonly readiness: CentralTimingReadiness;
  readonly target: CentralTimingTarget;
  readonly fee: CentralTimingFee;
};

export type CentralDecisionInput = {
  readonly schemaVersion: 1;
  /** Already decoded by the canonical Board store. This module never reads/writes storage. */
  readonly board: BoardState;
  readonly prediction: CentralResponseForecastInput;
  readonly candidates: readonly CentralDecisionCandidate[];
};

export type CentralDecisionEvaluation = {
  readonly opportunityId: string;
  readonly query: CentralResponseForecastQuery | null;
  readonly stage: CentralDecisionStageProjection;
  readonly timing: CentralTimingResult | null;
};

export type CentralDecisionRequirement = {
  readonly opportunityId: string;
  readonly reason: string;
  readonly sourceRefs: readonly string[];
};

export type CentralDecisionResult =
  | { readonly status: "rejected"; readonly reason: string }
  | { readonly status: "decided"; readonly decisionRef: string;
      readonly forecast: CentralResponseForecast;
      readonly remaining: LearningAllocationResources;
      readonly evaluations: readonly CentralDecisionEvaluation[];
      readonly requirements: readonly CentralDecisionRequirement[];
      readonly plan: SequentialAllocationPlan;
      readonly recommendation: "now" | "defer" | "stop" | "wait_evidence" | "in_flight" | "reconcile_then_replan";
      readonly selected: CentralDecisionEvaluation | null;
      /** Present only for a current, source-ready stage. Still requires the original
       * host's authorization binding, live CAS and exact domain dispatch. */
      readonly application: { readonly kind: "sequential"; readonly proposalJson: string } | null;
      readonly scope: "one_macro_stage_then_reobserve";
      readonly replanOn: readonly string[] };
