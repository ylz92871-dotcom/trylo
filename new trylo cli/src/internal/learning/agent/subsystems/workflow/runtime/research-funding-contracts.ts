import type { CentralLearningAllowance, CentralLearningClaim, CentralLearningRemaining } from "../../../../control/coordination-contract.js";
import type { WorkflowLearningResult } from "../domain/trace-contracts.js";
import type { WorkflowImprovementFunding, WorkflowImprovementReservation } from "./improvement-contracts.js";

/** A projection of the original grant; attempted steps are never a second spending ledger. */
export type WorkflowResearchFundingSnapshot = {
  readonly remaining: CentralLearningRemaining;
  readonly maxPromptChars: number;
  readonly state: "queued" | "running";
  /** Expired claims remain visible until the original Board performs takeover. */
  readonly activeClaim?: CentralLearningClaim;
  readonly attemptedStepIds: readonly string[];
  readonly unknownStepIds: readonly string[];
};

export type WorkflowResearchClaim = WorkflowImprovementFunding & { readonly claimId: string; readonly expectedIssueRevision?: number };

/** An execution envelope over the original cumulative grant, never new funds. */
export type WorkflowResearchStageBinding = {
  readonly chargedAtStart: CentralLearningRemaining;
  readonly allowance: CentralLearningAllowance;
};

export type WorkflowResearchBinding = { readonly grantId: string; readonly inputVersionId: string;
  readonly expectedIssueRevision?: number; readonly stage?: WorkflowResearchStageBinding };

export type WorkflowResearchFundingPort = {
  inspect(funding: WorkflowImprovementFunding): Promise<WorkflowLearningResult<WorkflowResearchFundingSnapshot>>;
  /** Acquire only local publication/checkpoint ownership. This neither reserves nor spends. */
  claim(funding: WorkflowImprovementFunding): Promise<WorkflowLearningResult<WorkflowResearchClaim>>;
  /** A stable step ID may be reserved once, including after unknown delivery or restart. */
  reserve(funding: WorkflowImprovementFunding, input: { readonly stepId: string; readonly maxTokens?: number }):
    Promise<WorkflowLearningResult<WorkflowImprovementReservation>>;
};
