import type { LearningDomain } from "./contracts.js";

/** Ephemeral domain offer. Central sees no topic, asset, prompt or execution capability. */
export type TopicBudgetBid = {
  readonly schemaVersion: 1;
  readonly valuationId: string;
  readonly domain: LearningDomain;
  readonly scope: string;
  readonly basis: { readonly boardSequence: number; readonly evidenceWindowHash: string };
  readonly utilityUnit: string;
  readonly quotaUnit: string;
  readonly modelKind: "declared_finite_expected_utility";
  readonly curve: readonly { readonly quota: number; readonly netValue: number }[];
};
