import assert from "node:assert/strict";
import test from "node:test";
import type { SequentialAllocationOptions, SequentialAllocationRequest } from "./sequential-allocation-contract.js";
import { planSequentialAllocation } from "./sequential-allocation.js";

const epsilon = 1e-12;

type Row = { readonly id: string; readonly cap: number; readonly value: number };

function model(rows: readonly Row[]): SequentialAllocationRequest {
  return { schemaVersion: 1, modelKind: "declared_finite_observable", basis: { scope: "scope", boardSequence: 2,
    budgetId: "pool", utilityUnit: "normalized-future-net-value", valuationRef: "external:anchor" },
    initialStateId: "root", remaining: { tokens: 1000, calls: 10, steps: 10 }, horizon: 1,
    states: [{ stateId: "root", stopValue: 0, offers: rows.map(row => {
      const reserve = { tokens: row.cap, calls: 1, steps: 1 };
      return { offer: { offerId: row.id, owner: { plane: "agent", domain: "prompt" }, policyRef: `policy:${row.id}`,
        reserve, maxPromptChars: 1000 }, outcomes: [{ probability: 1, cost: reserve, utilityCost: 0, nextStateId: `end:${row.id}` }] };
    }) }, ...rows.map(row => ({ stateId: `end:${row.id}`, stopValue: row.value, offers: [] }))] };
}

function planned(request: SequentialAllocationRequest, options: SequentialAllocationOptions = {}) {
  const result = planSequentialAllocation(JSON.stringify(request), options);
  assert.equal(result.status, "planned");
  if (result.status !== "planned") throw new Error("expected_planned");
  return result.plan;
}

function decisionId(request: SequentialAllocationRequest): string {
  const decision = planned(request).decision;
  return decision.kind === "stop" ? "stop" : decision.offer.offerId;
}

test("anchor makes near-equal offer selection independent of input offer order", () => {
  const expensive = { id: "expensive", cap: 1000, value: 1 }, cheap = { id: "cheap", cap: 1, value: 1 + epsilon / 2 };
  assert.deepEqual([decisionId(model([expensive, cheap])), decisionId(model([cheap, expensive]))], ["cheap", "cheap"]);
});

test("a cheaper offer inside the global window may have a smaller raw value than its anchor", () => {
  const request = model([{ id: "expensive", cap: 1000, value: 1 + epsilon / 2 }, { id: "cheap", cap: 1, value: 1 }]);
  const plan = planned(request);
  assert.equal(plan.decision.kind === "offer" ? plan.decision.offer.offerId : "stop", "cheap");
  assert.equal(plan.netPolicyValue, 1);
  assert.equal(plan.netGain, 1);
});

test("sorting by cap cannot replace selection relative to one global maximum", () => {
  const request = model([{ id: "A", cap: 1, value: 0 }, { id: "B", cap: 2, value: .6 * epsilon },
    { id: "C", cap: 3, value: 1.1 * epsilon }]);
  assert.equal(decisionId(request), "B");
});

test("stop has global-window priority while a selected cheap gain may be at most epsilon", () => {
  const stopped = model([{ id: "at-boundary", cap: 1000, value: epsilon }, { id: "cheap", cap: 1, value: .6 * epsilon }]);
  const continued = model([{ id: "above-boundary", cap: 1000, value: 1.1 * epsilon }, { id: "cheap", cap: 1, value: .6 * epsilon }]);

  assert.equal(decisionId(stopped), "stop");
  const plan = planned(continued);

  assert.equal(plan.decision.kind === "offer" ? plan.decision.offer.offerId : "stop", "cheap");
  assert.equal(plan.netPolicyValue, .6 * epsilon);
  assert.ok(plan.netGain > 0 && plan.netGain <= epsilon);
});

test("the second candidate scan is budgeted and its cutoff rejects without a partial plan", () => {
  const request = model([{ id: "expensive", cap: 1000, value: 1 + epsilon / 2 }, { id: "cheap", cap: 1, value: 1 }]);
  assert.deepEqual(planSequentialAllocation(JSON.stringify(request), { operationLimit: 4 }),
    { status: "rejected", reason: "sequential_allocation_operation_limit" });
  const plan = planned(request, { operationLimit: 6 });
  assert.equal(plan.work.operations, 6);
  assert.equal(plan.decision.kind === "offer" ? plan.decision.offer.offerId : "stop", "cheap");
});
