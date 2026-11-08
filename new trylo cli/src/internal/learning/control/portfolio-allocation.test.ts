import assert from "node:assert/strict";
import { test } from "node:test";
import type { LearningAllocationOwner, LearningAllocationResources } from "./allocation-contract.js";
import { allocateLearningPortfolio } from "./portfolio-allocation.js";
import type { LearningPortfolioGroup, LearningPortfolioRequest } from "./portfolio-allocation-contract.js";

const prompt = { plane: "agent", domain: "prompt" } as const, tool = { plane: "agent", domain: "tool" } as const;
const resources = (tokens: number, calls = 1, steps = 1): LearningAllocationResources => ({ tokens, calls, steps });

function group(owner: LearningAllocationOwner, rows: readonly (readonly [number, number, LearningAllocationResources])[]): LearningPortfolioGroup {
  const key = owner.plane === "user" ? "user" : owner.domain;
  return { owner, tiers: rows.map(([quota, netValue, reserve]) => ({ quota, netValue,
    offer: { offerId: `${key}:${quota}`, owner, policyRef: `policy:${key}:${quota}`, reserve, maxPromptChars: 1000 } })) };
}

function request(groups: readonly LearningPortfolioGroup[], budget: LearningAllocationResources): LearningPortfolioRequest {
  return { schemaVersion: 1, basis: { scope: "scope", boardSequence: 10, budgetId: "pool", utilityUnit: "normalized-net-utility", valuationRef: "external-model:fixture" },
    unit: "total_model_tokens", domainRelation: "separable", budget, groups };
}

function allocated(input: LearningPortfolioRequest) {
  const result = allocateLearningPortfolio(JSON.stringify(input));
  assert.equal(result.status, "allocated");
  if (result.status !== "allocated") throw new Error("expected_allocated");
  return result;
}

test("heterogeneous envelopes compete across Agent and peer User learning", () => {
  const input = request([group(prompt, [[1, .9, resources(8)]]), group(tool, [[1, .8, resources(5)]]),
    group({ plane: "user" }, [[1, .8, resources(5)]])], resources(10, 2, 2));
  const result = allocated(input);

  assert.equal(result.plan.netValue, 1.6);
  assert.deepEqual(result.plan.used, resources(10, 2, 2));
  assert.deepEqual(result.plan.allocations.map(item => item.quota), [0, 1, 1]);
  assert.equal(result.plan.mode, "vector_exact_cost");
});

test("negative and nonmonotone tiers preserve idle and compete by actual resource vectors", () => {
  const input = request([group(prompt, [[1, -.2, resources(1)], [2, .8, resources(2)], [3, .4, resources(3)]])], resources(3));
  assert.equal(allocated(input).plan.allocations[0]!.quota, 2);
  const negative = request([group(tool, [[1, -.1, resources(1)]])], resources(10));
  assert.equal(allocated(negative).plan.netValue, 0);
  assert.equal(allocated(negative).plan.allocations[0]!.offer, null);
});

test("exact resource merge keeps a strictly larger value even below terminal tolerance", () => {
  const input = request([group(prompt, [[1, 1 + .5e-12, resources(1)]]), group(tool, [[1, 1, resources(1)]])], resources(1));
  const plan = allocated(input).plan;
  assert.equal(plan.netValue, 1 + .5e-12);
  assert.deepEqual(plan.allocations.map(item => item.quota), [1, 0]);
});

test("terminal near-ties share one raw maximum anchor and cannot walk down a tolerance chain", () => {
  const input = request([group(prompt, [[1, 3e-12, resources(5)], [2, 2.25e-12, resources(4)],
    [3, 1.5e-12, resources(3)], [4, .75e-12, resources(2)], [5, 0, resources(1)]])], resources(5));
  const plan = allocated(input).plan;
  assert.equal(plan.allocations[0]!.quota, 2);
  assert.ok(plan.terminalValueGap! > 0 && plan.terminalValueGap! <= 1e-12);
});

test("exact common quantum invokes the compatible legacy path with an explicit work upper bound", () => {
  const input = { ...request([group(prompt, [[1, 1, resources(3, 1, 2)], [2, 1.4, resources(6, 2, 4)]]),
    group(tool, [[1, 1.1, resources(3, 1, 2)]])], resources(10, 3, 7)), commonQuantum: resources(3, 1, 2) };
  const result = allocated(input);

  assert.equal(result.plan.mode, "legacy_common_quantum");
  assert.equal(result.work.kind, "legacy_transition_upper_bound");
  assert.equal(result.plan.netValue, 2.5);
  assert.equal(result.plan.terminalValueGap, null);
  assert.equal(allocateLearningPortfolio(JSON.stringify(input), result.work.count - 1).status, "planning_limit");
  const changed = { ...input, commonQuantum: resources(4, 1, 2) };

  assert.equal(allocated(changed).plan.mode, "vector_exact_cost");
});

test("all infeasible candidates count against the cap and no partial plan escapes", () => {
  const input = request([group(prompt, Array.from({ length: 6 }, (_, i) => [i + 1, .1, resources(100 + i)] as const))], resources(0, 0, 0));
  const limited = allocateLearningPortfolio(JSON.stringify(input), 6);
  assert.deepEqual(limited, { status: "planning_limit", work: { kind: "counted_candidate_transitions", count: 7 } });
  assert.equal(allocated(input).work.count, 7);
});

test("reader rejects extra fields, excluded domains, duplicate owners and same-cap policy aliases", () => {
  const base = request([group(prompt, [[1, .5, resources(2)]])], resources(2));
  const badCap = group(prompt, [[1, .5, resources(2)], [2, .6, resources(2)]]);
  const invalid = [{ ...base, extra: true }, { ...base, groups: [base.groups[0], base.groups[0]] },
    { ...base, groups: [badCap] }, { ...base, unit: "output_tokens" },
    { ...base, groups: [{ owner: { plane: "agent", domain: "check" }, tiers: [] }] },
    { ...base, budget: { tokens: 1.5, calls: 1, steps: 1 } }];

  for (const input of invalid) assert.equal(allocateLearningPortfolio(JSON.stringify(input)).status, "invalid");
});

test("canonical order makes input permutation irrelevant", () => {
  const a = group(prompt, [[1, .6, resources(1)], [2, .5, resources(2)]]), b = group(tool, [[1, .6, resources(1)]]);
  const first = allocated(request([a, b], resources(1)));
  const second = allocated(request([b, { ...a, tiers: [...a.tiers].reverse() }], resources(1)));
  assert.deepEqual(second, first);
});
