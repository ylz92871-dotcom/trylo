import type { BoardState } from "../state.js";
import type { LearningAllocationBasis, LearningAllocationResources } from "../allocation-contract.js";
import type { SequentialAllocationPlan } from "../sequential-allocation-contract.js";
import type { CentralResponseOpportunity } from "./prediction-input.js";
import type { CentralDecisionStageSource, CentralDecisionStageProjection } from "./stage-projection.js";
import type { CentralTimingReadiness, CentralTimingTarget, CentralTimingFee, CentralTimingResult } from "./timing-contract.js";
import type { CentralPursuitResourceBelief } from "./pursuit-resource-model.js";

/** An explicit stage objective, not economic learning-effect utility. One instance
 * can be completed only once. Different qualification levels are never pooled. */
export type CentralPursuitObjective = {
  readonly instanceId: string;
  readonly criterion: "proposal_delivered" | "checker_verified" | "adopted";
  readonly definitionRef: string;
  /** Same semantic sampling/stop protocol; not an execution policy identity. */
  readonly familyRef: string;
  readonly familySourceRef: string;
  /** Optional source-declared model class for a stable semantic protocol whose
   * exact executable resource caps may affect its result probability. */
  readonly resourceModel?: { readonly kind: "shared_or_exact_treatment"; readonly sourceRef: string };
};

export type CentralPursuitCandidate = {
  readonly opportunity: CentralResponseOpportunity;
  readonly source: CentralDecisionStageSource;
  readonly readiness: CentralTimingReadiness;
  readonly target: CentralTimingTarget;
  readonly fee: CentralTimingFee;
  readonly purpose: "required_preparation" | "focused_learning";
  readonly objective: CentralPursuitObjective;
};

/** Effective source heads only. A completed provider call is not a qualified result.
 * A no-result label needs the original closed objective/observation boundary. */
export type CentralPursuitObservation = {
  readonly unitId: string;
  readonly scope: string;
  readonly conditionRef: string;
  readonly objective: CentralPursuitObjective;
  readonly grantId: string;
  readonly stageRef: string;
  readonly sourceRef: string;
  readonly revisionRef: string;
  readonly sequence: number;
  readonly outcome: "qualified" | "closed_no_result" | "pending";
  /** Frozen exact policy+resource envelope, never reconstructed from a later cap. */
  readonly treatmentRef?: string;
};

export type CentralPursuitInput = {
  readonly schemaVersion: 1;
  readonly board: BoardState;
  readonly basis: LearningAllocationBasis;
  readonly candidates: readonly CentralPursuitCandidate[];
  readonly observations: readonly CentralPursuitObservation[];
  /** Planning over the real, currently described backlog; never clone future stages. */
  readonly horizon: number;
};

export type CentralPursuitPrediction = {
  readonly opportunityId: string;
  readonly objective: CentralPursuitObjective;
  readonly model: "jeffreys_bernoulli_reference_v1" | "resource_model_average_v1";
  readonly interpretation: "declared_objective_completion_not_economic_gain";
  readonly qualified: number;
  readonly noResult: number;
  readonly pending: number;
  /** The shared Bernoulli component. resourceModel retains the separate-cap
   * component and model weights; a mixture is not itself claimed to be Beta. */
  readonly posteriorAlpha: number;
  readonly posteriorBeta: number;
  /** Reference-model prediction; not an observed fact or calibrated success claim. */
  readonly mean: number;
  readonly variance: number; // Parameter-rate uncertainty, not the binary outcome variance.
  /** Posterior-mean range over every completion of the pending labels, not a CI. */
  readonly pendingMeanRange: readonly [number, number];
  readonly support: "reference_prior" | "updated_reference_model";
  readonly sourceRefs: readonly string[];
  readonly resourceModel?: CentralPursuitResourceBelief;
};

export type CentralPursuitEvaluation = {
  readonly candidate: CentralPursuitCandidate;
  readonly stage: CentralDecisionStageProjection;
  readonly prediction: CentralPursuitPrediction;
  readonly timing: CentralTimingResult | null;
};

export type CentralPursuitNextStep = { readonly kind: "fund_and_dispatch" | "dispatch_existing";
  readonly evaluation: CentralPursuitEvaluation;
  readonly application: { readonly kind: "sequential"; readonly proposalJson: string } | null }
  | { readonly kind: "reconcile_then_replan"; readonly evaluation: CentralPursuitEvaluation }
  | { readonly kind: "defer"; readonly evaluation: CentralPursuitEvaluation }
  | { readonly kind: "end_investment"; readonly evaluation: CentralPursuitEvaluation; readonly reason: string }
  | { readonly kind: "wait"; readonly sourceRefs: readonly string[]; readonly reasons: readonly string[] }
  | { readonly kind: "stop" };

export type CentralPursuitResult = { readonly status: "rejected"; readonly reason: string }
  | { readonly status: "decided"; readonly decisionRef: string; readonly basis: LearningAllocationBasis;
    readonly objective: { readonly criterion: CentralPursuitObjective["criterion"]; readonly definitionRef: string;
      readonly unit: "qualified_objective_completions" } | null;
    readonly remaining: LearningAllocationResources; readonly evaluations: readonly CentralPursuitEvaluation[];
    readonly plan: SequentialAllocationPlan | null; readonly nextStep: CentralPursuitNextStep;
    readonly options: readonly { readonly kind: "new_backlog" | "covered_prefix" | "conditional_reconcile";
      readonly grantId: string | null; readonly value: number; readonly modelRefs: readonly string[] }[];
    readonly assumptions: readonly string[]; readonly replanOn: readonly string[] };
