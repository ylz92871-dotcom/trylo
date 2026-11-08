import type { LearningAllocationResources } from "./allocation-contract.js";
import { addAllocationResources, allocationFits, allocationResourceKey, compareAllocationResources } from "./allocation-shape.js";
import { PORTFOLIO_LIMITS, type LearningPortfolioRequest } from "./portfolio-allocation-contract.js";

export type PortfolioEntry = { readonly value: number; readonly used: LearningAllocationResources; readonly quotas: readonly number[] };

export type PortfolioKernelResult = { readonly status: "planned"; readonly entry: PortfolioEntry; readonly rawMaximum: number; readonly transitions: number }
  | { readonly status: "planning_limit"; readonly transitions: number };

const IDLE_RESOURCES = { tokens: 0, calls: 0, steps: 0 } as const;

/** Validated internal input only. Merge equal exact costs, never pairwise epsilon-near candidates. */
export function allocatePortfolioVector(request: LearningPortfolioRequest, limit: number): PortfolioKernelResult {
  let frontier = new Map<string, PortfolioEntry>([["0:0:0", { value: 0, used: IDLE_RESOURCES, quotas: [] }]]);
  let transitions = 0;

  for (const group of request.groups) {
    const next = new Map<string, PortfolioEntry>();
    const choices = [{ quota: 0, netValue: 0, reserve: IDLE_RESOURCES },
      ...group.tiers.map(tier => ({ quota: tier.quota, netValue: tier.netValue, reserve: tier.offer.reserve }))];

    for (const entry of frontier.values()) {
      for (const choice of choices) {
        transitions += 1;

        if (transitions > limit) return { status: "planning_limit", transitions };

        const used = addAllocationResources(entry.used, choice.reserve);
        if (!allocationFits(used, request.budget)) continue;

        const candidate = { value: entry.value + choice.netValue, used, quotas: [...entry.quotas, choice.quota] };
        const key = allocationResourceKey(used), previous = next.get(key);
        if (previous === undefined || candidate.value > previous.value
          || (candidate.value === previous.value && comparePortfolioQuotas(candidate.quotas, previous.quotas) < 0)) next.set(key, candidate);
      }
    }

    frontier = next;
  }

  return { status: "planned", ...choosePortfolioEntry(frontier), transitions };
}

function choosePortfolioEntry(frontier: ReadonlyMap<string, PortfolioEntry>): { readonly entry: PortfolioEntry; readonly rawMaximum: number } {
  let rawMaximum = -Infinity;

  for (const entry of frontier.values()) rawMaximum = Math.max(rawMaximum, entry.value);

  let selected: PortfolioEntry | undefined;

  for (const entry of frontier.values()) {
    if (rawMaximum - entry.value > PORTFOLIO_LIMITS.tolerance) continue;
    if (selected === undefined || compareAllocationResources(entry.used, selected.used) < 0
      || (compareAllocationResources(entry.used, selected.used) === 0 && comparePortfolioQuotas(entry.quotas, selected.quotas) < 0)) selected = entry;
  }

  // Every validated group has idle, so at least one finite exact-cost state survives.
  if (selected === undefined) throw new Error("portfolio_frontier_missing");

  return { entry: selected, rawMaximum };
}

function comparePortfolioQuotas(left: readonly number[], right: readonly number[]): number {
  for (const [index, quota] of left.entries()) if (quota !== right[index]) return quota - right[index]!;
  return 0;
}
