import type { RewardMetric } from "./contracts.js";

/** Declared physical/raw scale -> dimensionless bounded utility. Never compare different metrics. */
export function normalizedReward(metric: RewardMetric, raw: number): number {
  const ratio = (raw - metric.minimum) / (metric.maximum - metric.minimum);
  const utility = Math.max(-1, Math.min(1, 2 * ratio - 1));
  return metric.preference === "higher" ? utility : -utility;
}

export function sameMetricDefinition(left: RewardMetric, right: RewardMetric): boolean {
  return left.id === right.id && left.version === right.version && left.unit === right.unit &&
    left.minimum === right.minimum && left.maximum === right.maximum && left.preference === right.preference;
}
