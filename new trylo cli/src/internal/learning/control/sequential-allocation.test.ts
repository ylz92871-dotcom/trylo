import assert from "node:assert/strict";
import test from "node:test";
import type { LearningAllocationOffer } from "./allocation-contract.js";
import type { SequentialAllocationRequest, SequentialAllocationState } from "./sequential-allocation-contract.js";
import { readSequentialAllocation } from "./sequential-allocation-read.js";
import { planSequentialAllocation } from "./sequential-allocation.js";

const resources = (tokens: number) => ({ tokens, calls: tokens, steps: tokens });
const offer = (id: string, tokens = 1): LearningAllocationOffer => ({ offerId: id, owner: { plane: "agent", domain: "prompt" },
  policyRef: `policy:${id}`, reserve: resources(tokens), maxPromptChars: 1000 });
const outcome = (nextStateId: string, tokens: number, utilityCost = 0) => ({ probability: 1, nextStateId, cost: resources(tokens), utilityCost });

function model(states: readonly SequentialAllocationState[], horizon = 2): SequentialAllocationRequest {
  return { schemaVersion: 1, modelKind: "declared_finite_observable", basis: { scope: "workspace", boardSequence: 3,
    budgetId: "budget", utilityUnit: "declared-future-value", valuationRef: "external-model:fixture" }, initialStateId: "root", remaining: resources(2), horizon, states };
}

function terminalChain(): SequentialAllocationRequest {
  return model([{ stateId: "root", stopValue: 1, offers: [{ offer: offer("start"), outcomes: [outcome("middle", 1, 1)] }] },
    { stateId: "middle", stopValue: 2, offers: [{ offer: offer("continue"), outcomes: [outcome("end", 1, 1)] }] },
    { stateId: "end", stopValue: 4, offers: [] }]);
}

test("terminal values and externally supplied utility costs are counted once", () => {
  const request = terminalChain(), before = JSON.stringify(request);
  const result = planSequentialAllocation(before);

  assert.equal(result.status, "planned");

  if (result.status !== "planned") return;

  assert.equal(result.plan.netPolicyValue, 2);
  assert.equal(result.plan.baselineStopValue, 1);
  assert.equal(result.plan.netGain, 1);
  assert.equal(result.plan.decision.kind, "offer");
  assert.equal(JSON.stringify(request), before);
  const stopped = planSequentialAllocation(JSON.stringify({ ...request, horizon: 0 }));

  assert.equal(stopped.status, "planned");

  if (stopped.status === "planned") {
    assert.equal(stopped.plan.decision.kind, "stop");
    assert.equal(stopped.plan.netPolicyValue, 1);
  }
});

test("admission uses the full reserve while settled actual cost frees future headroom", () => {
  const request = model([{ stateId: "root", stopValue: 0, offers: [{ offer: offer("large-cap", 2), outcomes: [outcome("middle", 1)] }] },
    { stateId: "middle", stopValue: 0, offers: [{ offer: offer("continue", 2), outcomes: [outcome("end", 2)] }] },
    { stateId: "end", stopValue: 1.1, offers: [] }]);
  const result = planSequentialAllocation(JSON.stringify({ ...request, remaining: resources(3) }));

  assert.equal(result.status, "planned");
  if (result.status === "planned") assert.equal(result.plan.netPolicyValue, 1.1);

  const blocked = planSequentialAllocation(JSON.stringify({ ...request, remaining: resources(1) }));

  assert.equal(blocked.status, "planned");
  if (blocked.status === "planned") assert.equal(blocked.plan.decision.kind, "stop");
});

