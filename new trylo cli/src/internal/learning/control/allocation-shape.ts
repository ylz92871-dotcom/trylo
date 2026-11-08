import type { LearningAllocationBasis, LearningAllocationOffer, LearningAllocationOwner, LearningAllocationResources } from "./allocation-contract.js";
import { CENTRAL_LEARNING_AGENT_DOMAINS } from "./coordination-contract.js";
import { fields, identity, sequence } from "../../validation/json-shape.js";
import { CENTRAL_LEARNING_RESOURCE_KEYS as ALLOCATION_RESOURCE_KEYS, MAX_CENTRAL_LEARNING_RESOURCE,
  centralLearningResourceKey as allocationResourceKey, isCentralLearningResources } from "./central-learning-resources.js";

export { CENTRAL_LEARNING_RESOURCE_KEYS as ALLOCATION_RESOURCE_KEYS, centralLearningResourceKey as allocationResourceKey,
  centralLearningResourcesFit as allocationFits, addCentralLearningResources as addAllocationResources,
  compareCentralLearningResources as compareAllocationResources } from "./central-learning-resources.js";

export const ALLOCATION_SHAPE_LIMITS = { tokens: MAX_CENTRAL_LEARNING_RESOURCE, calls: 1024, steps: 1024,
  maxPromptChars: MAX_CENTRAL_LEARNING_RESOURCE } as const;

export function allocationFinite(value: unknown, low: number, high: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
}

export function allocationCount(value: unknown, maximum: number): value is number {
  return sequence(value) && value <= maximum;
}

export function isAllocationOwner(value: unknown): value is LearningAllocationOwner {
  return (fields(value, ["plane"]) && value.plane === "user")
    || (fields(value, ["plane", "domain"]) && value.plane === "agent"
      && CENTRAL_LEARNING_AGENT_DOMAINS.some(domain => domain === value.domain));
}

export function isAllocationResources(value: unknown): value is LearningAllocationResources {
  return isCentralLearningResources(value)
    && ALLOCATION_RESOURCE_KEYS.every(key => allocationCount(value[key], ALLOCATION_SHAPE_LIMITS[key]));
}

export function isAllocationBasis(value: unknown): value is LearningAllocationBasis {
  return fields(value, ["scope", "boardSequence", "budgetId", "utilityUnit", "valuationRef"])
    && identity(value.scope) && sequence(value.boardSequence) && identity(value.budgetId) && identity(value.utilityUnit)
    && identity(value.valuationRef);
}

export function isAllocationOffer(value: unknown): value is LearningAllocationOffer {
  return fields(value, ["offerId", "owner", "policyRef", "reserve", "maxPromptChars"])
    && identity(value.offerId) && isAllocationOwner(value.owner) && identity(value.policyRef)
    && isAllocationResources(value.reserve) && allocationCount(value.maxPromptChars, ALLOCATION_SHAPE_LIMITS.maxPromptChars);
}

export function allocationOwnerKey(owner: LearningAllocationOwner): string {
  return owner.plane === "user" ? "user" : `agent:${owner.domain}`;
}

/** Prompt length is an envelope limit, not a second policy menu at the same physical cap. */
export function allocationCapKey(offer: LearningAllocationOffer): string {
  return `${allocationOwnerKey(offer.owner)}:${allocationResourceKey(offer.reserve)}`;
}
