import type { LearningAllocationBasis, LearningAllocationOffer, LearningAllocationOwner, LearningAllocationResources } from "./allocation-contract.js";
import type { LearningPortfolioRequest } from "./portfolio-allocation-contract.js";
import type { TopicBudgetBid } from "./topic-bid.js";

export type TopicPortfolioEnvelopeEntry = { readonly quota: 0; readonly kind: "idle" }
  | { readonly quota: number; readonly kind: "funded"; readonly offer: LearningAllocationOffer; readonly envelopeHash: string };

/** Producer asserts each quote point describes this exact local policy under its actual envelope. */
export type TopicPortfolioSidecar = {
  readonly schemaVersion: 1;
  readonly domain: TopicBudgetBid["domain"];
  readonly owner: LearningAllocationOwner;
  readonly valuationId: string;
  readonly bidHash: string;
  readonly scope: string;
  readonly boardSequence: number;
  readonly evidenceWindowHash: string;
  readonly utilityUnit: string;
  readonly quotaUnit: string;
  readonly tokenAccountingUnit: "total_model_tokens";
  readonly policySemantics: "declared_quota_policy_equivalence";
  readonly entries: readonly TopicPortfolioEnvelopeEntry[];
};

export type TopicPortfolioBinding = { readonly bid: TopicBudgetBid; readonly sidecar: TopicPortfolioSidecar };

export type TopicPortfolioBridgeInput = {
  readonly schemaVersion: 1;
  readonly basis: LearningAllocationBasis;
  readonly unit: "total_model_tokens";
  readonly domainRelation: "separable";
  readonly quotaUnit: string;
  readonly budget: LearningAllocationResources;
  readonly bindings: readonly TopicPortfolioBinding[];
};

export type TopicPortfolioProvenance = {
  readonly schemaVersion: 1;
  readonly valuationRef: string;
  readonly externalValuationRef: string;
  readonly inputHash: string;
  readonly sourceBasis: LearningAllocationBasis;
  readonly quotaUnit: string;
  readonly unit: "total_model_tokens";
  readonly sources: readonly { readonly owner: LearningAllocationOwner; readonly domain: TopicBudgetBid["domain"];
    readonly valuationId: string; readonly bidHash: string; readonly evidenceWindowHash: string;
    readonly sidecarHash: string; readonly entries: readonly TopicPortfolioEnvelopeEntry[] }[];
};

export type TopicPortfolioBridgeResult = { readonly status: "rejected"; readonly reason: "topic_portfolio_invalid" | "topic_portfolio_binding" }
  | { readonly status: "ready"; readonly request: LearningPortfolioRequest; readonly requestJson: string;
      readonly provenance: TopicPortfolioProvenance };
