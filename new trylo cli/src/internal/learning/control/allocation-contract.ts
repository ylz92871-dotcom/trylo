import type { CentralLearningAgentDomain } from "./coordination-contract.js";
import type { CentralLearningResources } from "./central-budget-contract.js";

/** User Learning is a peer plane, never an Agent subsystem. */
export type LearningAllocationOwner = { readonly plane: "agent"; readonly domain: CentralLearningAgentDomain }
  | { readonly plane: "user" };

export type LearningAllocationResources = CentralLearningResources;

export type LearningAllocationBasis = {
  readonly scope: string;
  readonly boardSequence: number;
  readonly budgetId: string;
  readonly utilityUnit: string;
  /** External producer's source/version reference; the allocator never creates its value estimate. */
  readonly valuationRef: string;
};

/** Pure numerical proposals have no execution authority and never create money. */
export type LearningAllocationOffer = {
  readonly offerId: string;
  readonly owner: LearningAllocationOwner;
  readonly policyRef: string;
  readonly reserve: LearningAllocationResources;
  readonly maxPromptChars: number;
};
