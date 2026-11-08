import type { RewardMetric } from "../../../../../reward/contracts.js";

export const READ_STRATEGY_DECISION_POINT = "read_file.strategy.v1";
export const READ_STRATEGY_COST_METRIC: RewardMetric = {
  id: "tool.read.cost", version: "2", unit: "io_cost", minimum: 0,
  maximum: 1_000_000_000, preference: "lower",
};

export type ReadStrategyPath = import("../../../../../../ports/read-routing.js").ReadRoutingPath;

/** These are observable task conditions, never permission or tool installation settings. */
export type ReadStrategyConditions = {
  readonly schemaVersion: 1;
  readonly fileSize: "small" | "large";
  readonly range: "bounded" | "all";
  readonly streaming: boolean;
};

export type ReadStrategyPathStatistics = { readonly samples: number; readonly meanCost: number };

export type ReadStrategyRule = {
  readonly conditions: ReadStrategyConditions;
  readonly path: ReadStrategyPath;
  readonly evidenceIds: readonly string[];
  readonly feedbackIds: readonly string[];
  readonly statistics: { readonly whole: ReadStrategyPathStatistics; readonly stream: ReadStrategyPathStatistics };
};

/** Tool-owned format. Historical standalone routing policies never authorize selection here. */
export type ReadStrategyPolicy = {
  readonly schemaVersion: 2;
  readonly owner: "tool.read-strategy";
  readonly decisionPoint: typeof READ_STRATEGY_DECISION_POINT;
  readonly scope: string;
  readonly requestId: string;
  readonly issuedAt: string;
  readonly basedOnSequence: number;
  readonly rules: readonly ReadStrategyRule[];
};

/** Caller names the domain and gives a hard observation allowance; topic selection is internal. */
export type ReadStrategyLearningRequest = {
  readonly domain: "tool";
  readonly scope: string;
  readonly budget: { readonly maxObservations: number };
  readonly requestId: string;
  readonly issuedAt: string;
};

export type ReadStrategyLearningResult = {
  readonly status: "learned" | "waiting_evidence" | "budget_exhausted" | "disabled";
  readonly reason: string;
  readonly policy?: ReadStrategyPolicy;
  readonly consumed: { readonly observations: number };
};

export type ReadStrategySelection = {
  readonly path?: ReadStrategyPath;
  readonly reason: "learned_policy" | "no_policy" | "scope_mismatch" | "condition_mismatch" | "evidence_changed" | "path_failed";
};
