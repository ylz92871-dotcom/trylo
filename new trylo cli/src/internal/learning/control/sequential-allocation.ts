import type { LearningAllocationResources } from "./allocation-contract.js";
import { allocationCount, allocationFits, compareAllocationResources } from "./allocation-shape.js";
import { contentHashOf } from "./hash.js";
import { readSequentialAllocation } from "./sequential-allocation-read.js";
import { SEQUENTIAL_ALLOCATION_LIMITS as limits, type SequentialAllocationAction, type SequentialAllocationOptions, type SequentialAllocationPlan, type SequentialAllocationRequest, type SequentialAllocationResult, type SequentialAllocationState } from "./sequential-allocation-contract.js";

type Answer = { readonly value: number; readonly action?: SequentialAllocationAction };

type Candidate = { readonly value: number; readonly action: SequentialAllocationAction };

type Search = { readonly states: ReadonlyMap<string, SequentialAllocationState>; readonly memo: Map<string, Answer>;
  readonly nodeLimit: number; readonly operationLimit: number; nodes: number; operations: number;
  limit: "sequential_allocation_node_limit" | "sequential_allocation_operation_limit" | undefined };

/** Pure first-segment proposal. It neither reserves resources nor advances a runtime loop. */
export function planSequentialAllocation(json: string, options: SequentialAllocationOptions = {}): SequentialAllocationResult {
  const request = readSequentialAllocation(json);
  const nodeLimit = options.nodeLimit ?? limits.defaultNodes, operationLimit = options.operationLimit ?? limits.defaultOperations;
  if (request === undefined || !allocationCount(nodeLimit, limits.maxNodes) || !allocationCount(operationLimit, limits.maxOperations)) {
    return { status: "rejected", reason: "sequential_allocation_invalid" };
  }

  const search: Search = { states: new Map(request.states.map(state => [state.stateId, state])), memo: new Map(),
    nodeLimit, operationLimit, nodes: 0, operations: 0, limit: undefined };
  const answer = visit(search, request.initialStateId, request.remaining, request.horizon);
  if (answer === undefined) return { status: "rejected", reason: search.limit! };

  return { status: "planned", plan: makePlan(request, answer, search) };
}

function visit(search: Search, stateId: string, remaining: LearningAllocationResources, horizon: number): Answer | undefined {
  const key = JSON.stringify([stateId, remaining.tokens, remaining.calls, remaining.steps, horizon]);
  const cached = search.memo.get(key);
  if (cached !== undefined) return cached;

  if (search.nodes >= search.nodeLimit) {
    search.limit = "sequential_allocation_node_limit";
    return undefined;
  }

  search.nodes += 1;
  const state = search.states.get(stateId)!;
  const candidates: Candidate[] = [];
  let rawMaximum = state.stopValue;

  for (const action of horizon === 0 ? [] : state.offers) {
    if (!consumeOperation(search)) return undefined;
    if (!allocationFits(action.offer.reserve, remaining)) continue;
    const value = actionValue(search, action, remaining, horizon);
    if (value === undefined) return undefined;
    candidates.push({ value, action });
    rawMaximum = Math.max(rawMaximum, value);
  }

  const best = selectCandidate(search, state.stopValue, rawMaximum, candidates);
  if (best === undefined) return undefined;

  search.memo.set(key, best);

  return best;
}

function selectCandidate(search: Search, stopValue: number, rawMaximum: number, candidates: readonly Candidate[]): Answer | undefined {
  // Stop has priority in the ONE global window. Outside it, a cheap selected gain may still be <= tolerance.
  if (rawMaximum - stopValue <= limits.valueTolerance) return { value: stopValue };

  let selected: Candidate | undefined;

  for (const candidate of candidates) {
    if (!consumeOperation(search)) return undefined;
    if (rawMaximum - candidate.value > limits.valueTolerance) continue;
    if (selected === undefined || preferredOffer(candidate.action, selected.action)) selected = candidate;
  }

  // With stop outside the window, the finite raw-max offer itself is always eligible.
  if (selected === undefined) throw new Error("sequential_selection_missing");

  return selected;
}

function actionValue(search: Search, action: SequentialAllocationAction, remaining: LearningAllocationResources, horizon: number): number | undefined {
  let value = 0;

  for (const outcome of action.outcomes) {
    if (!consumeOperation(search)) return undefined;

    if (outcome.probability === 0) continue;

    const next = visit(search, outcome.nextStateId, { tokens: remaining.tokens - outcome.cost.tokens,
      calls: remaining.calls - outcome.cost.calls, steps: remaining.steps - outcome.cost.steps }, horizon - 1);
    if (next === undefined) return undefined;

    // stopValue is terminal; the externally supplied utility cost is subtracted exactly once on this edge.
    value += outcome.probability * (next.value - outcome.utilityCost);
  }

  return value;
}

function consumeOperation(search: Search): boolean {
  if (search.operations >= search.operationLimit) {
    search.limit = "sequential_allocation_operation_limit";
    return false;
  }
  search.operations += 1;
  return true;
}

function preferredOffer(left: SequentialAllocationAction, right: SequentialAllocationAction): boolean {
  const resources = compareAllocationResources(left.offer.reserve, right.offer.reserve);
  return resources < 0 || (resources === 0 && left.offer.offerId < right.offer.offerId);
}

function makePlan(request: SequentialAllocationRequest, answer: Answer, search: Search): SequentialAllocationPlan {
  const modelHash = contentHashOf(request);
  const decision = answer.action === undefined ? { kind: "stop" as const }
    : { kind: "offer" as const, offer: answer.action.offer, offerHash: contentHashOf(answer.action.offer) };
  const baselineStopValue = search.states.get(request.initialStateId)!.stopValue;
  const maximumProbabilityMassDrift = request.states.reduce((maximum, state) => state.offers.reduce((drift, action) =>
    Math.max(drift, Math.abs(action.outcomes.reduce((sum, outcome) => sum + outcome.probability, 0) - 1)), maximum), 0);

  return { schemaVersion: 1, planId: `sequential-allocation:${contentHashOf({ modelHash, decision })}`, modelHash,
    basis: request.basis, initialStateId: request.initialStateId, remaining: request.remaining, horizon: request.horizon,
    decision, netPolicyValue: answer.value, baselineStopValue, netGain: answer.value - baselineStopValue,
    numericalScope: { kind: "bounded_declared_model", probabilityTolerance: limits.probabilityTolerance,
      valueTolerance: limits.valueTolerance, maximumProbabilityMassDrift }, work: { nodes: search.nodes, operations: search.operations } };
}
