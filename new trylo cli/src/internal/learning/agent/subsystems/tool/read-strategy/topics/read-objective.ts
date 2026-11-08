import { READ_STRATEGY_COST_METRIC, readStrategyCost, readStrategyIoWork } from "../domain/index.js";

/** One declared objective for physical pairs, replay and later checker corrections. */
export const READ_TOPIC_OBJECTIVE = Object.freeze({
  maximumCandidateBytes: 262144,
  maximumPairBytes: 2097152,
  failureCost: READ_STRATEGY_COST_METRIC.maximum,
  utilityScale: READ_STRATEGY_COST_METRIC.maximum,
  utilityUnit: "read_quality_io_cost_v2",
  checkerVersion: "ws1-read-pair-check-v2",
  executionVersion: "ws1-read-pair-2s-v2",
});

/** Exactly the deployed tool objective. Missing elapsed time is not a zero-cost observation. */
export function readPairUtility(quality: "pass" | "fail", bytesRead: number, latencyMs: number): number {
  return -readStrategyCost(quality === "pass" ? "completed" : "failed", bytesRead, latencyMs);
}

/** Unclipped study work includes both checks and the candidate, in the same io_cost units. */
export function readPairStudyCost(totalBytesRead: number, totalLatencyMs: number): number {
  const work = readStrategyIoWork(totalBytesRead, totalLatencyMs);
  if (!Number.isFinite(work)) throw new Error("read_topic_cost_invalid");
  return work;
}
