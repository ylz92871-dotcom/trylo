import type { CentralPursuitCandidate, CentralPursuitEvaluation, CentralPursuitInput,
  CentralPursuitResult } from "../../learning/control/decision/pursuit-contract.js";
import type { CentralDecisionResult } from "../../learning/control/decision/decision-contract.js";
import type { LearningAllocationBasis } from "../../learning/control/allocation-contract.js";
import type { CentralTimingTarget, CentralTimingFee } from "../../learning/control/decision/timing-contract.js";
import type { CentralResponseDiscoveryBinding, CentralResponseDiscoveryResult } from "./response-discovery.js";
import type { CentralResponseContextBinding } from "./response-context.js";
import type { CentralEconomicNegativeEvidence, CentralConditionalResponseDiagnostic } from "./economic-evidence.js";

/** The source confirms the economic estimand/baseline and the physical timing
 * context for the actual stage. It supplies no numerical posterior or best Q. */
export type CentralEconomicStageBinding = CentralResponseDiscoveryBinding & {
  readonly timingTarget?: CentralTimingTarget;
  readonly fee?: CentralTimingFee;
};

export type CentralLearningEvidenceInput = Omit<CentralPursuitInput, "observations"> & {
  readonly valueBindings?: readonly CentralEconomicStageBinding[];
  readonly responseContexts?: readonly CentralResponseContextBinding[];
};

/** Dispatch needs source identity and physical feasibility; valuation details
 * retain their separate economic/declared-objective units in the parent result. */
export type CentralLearningDispatchEvaluation = Pick<CentralPursuitEvaluation, "candidate" | "stage" | "timing">;

export type CentralLearningDispatchStep = { readonly kind: "fund_and_dispatch" | "dispatch_existing";
  readonly evaluation: CentralLearningDispatchEvaluation;
  readonly application: { readonly kind: "sequential"; readonly proposalJson: string } | null }
  | { readonly kind: "reconcile_then_replan" | "defer"; readonly evaluation: CentralLearningDispatchEvaluation }
  | { readonly kind: "end_investment"; readonly evaluation: CentralLearningDispatchEvaluation; readonly reason: string }
  | { readonly kind: "wait"; readonly sourceRefs: readonly string[]; readonly reasons: readonly string[] }
  | { readonly kind: "stop" };

export type CentralLearningDispatchDecision = { readonly status: "decided"; readonly decisionRef: string;
  readonly basis: LearningAllocationBasis; readonly nextStep: CentralLearningDispatchStep };

type ValuedDecision = Extract<CentralDecisionResult, { status: "decided" }>;

type PursuitDecision = Extract<CentralPursuitResult, { status: "decided" }>;

export type CentralLearningEvidenceResult = { readonly status: "rejected"; readonly reason: string }
  | CentralLearningDispatchDecision & { readonly mode: "economic_response"; readonly valuation: ValuedDecision;
      readonly discovery: Extract<CentralResponseDiscoveryResult, { status: "ready" }>; readonly sourceRefs: readonly string[];
      readonly conditionalResponses: readonly CentralConditionalResponseDiagnostic[] }
  | CentralLearningDispatchDecision & { readonly mode: "stage_objective_pursuit"; readonly valuation: PursuitDecision;
      readonly discovery: Extract<CentralResponseDiscoveryResult, { status: "ready" }>; readonly reasons: readonly string[];
      readonly sourceRefs: readonly string[]; readonly economicConstraints: readonly CentralEconomicNegativeEvidence[];
      readonly conditionalResponses: readonly CentralConditionalResponseDiagnostic[] };

export type CentralEconomicCandidateInput = { readonly original: CentralPursuitCandidate;
  readonly binding: CentralEconomicStageBinding | undefined };
