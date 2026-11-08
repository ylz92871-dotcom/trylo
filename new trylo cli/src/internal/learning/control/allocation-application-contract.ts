import type { LearningAllocationBasis, LearningAllocationOffer, LearningAllocationResources } from "./allocation-contract.js";
import type { CentralBudgetProjection } from "./central-budget-contract.js";
import type { CentralLearningGrantAllowance, CoordinateLearningCommand } from "./coordination-contract.js";

/** Prepared by the owning domain/host, never inferred from an estimated value. */
export type AllocationFundingBinding = {
  readonly offerId: string;
  readonly offerHash: string;
  readonly policyRef: string;
  readonly sourceBindingRef: string;
  /** Host/domain authorization ceiling for the lifetime grant, including prior charges.
   * This is separate from the value producer's requested stage reserve and is not execution Permission. */
  readonly authorizedAllowance: CentralLearningGrantAllowance;
  readonly issueId: string;
  readonly expectedIssueRevision: number;
  readonly grantId: string;
  readonly mode: "fund" | "extend";
  readonly chargedAtBasis: LearningAllocationResources;
};

export type AllocationApplicationInput = {
  readonly kind: "portfolio" | "sequential";
  readonly proposalJson: string;
  readonly bindingsJson: string;
  readonly authorizationRef: string;
};

export type AllocationProposal = {
  readonly planId: string;
  readonly requestHash: string;
  readonly basis: LearningAllocationBasis;
  readonly requestedBudget: LearningAllocationResources;
  readonly offers: readonly LearningAllocationOffer[];
  /** A model forecast, not an execution result or evidence of learning quality. */
  readonly forecast: { readonly kind: "separable_portfolio" | "finite_observable"; readonly netValue: number };
};

export type AllocationFundingDraft = Omit<CoordinateLearningCommand, "issuedAt">;

export type PreparedAllocationApplication = {
  readonly proposal: AllocationProposal;
  readonly bindings: readonly AllocationFundingBinding[];
  readonly drafts: readonly AllocationFundingDraft[];
  readonly auditPayload: string;
};

export type AllocationApplicationFailure = { readonly status: "rejected" | "stale"; readonly reason: string; readonly planId?: string };

export type AllocationApplicationResult = AllocationApplicationFailure
  | { readonly status: "disabled" | "cancelled" }
  | { readonly status: "idle"; readonly proposal: AllocationProposal }
  | { readonly status: "committed" | "previous"; readonly planId: string; readonly grantIds: readonly string[];
      readonly budget: CentralBudgetProjection; readonly boardSequence: number }
  | { readonly status: "partial" | "unconfirmed"; readonly planId?: string; readonly confirmedGrantIds: readonly string[];
      readonly decisionConfirmed: boolean; readonly reason: string; readonly commandId?: string };
