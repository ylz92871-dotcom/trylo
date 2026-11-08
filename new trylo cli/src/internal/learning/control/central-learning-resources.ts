import type { CentralLearningResources } from "./central-budget-contract.js";
import { fields, sequence } from "../../validation/json-shape.js";

export const CENTRAL_LEARNING_RESOURCE_KEYS = ["tokens", "calls", "steps"] as const;
export const MAX_CENTRAL_LEARNING_RESOURCE = 1_000_000_000;

/** Persisted/input limits are nonnegative; a derived available balance may be negative. */
export function isCentralLearningResources(value: unknown): value is CentralLearningResources {
  return fields(value, CENTRAL_LEARNING_RESOURCE_KEYS)
    && CENTRAL_LEARNING_RESOURCE_KEYS.every(key => {
      const resource = value[key];
      return sequence(resource) && resource <= MAX_CENTRAL_LEARNING_RESOURCE;
    });
}

export function centralLearningResourcesFit(used: CentralLearningResources, cap: CentralLearningResources): boolean {
  return CENTRAL_LEARNING_RESOURCE_KEYS.every(key => used[key] <= cap[key]);
}

/** Callers validate operands and the resulting limits at their boundary. */
export function addCentralLearningResources(left: CentralLearningResources, right: CentralLearningResources): CentralLearningResources {
  return { tokens: left.tokens + right.tokens, calls: left.calls + right.calls, steps: left.steps + right.steps };
}

export function centralLearningResourceKey(resources: CentralLearningResources): string {
  return CENTRAL_LEARNING_RESOURCE_KEYS.map(key => resources[key]).join(":");
}

/** Stable lexicographic preference; this never exchanges tokens for calls or steps. */
export function compareCentralLearningResources(left: CentralLearningResources, right: CentralLearningResources): number {
  for (const key of CENTRAL_LEARNING_RESOURCE_KEYS) if (left[key] !== right[key]) return left[key] - right[key];
  return 0;
}

export function sameCentralLearningResources(left: CentralLearningResources, right: CentralLearningResources): boolean {
  return CENTRAL_LEARNING_RESOURCE_KEYS.every(key => left[key] === right[key]);
}
