import type { RewardMetric, RewardTarget } from "./contracts.js";
import { isRewardMetric, identity } from "./validate.js";
import { sameMetricDefinition } from "./measurement.js";

export type RewardCatalog = {
  readonly accepts: (metric: RewardMetric, targets: readonly RewardTarget[]) => boolean;
};

/** A host registers semantic units and object namespaces; model output cannot register itself. */
export function createRewardCatalog(input: {
  readonly metrics: readonly RewardMetric[];
  readonly objectKinds: readonly string[];
}): RewardCatalog {
  const metrics = input.metrics.map(metric => ({ ...metric }));
  const kinds = new Set(input.objectKinds);
  if (metrics.length === 0 || metrics.some(metric => !isRewardMetric(metric)) ||
      kinds.size !== input.objectKinds.length || !input.objectKinds.every(identity)) {
    throw new Error("invalid_reward_catalog");
  }
  const ids = new Set(metrics.map(metric => JSON.stringify([metric.id, metric.version])));
  if (ids.size !== metrics.length) throw new Error("duplicate_reward_metric");
  return { accepts: (metric, targets) => metrics.some(registered => sameMetricDefinition(registered, metric)) &&
    targets.every(target => kinds.has(target.kind)) };
}
