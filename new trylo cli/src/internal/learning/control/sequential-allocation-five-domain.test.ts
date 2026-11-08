import assert from "node:assert/strict";
import test from "node:test";
import type { CentralLearningAgentDomain } from "./coordination-contract.js";
import type { SequentialAllocationPlan, SequentialAllocationRequest, SequentialAllocationState } from "./sequential-allocation-contract.js";
import { planSequentialAllocation } from "./sequential-allocation.js";

// Fixed external declarations, not semantic estimates. Independent Fraction derivation:
// docs/02-分期工程产出/P05-Experience-Learning-V0.3/evidence/2026-11-04-central-allocation/research/math/FIVE-DOMAIN-OBSERVABLE-CAPACITY-v1.md §6.2.
const domains: readonly CentralLearningAgentDomain[] = ["prompt", "tool", "skill", "workflow", "collaboration"];
const probabilities = [[.7, .3], [.5, .5], [.4, .6], [.6, .4], [.8, .2]] as const;
const weights = [6, 8, 10, 12, 4] as const;
const pairs = [[2, 3, 16], [0, 1, -5], [1, 4, 16]] as const;
const resources = (stages: number) => ({ tokens: stages * 1000, calls: stages, steps: stages });
const stateId = (state: readonly number[]) => `s${state.join("")}`;
const depth = (state: readonly number[]) => state.filter(status => status !== 0).length;

/** Sum exact twentieths before one Number conversion, so equal mathematical terminal values merge exactly. */
function utilityUnits(state: readonly number[]): number {
  const succeeded = state.map(status => status === 1);
  return weights.reduce((sum, weight, index) => sum + (succeeded[index] ? weight : 0), 0)
    + pairs.reduce((sum, [left, right, weight]) => sum + (succeeded[left] && succeeded[right] ? weight : 0), 0);
}

/** Complete histories and every available domain remain; only horizon-terminal equal utilities are lumped. */
function fiveDomainModel(kind: "complete" | "terminal_quotient"): SequentialAllocationRequest {
  const budget = kind === "complete" ? 5 : 3;
  const id = (state: readonly number[]) => kind === "terminal_quotient" && depth(state) === 3 ? `v:${utilityUnits(state)}` : stateId(state);
  const states = new Map<string, SequentialAllocationState>();

  for (let encoded = 0; encoded < 3 ** 5; encoded += 1) {
    const state = domains.map((_, index) => Math.floor(encoded / 3 ** (4 - index)) % 3);
    if (depth(state) > budget) continue;

    const current = id(state);
    const offers = depth(state) === budget ? [] : domains.flatMap((domain, index) => {
      if (state[index] !== 0) return [];
      return [{ offer: { offerId: `a:${current}:${domain}`, owner: { plane: "agent" as const, domain },
        policyRef: `p:${current}:${domain}`, reserve: resources(1), maxPromptChars: 1000 },
      outcomes: probabilities[index]!.map((probability, outcome) => {
        const next = [...state];
        next[index] = outcome + 1;
        return { probability, cost: resources(1), utilityCost: 0, nextStateId: id(next) };
      }) }];
    });

    states.set(current, { stateId: current, stopValue: utilityUnits(state) / 20, offers });
  }

  return { schemaVersion: 1, modelKind: "declared_finite_observable", basis: { scope: "workspace:five-domain",
    boardSequence: 0, budgetId: "budget:five-domain", utilityUnit: "constructed-net-value", valuationRef: "external:fixed-rational-v2" },
  initialStateId: "s00000", remaining: resources(budget), horizon: budget, states: [...states.values()] };
}

function plan(request: SequentialAllocationRequest): SequentialAllocationPlan {
  const result = planSequentialAllocation(JSON.stringify(request));
  assert.equal(result.status, "planned");
  return result.plan;
}

function selected(result: SequentialAllocationPlan): CentralLearningAgentDomain {
  assert.equal(result.decision.kind, "offer");
  if (result.decision.kind !== "offer") throw new Error("expected_domain_offer");
  const owner = result.decision.offer.owner;
  assert.equal(owner.plane, "agent");
  if (owner.plane !== "agent") throw new Error("expected_agent_domain");
  return owner.domain;
}

function counts(request: SequentialAllocationRequest) {
  return { states: request.states.length, offers: request.states.reduce((sum, state) => sum + state.offers.length, 0),
    branches: request.states.reduce((sum, state) => sum + state.offers.reduce((count, action) => count + action.outcomes.length, 0), 0) };
}

test("complete five-domain stochastic graph fits the declared finite planner without policy pruning", () => {
  const request = fiveDomainModel("complete");
  assert.deepEqual(counts(request), { states: 243, offers: 405, branches: 810 });
  assert.ok(JSON.stringify(request).length < 262144);
  // Budget 5 learns all domains: linearity + independent pair probabilities is a separate closed-form reference.
  const expected = .3 * .7 + .4 * .5 + .5 * .4 + .6 * .6 + .2 * .8 + .8 * .4 * .6 - .25 * .7 * .5 + .8 * .5 * .8;
  assert.ok(Math.abs(plan(request).netPolicyValue - expected) < 1e-12);
});

test("five-domain terminal quotient retains genuine adaptive competition and conditional choices across all domains", () => {
  const request = fiveDomainModel("terminal_quotient"), root = plan(request);

  assert.deepEqual(counts(request), { states: 72, offers: 165, branches: 330 });
  assert.ok(Math.abs(root.netPolicyValue - 579 / 500) < 1e-12);
  assert.equal(selected(root), "tool", "tool/workflow tie; stable offer IDs select tool");
  const at = (state: string, left: number) => plan({ ...request, initialStateId: state, remaining: resources(left), horizon: left });

  assert.equal(selected(at("s01000", 2)), "collaboration", "after tool success, collaboration/workflow tie");
  assert.equal(selected(at("s02000", 2)), "workflow", "after tool failure, inspect the independent complementary pair");
  assert.equal(selected(at("s02010", 1)), "skill", "successful workflow makes skill complementary");
  assert.equal(selected(at("s02020", 1)), "prompt", "failed workflow makes prompt's declared .21 beat skill's .20");
});
