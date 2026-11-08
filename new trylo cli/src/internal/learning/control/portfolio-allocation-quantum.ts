import { allocateLearning } from "./allocation-kernel.js";
import { ALLOCATION_RESOURCE_KEYS, allocationOwnerKey } from "./allocation-shape.js";
import type { LearningPortfolioRequest } from "./portfolio-allocation-contract.js";
import type { PortfolioEntry } from "./portfolio-allocation-kernel.js";

export type PortfolioQuantumProof = { readonly scalarBudget: number; readonly transitionUpperBound: number };

/** Exact pointwise reduction only. Sparse tiers, signed values or a large scalar budget use the vector kernel. */
export function portfolioQuantumProof(request: LearningPortfolioRequest): PortfolioQuantumProof | undefined {
  const quantum = request.commonQuantum;
  if (quantum === undefined) return undefined;

  for (const group of request.groups) {
    for (const [index, tier] of group.tiers.entries()) {
      if (tier.quota !== index + 1 || tier.netValue < 0
        || !ALLOCATION_RESOURCE_KEYS.every(key => tier.offer.reserve[key] === tier.quota * quantum[key])) return undefined;
    }
  }

  const caps = ALLOCATION_RESOURCE_KEYS.filter(key => quantum[key] > 0)
    .map(key => Math.floor(request.budget[key] / quantum[key]));
  const scalarBudget = Math.min(...caps, request.groups.reduce((sum, group) => sum + group.tiers.length, 0));
  if (scalarBudget > 8) return undefined;

  let states = 1, transitionUpperBound = 0, maximumQuota = 0;

  for (const group of request.groups) {
    transitionUpperBound += states * (group.tiers.length + 1);
    maximumQuota += group.tiers.length;
    states = Math.min(scalarBudget, maximumQuota) + 1;
  }

  return { scalarBudget, transitionUpperBound };
}

/** Invoke the existing public scalar kernel; retain its comparison behavior and no invented visit count. */
export function allocatePortfolioQuantum(request: LearningPortfolioRequest, proof: PortfolioQuantumProof): PortfolioEntry {
  const scalar = allocateLearning(request.groups.map(group => ({ domain: allocationOwnerKey(group.owner),
    values: [0, ...group.tiers.map(tier => tier.netValue)] })), proof.scalarBudget);
  const quantum = request.commonQuantum!;
  return { value: scalar.value, quotas: scalar.allocations.map(allocation => allocation.quota),
    used: { tokens: scalar.allocated * quantum.tokens, calls: scalar.allocated * quantum.calls, steps: scalar.allocated * quantum.steps } };
}
