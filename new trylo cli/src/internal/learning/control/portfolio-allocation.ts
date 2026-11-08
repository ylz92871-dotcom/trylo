import { allocationCount } from "./allocation-shape.js";
import { PORTFOLIO_LIMITS, type LearningPortfolioPlan, type LearningPortfolioRequest, type LearningPortfolioResult } from "./portfolio-allocation-contract.js";
import { allocatePortfolioVector, type PortfolioEntry } from "./portfolio-allocation-kernel.js";
import { allocatePortfolioQuantum, portfolioQuantumProof } from "./portfolio-allocation-quantum.js";
import { readLearningPortfolio } from "./portfolio-allocation-read.js";

/**
 * Pure static, separable expected-net-value allocation. No estimate, execution, permission or ledger write.
 * The transition cap covers all candidate expansions, including budget-rejected candidates. Parsing and
 * terminal scans have separate finite input bounds (six groups, six tiers each; at most 7^6 cost states).
 */
export function allocateLearningPortfolio(json: string, transitionLimit: number = PORTFOLIO_LIMITS.transitions): LearningPortfolioResult {
  const request = readLearningPortfolio(json);
  if (request === undefined) return { status: "invalid", reason: "portfolio_input_invalid" };

  if (!allocationCount(transitionLimit, PORTFOLIO_LIMITS.transitions) || transitionLimit === 0) return { status: "invalid", reason: "portfolio_planning_budget" };

  const proof = portfolioQuantumProof(request);
  if (proof !== undefined) {
    const work = { kind: "legacy_transition_upper_bound", count: proof.transitionUpperBound } as const;
    if (proof.transitionUpperBound > transitionLimit) return { status: "planning_limit", work };
    const entry = allocatePortfolioQuantum(request, proof);
    return { status: "allocated", plan: makePlan(request, entry, "legacy_common_quantum", null), work };
  }

  const result = allocatePortfolioVector(request, transitionLimit);
  const work = { kind: "counted_candidate_transitions", count: result.transitions } as const;

  return result.status === "planning_limit" ? { status: "planning_limit", work }
    : { status: "allocated", plan: makePlan(request, result.entry, "vector_exact_cost", result.rawMaximum - result.entry.value), work };
}

function makePlan(request: LearningPortfolioRequest, entry: PortfolioEntry, mode: LearningPortfolioPlan["mode"], gap: number | null): LearningPortfolioPlan {
  return { schemaVersion: 1, basis: request.basis, mode, used: entry.used, netValue: entry.value, terminalValueGap: gap,
    comparisonToleranceBound: (mode === "legacy_common_quantum" ? request.groups.length + 1 : 1) * PORTFOLIO_LIMITS.tolerance,
    allocations: request.groups.map((group, index) => {
      const quota = entry.quotas[index]!;
      return { owner: group.owner, quota, offer: group.tiers.find(tier => tier.quota === quota)?.offer ?? null };
    }) };
}
