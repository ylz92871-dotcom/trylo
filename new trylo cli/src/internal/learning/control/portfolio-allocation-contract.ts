import type { LearningAllocationBasis, LearningAllocationOffer, LearningAllocationOwner, LearningAllocationResources } from "./allocation-contract.js";

export const PORTFOLIO_LIMITS = { jsonChars: 65_536, groups: 6, tiers: 6, transitions: 140_000,
  utilityMagnitude: 2, tolerance: 1e-12 } as const;

export type LearningPortfolioTier = {
  readonly quota: number;
  /** External expected NET utility; nonmonotone and negative values are permitted. */
  readonly netValue: number;
  readonly offer: LearningAllocationOffer;
};

export type LearningPortfolioGroup = { readonly owner: LearningAllocationOwner; readonly tiers: readonly LearningPortfolioTier[] };

export type LearningPortfolioRequest = {
  readonly schemaVersion: 1;
  readonly basis: LearningAllocationBasis;
  readonly unit: "total_model_tokens";
  /** Host assertion of additive utility; shape validation does not establish separability. */
  readonly domainRelation: "separable";
  readonly budget: LearningAllocationResources;
  readonly groups: readonly LearningPortfolioGroup[];
  /** Optional fast-path candidate; pointwise equality is proved before reuse, otherwise the vector path applies. */
  readonly commonQuantum?: LearningAllocationResources;
};

export type LearningPortfolioPlan = {
  readonly schemaVersion: 1;
  readonly basis: LearningAllocationBasis;
  readonly mode: "vector_exact_cost" | "legacy_common_quantum";
  readonly used: LearningAllocationResources;
  readonly netValue: number;
  /** Global raw-max minus the selected plan for vector mode; null for the uninstrumented legacy result. */
  readonly terminalValueGap: number | null;
  /** Comparison loss allowance only; input estimation and IEEE arithmetic errors are separate. */
  readonly comparisonToleranceBound: number;
  readonly allocations: readonly { readonly owner: LearningAllocationOwner; readonly quota: number;
    readonly offer: LearningAllocationOffer | null }[];
};

export type LearningPortfolioWork = { readonly kind: "counted_candidate_transitions" | "legacy_transition_upper_bound"; readonly count: number };

export type LearningPortfolioResult = { readonly status: "invalid"; readonly reason: "portfolio_input_invalid" | "portfolio_planning_budget" }
  | { readonly status: "planning_limit"; readonly work: LearningPortfolioWork }
  | { readonly status: "allocated"; readonly plan: LearningPortfolioPlan; readonly work: LearningPortfolioWork };
