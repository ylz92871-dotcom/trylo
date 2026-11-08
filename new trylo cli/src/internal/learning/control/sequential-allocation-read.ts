import { fields, identity, list } from "../../validation/json-shape.js";
import { allocationCapKey, allocationCount, allocationFinite, allocationFits, isAllocationBasis, isAllocationOffer, isAllocationResources } from "./allocation-shape.js";
import { SEQUENTIAL_ALLOCATION_LIMITS as limits, type SequentialAllocationAction, type SequentialAllocationOutcome, type SequentialAllocationRequest, type SequentialAllocationState } from "./sequential-allocation-contract.js";

/** Closed JSON boundary. No default values, probability normalization, inferred models or repaired references. */
export function readSequentialAllocation(json: string): SequentialAllocationRequest | undefined {
  if (typeof json !== "string" || json.length > limits.jsonCharacters) return undefined;
  let value: unknown;
  try { value = JSON.parse(json); } catch { return undefined; }
  if (!isSequentialAllocationRequest(value)) return undefined;
  return value;
}

function isSequentialAllocationRequest(value: unknown): value is SequentialAllocationRequest {
  if (!fields(value, ["schemaVersion", "modelKind", "basis", "initialStateId", "remaining", "horizon", "states"])
    || value.schemaVersion !== 1 || value.modelKind !== "declared_finite_observable" || !isAllocationBasis(value.basis)
    || !identity(value.initialStateId) || !isAllocationResources(value.remaining) || !allocationCount(value.horizon, limits.horizon)
    || !list(value.states, 1, limits.states)) return false;

  const states = new Map<string, SequentialAllocationState>();
  let offerCount = 0, branchCount = 0;

  for (const state of value.states) {
    if (!isSequentialAllocationState(state) || states.has(state.stateId)) return false;
    states.set(state.stateId, state);
    offerCount += state.offers.length;
    branchCount += state.offers.reduce((count, action) => count + action.outcomes.length, 0);
    if (offerCount > limits.offers || branchCount > limits.branches) return false;
  }

  return states.has(value.initialStateId) && [...states.values()].every(state => state.offers.every(action =>
    action.outcomes.every(outcome => states.has(outcome.nextStateId))));
}

function isSequentialAllocationState(value: unknown): value is SequentialAllocationState {
  if (!fields(value, ["stateId", "stopValue", "offers"]) || !identity(value.stateId)
    || !allocationFinite(value.stopValue, -limits.stopMagnitude, limits.stopMagnitude) || !list(value.offers, 0, limits.offers)) return false;

  const offerIds = new Set<string>(), ownerCaps = new Set<string>();

  for (const action of value.offers) {
    if (!isSequentialAllocationAction(action)) return false;
    const cap = allocationCapKey(action.offer);
    if (offerIds.has(action.offer.offerId) || ownerCaps.has(cap)) return false;
    offerIds.add(action.offer.offerId);
    ownerCaps.add(cap);
  }

  return true;
}

function isSequentialAllocationAction(value: unknown): value is SequentialAllocationAction {
  if (!fields(value, ["offer", "outcomes"]) || !isAllocationOffer(value.offer)
    || !list(value.outcomes, 1, limits.outcomesPerOffer)) return false;

  let probability = 0;

  for (const outcome of value.outcomes) {
    if (!isSequentialAllocationOutcome(outcome) || !allocationFits(outcome.cost, value.offer.reserve)) return false;
    probability += outcome.probability;
  }

  return Math.abs(probability - 1) <= limits.probabilityTolerance;
}

function isSequentialAllocationOutcome(value: unknown): value is SequentialAllocationOutcome {
  return fields(value, ["probability", "cost", "utilityCost", "nextStateId"])
    && allocationFinite(value.probability, 0, 1) && isAllocationResources(value.cost)
    && allocationFinite(value.utilityCost, 0, limits.utilityCost) && identity(value.nextStateId);
}
