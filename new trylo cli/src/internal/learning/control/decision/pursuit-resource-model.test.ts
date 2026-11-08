import test from "node:test";
import assert from "node:assert/strict";
import { advanceCentralPursuitResourceModel, centralPursuitTreatmentRef, fitCentralPursuitResourceModel,
  predictCentralPursuitResourceModel } from "./pursuit-resource-model.js";
import type { CentralPursuitResourceModelResult } from "./pursuit-resource-model.js";
import type { LearningAllocationOffer } from "../allocation-contract.js";

function ready(result: CentralPursuitResourceModelResult) {
  if (result.status !== "ready") throw new Error(`${result.status}:${result.reason}`);
  return result;
}

function near(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`); }

test("cold resource models retain both proper reference hypotheses without invented outcomes", () => {
  const result = ready(fitCentralPursuitResourceModel([], "treatment:A"));
  near(Math.exp(result.belief.shared.logWeight), .5);
  near(Math.exp(result.belief.separate.logWeight), .5);
  near(result.mean, .5);
  near(result.variance, 1 / 8);
  assert.deepEqual(result.pendingMeanRange, [result.mean, result.mean]);
  assert.deepEqual(result.belief.pending, []);
  assert.deepEqual(result.belief.separate.groups, []);
});

test("opposite treatment outcomes learn structural sharing and preserve distinct treatment predictions", () => {
  // Ordered evidence: shared=.5*.25=1/8, separate=.5*.5=1/4; equal model prior => shared posterior=1/3.
  const result = ready(fitCentralPursuitResourceModel([{ treatmentRef: "treatment:A", outcome: "qualified" },
    { treatmentRef: "treatment:B", outcome: "closed_no_result" }], "treatment:A"));

  near(Math.exp(result.belief.shared.logWeight), 1 / 3);
  near(result.mean, 2 / 3);
  near(result.variance, 11 / 144);
  near(ready(predictCentralPursuitResourceModel(result.belief, "treatment:B")).mean, 1 / 3);
  near(ready(predictCentralPursuitResourceModel(result.belief, "treatment:C")).mean, .5);
  assert.deepEqual(result.pendingMeanRange, [result.mean, result.mean]);
});

test("consistent outcomes increase sharing evidence and transport uncertainty to a new treatment", () => {
  // Ordered evidence: shared=.5*.75=3/8, separate=1/4 => shared posterior=3/5.
  const result = ready(fitCentralPursuitResourceModel([{ treatmentRef: "treatment:A", outcome: "qualified" },
    { treatmentRef: "treatment:B", outcome: "qualified" }], "treatment:C"));
  near(Math.exp(result.belief.shared.logWeight), .6);
  near(result.mean, .7);
  near(result.variance, 39 / 400);
});

test("hypothetical Bellman branches update model weights and rates exactly as a pure rebuild", () => {
  const initial = ready(fitCentralPursuitResourceModel([], "treatment:A")), unchanged = JSON.stringify(initial.belief);
  const afterA = ready(advanceCentralPursuitResourceModel(initial.belief, { treatmentRef: "treatment:A", outcome: 1 }));
  const afterB = ready(advanceCentralPursuitResourceModel(afterA.belief, { treatmentRef: "treatment:B", outcome: 0 }));
  const rebuilt = ready(fitCentralPursuitResourceModel([{ treatmentRef: "treatment:A", outcome: "qualified" },
    { treatmentRef: "treatment:B", outcome: "closed_no_result" }], "treatment:A"));

  near(afterB.mean, rebuilt.mean);
  near(afterB.variance, rebuilt.variance);
  near(afterB.belief.shared.logWeight, rebuilt.belief.shared.logWeight);
  near(afterB.belief.separate.logWeight, rebuilt.belief.separate.logWeight);
  assert.equal(JSON.stringify(initial.belief), unchanged);
  assert.deepEqual(afterB.belief.separate.groups, rebuilt.belief.separate.groups);
});

test("pending labels supply no false failure and retain an envelope under both completed models", () => {
  const result = ready(fitCentralPursuitResourceModel([{ treatmentRef: "treatment:A", outcome: "qualified" },
    { treatmentRef: "treatment:B", outcome: "pending" }], "treatment:A"));

  near(result.mean, .75);
  near(result.pendingMeanRange[0], .5);
  near(result.pendingMeanRange[1], 5 / 6);
  assert.deepEqual(result.belief.pending, [{ treatmentRef: "treatment:B", count: 1 }]);
  const pending = ready(fitCentralPursuitResourceModel([{ treatmentRef: "treatment:A", outcome: "pending" }], "treatment:A"));
  const branch = ready(advanceCentralPursuitResourceModel(pending.belief, { treatmentRef: "treatment:A", outcome: 0 }));

  assert.deepEqual(branch.belief.pending, pending.belief.pending);
  near(branch.belief.shared.beta, 1.5);
  near(branch.belief.shared.alpha, .5);
});

test("treatment identity follows actual policy and resource envelope rather than offer instance", () => {
  const offer: LearningAllocationOffer = { offerId: "offer:one", owner: { plane: "agent", domain: "skill" }, policyRef: "policy:hermes",
    reserve: { tokens: 1000, calls: 1, steps: 1 }, maxPromptChars: 4000 };
  const original = centralPursuitTreatmentRef(offer);

  assert.equal(centralPursuitTreatmentRef({ ...offer, offerId: "offer:another" }), original);
  assert.equal(centralPursuitTreatmentRef({ ...offer, owner: { plane: "agent", domain: "tool" } }), original);

  for (const changed of [{ ...offer, policyRef: "policy:another" }, { ...offer, maxPromptChars: 4001 },
    { ...offer, reserve: { ...offer.reserve, tokens: 1001 } }, { ...offer, reserve: { tokens: 1000, calls: 2, steps: 2 } }]) {
    assert.notEqual(centralPursuitTreatmentRef(changed), original);
  }
});

test("a numerically tiny model retains finite log mass and remains available for later Bayes updates", () => {
  const fitted = ready(fitCentralPursuitResourceModel([{ treatmentRef: "treatment:A", outcome: "qualified" }], "treatment:B"));
  const rare = ready(predictCentralPursuitResourceModel({ ...fitted.belief, shared: { ...fitted.belief.shared, logWeight: -1000 },
    separate: { ...fitted.belief.separate, logWeight: 0 } }));

  assert.equal(Math.exp(rare.belief.shared.logWeight), 0);
  assert.ok(Number.isFinite(rare.belief.shared.logWeight));
  const updated = ready(advanceCentralPursuitResourceModel(rare.belief, { treatmentRef: "treatment:B", outcome: 1 }));

  assert.ok(Number.isFinite(updated.belief.shared.logWeight));
  assert.ok(updated.belief.shared.logWeight > rare.belief.shared.logWeight);
  assert.ok(updated.belief.separate.groups.some(row => row.treatmentRef === "treatment:B"));
});

test("malformed rate states and noncanonical observations fail instead of changing the declared model", () => {
  const fitted = ready(fitCentralPursuitResourceModel([], "treatment:A"));
  assert.equal(predictCentralPursuitResourceModel({ ...fitted.belief, shared: { ...fitted.belief.shared, alpha: 0 } }).status, "invalid");
  assert.equal(predictCentralPursuitResourceModel({ ...fitted.belief, separate: { ...fitted.belief.separate, groups: [
    { treatmentRef: "treatment:A", alpha: .5, beta: .5 }, { treatmentRef: "treatment:A", alpha: .5, beta: .5 }] } }).status, "invalid");
  assert.equal(fitCentralPursuitResourceModel(JSON.parse('[{"treatmentRef":"treatment:A","outcome":"completed"}]'), "treatment:A").status, "invalid");
});
