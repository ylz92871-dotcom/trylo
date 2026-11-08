import type { LearningAllocationOffer } from "../../learning/control/allocation-contract.js";
import type { CentralLearningAgentDomain, CentralLearningAllowance, CentralLearningGrantAllowance } from "../../learning/control/coordination-contract.js";
import type { CentralDecisionStageSource } from "../../learning/control/decision/stage-projection.js";
import type { FocusedLearningDispatch } from "../../learning/control/focused-learning-port.js";
import type { CentralResponseContext } from "../learning-allocation/response-context.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { CentralLearningIntentDraft, CentralLearningOperation } from "../../learning/central/runtime/contracts.js";
import type { CentralLearningSourceContext } from "../../learning/control/source-context.js";

export interface CentralResearchSignal {
  readonly intentRef: string;
  readonly intent: CentralLearningIntentDraft;
  readonly operation: Extract<CentralLearningOperation, { kind: "dispatch" }>;
}

export type CentralResearchReception = { readonly status: "accepted"; readonly issueId: string; readonly sourceRefs: readonly string[] }
  | { readonly status: "waiting"; readonly reason: string; readonly sourceRefs: readonly string[] };

/** Original domain preparation chooses its real source and canonical policy at an
 * authorized envelope. Central never selects a private asset through an opaque ID. */
export type CentralStagePreparation =
  | { readonly status: "ready"; readonly stageRef: string; readonly policyRef: string;
      readonly offer: LearningAllocationOffer; readonly source: CentralDecisionStageSource;
      readonly authorizedAllowance: CentralLearningGrantAllowance;
      /** Exact public packet used to prepare this source, including its original fallback. */
      readonly sourceContext?: CentralLearningSourceContext;
      /** Stable original protocol/model family, distinct from the exact cap in
       * an executable policy. No pooling assumption is implied by this label. */
      readonly policyFamily?: { readonly ref: string; readonly sourceRef: string;
        readonly response: "shared_or_exact_treatment" };
      /** Actual reusable source conditions, excluding issue IDs, timestamps and
       * one-off prose hashes. Absent means the declared selected-population
       * stage model has no identified task-environment feature class. */
      readonly condition?: { readonly ref: string; readonly sourceRef: string; readonly features: JsonObject };
      /** Actual current selector/condition/baseline, when the source owner can
       * identify them. The Board registry supplies the numerical protocol. */
      readonly responseContext?: CentralResponseContext }
  | { readonly status: "unavailable" | "waiting" | "terminal"; readonly reason: string; readonly sourceRefs: readonly string[] };

export type CentralStagePreparationInput = { readonly issueId: string;
  /** Cumulative original managed-grant ceiling, never copied from a quote. */
  readonly authorizedAllowance: CentralLearningGrantAllowance;
  /** This dispatch's bounded envelope. Omitted only by the legacy path. */
  readonly operationAllowance?: CentralLearningAllowance };

export type CentralFundedStage = {
  readonly issueId: string;
  readonly grantId: string;
  /** Re-read after commit. Initial fund advances the issue revision. */
  readonly expectedIssueRevision: number;
  readonly stageRef: string;
  readonly policyRef: string;
  readonly sourceBindingRef: string;
  readonly offer: LearningAllocationOffer;
  /** Captured by the original prepare and frozen inside the existing stage receipt. */
  readonly sourceContext?: CentralLearningSourceContext;
};

/** Qualification is tied to the original source's delivered proposal receipt,
 * not a worker terminal status, economic gain, approval or later adoption. */
export type CentralStageObservation = {
  readonly outcome: "qualified" | "closed_no_result" | "pending";
  readonly resultRefs: readonly string[];
  readonly sourceRefs: readonly string[];
  readonly reason: string;
};

/** A domain adapter may declare that nomination has no available native source.
 * This carries diagnosis only, never Permission or a successful learning result.
 * Unknown exceptions and cancellation are not converted to this contract.
 */
export class CentralLearningNominationUnavailable extends Error {
  constructor(readonly domain: CentralLearningAgentDomain, readonly reason: string) {
    super(`central_learning_nomination_unavailable:${domain}:${reason}`);
  }
}

/** Each implementation reaches the original worker, consumes only this grant and
 * returns its real dispatch receipt. It cannot focus again or create a new purse. */
export type CentralLearningExecutionPort = {
  readonly domain: CentralLearningAgentDomain;
  /** The domain creates/binds its truthful native research source. No fake team,
   * task/version identity, grant or permission is supplied by central. */
  acceptResearch?(input: CentralResearchSignal, signal: AbortSignal): Promise<CentralResearchReception>;
  /** Report actual pending sources without focusing, funding or running a model.
   * Declared native source unavailability throws CentralLearningNominationUnavailable;
   * other exceptions remain failures at their original boundary. */
  nominate?(signal: AbortSignal): Promise<readonly string[]>;
  prepare(input: CentralStagePreparationInput, signal: AbortSignal): Promise<CentralStagePreparation>;
  dispatch(input: CentralFundedStage, signal: AbortSignal): Promise<FocusedLearningDispatch>;
  observe(input: CentralFundedStage, signal: AbortSignal): Promise<CentralStageObservation>;
};