test("zero-cost local stages and peer User Learning remain mathematical offers without execution authority", () => {
  const userOffer: LearningAllocationOffer = { ...offer("user", 0), owner: { plane: "user" } };
  const request = model([{ stateId: "root", stopValue: 0, offers: [{ offer: userOffer, outcomes: [outcome("end", 0)] }] },
    { stateId: "end", stopValue: 1, offers: [] }], 1);
  const result = planSequentialAllocation(JSON.stringify(request));

  assert.equal(result.status, "planned");

  if (result.status !== "planned" || result.plan.decision.kind !== "offer") return;

  assert.deepEqual(result.plan.decision.offer.owner, { plane: "user" });
  assert.equal(Object.hasOwn(result.plan, "grantId"), false);
  assert.equal(result.plan.decision.offerHash.length, 64);
  assert.equal(result.plan.modelHash.length, 64);
});

test("strict boundary rejects probability repair, invalid references, overspending and same-owner policy menus", () => {
  const request = terminalChain();

  assert.equal(readSequentialAllocation(JSON.stringify({ ...request, permission: "shell" })), undefined);
  const root = request.states[0]!, action = root.offers[0]!, branch = action.outcomes[0]!;

  for (const replacement of [{ ...branch, probability: 1 - 1e-10 }, { ...branch, nextStateId: "missing" }, { ...branch, cost: resources(2) }]) {
    const invalid = { ...request, states: [{ ...root, offers: [{ ...action, outcomes: [replacement] }] }, ...request.states.slice(1)] };
    assert.equal(readSequentialAllocation(JSON.stringify(invalid)), undefined);
  }

  const duplicate = { offer: { ...action.offer, offerId: "alias", policyRef: "private-policy", maxPromptChars: 900 }, outcomes: action.outcomes };

  assert.equal(readSequentialAllocation(JSON.stringify({ ...request, states: [{ ...root, offers: [action, duplicate] }, ...request.states.slice(1)] })), undefined);
});

test("node and operation limits reject without a partial plan", () => {
  const json = JSON.stringify(terminalChain());
  assert.deepEqual(planSequentialAllocation(json, { nodeLimit: 1 }), { status: "rejected", reason: "sequential_allocation_node_limit" });
  assert.deepEqual(planSequentialAllocation(json, { operationLimit: 1 }), { status: "rejected", reason: "sequential_allocation_operation_limit" });
});

test("horizon, terminal magnitude and graph work bounds are checked before search", () => {
  const request = terminalChain();

  assert.equal(readSequentialAllocation(JSON.stringify({ ...request, horizon: 9 })), undefined);
  assert.equal(readSequentialAllocation(JSON.stringify({ ...request, states: [{ stateId: "root", stopValue: 17, offers: [] }] })), undefined);
  const rejected = (states: readonly SequentialAllocationState[]) => {
    const json = JSON.stringify({ ...request, states });
    assert.ok(json.length <= 262144, "the quantity guard, not the JSON character cap, must reject this graph");
    assert.equal(readSequentialAllocation(json), undefined);
  };

  rejected(Array.from({ length: 257 }, (_, index) => ({ stateId: index === 0 ? "root" : `s${index}`, stopValue: 0, offers: [] })));
  const small = (index: number): LearningAllocationOffer => ({ offerId: index.toString(36), policyRef: "p",
    owner: { plane: "agent", domain: "prompt" }, reserve: { tokens: index + 1, calls: 1, steps: 1 }, maxPromptChars: 1 });
  const terminal = { stateId: "e", stopValue: 1, offers: [] };
  // 513 total offers across two states; neither state's list alone exceeds 512.
  const offers = Array.from({ length: 513 }, (_, index) => ({ offer: small(index), outcomes: [outcome("e", 0)] }));

  rejected([{ stateId: "root", stopValue: 0, offers: offers.slice(0, 256) },
    { stateId: "s", stopValue: 0, offers: offers.slice(256) }, terminal]);
  // 256*8+1=2049 branches; only 257 offers, with each probability mass exactly one.
  const branches = Array.from({ length: 257 }, (_, index) => ({ offer: small(index), outcomes: index === 256 ? [outcome("e", 0)]
    : Array.from({ length: 8 }, () => ({ ...outcome("e", 0), probability: 0.125 })) }));

  rejected([{ stateId: "root", stopValue: 0, offers: branches }, terminal]);
});
