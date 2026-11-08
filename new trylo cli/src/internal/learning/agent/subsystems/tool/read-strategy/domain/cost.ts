import { READ_STRATEGY_COST_METRIC } from "./contracts.js";

/** Physical work in the existing tool metric's units; study checks remain part of the work. */
export function readStrategyIoWork(bytesRead: number, latencyMs: number): number {
  if (!Number.isFinite(bytesRead) || bytesRead < 0 || !Number.isFinite(latencyMs) || latencyMs < 0) {
    throw new Error("routing_cost_invalid");
  }
  return bytesRead + latencyMs * 1024;
}

/** The shipping deployment objective: failed reads cost the metric maximum. */
export function readStrategyCost(outcome: "completed" | "failed", bytesRead: number, latencyMs: number): number {
  const work = readStrategyIoWork(bytesRead, latencyMs);
  return outcome === "failed" ? READ_STRATEGY_COST_METRIC.maximum : Math.min(READ_STRATEGY_COST_METRIC.maximum, work);
}
