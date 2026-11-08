import assert from "node:assert/strict";
import test from "node:test";
import type { LearningAllocationBasis } from "../allocation-contract.js";
import type { CentralPursuitCandidate, CentralPursuitObservation } from "./pursuit-contract.js";
import { centralPursuitFamilyKey, predictCentralPursuitCandidates } from "./pursuit-prediction.js";

const basis: LearningAllocationBasis = { scope: "workspace:pursuit-prediction", boardSequence: 20,
  budgetId: "budget:pursuit", utilityUnit: "qualified_objective_completions", valuationRef: "source:pursuit" };

function candidate(id = "current"): CentralPursuitCandidate {
  return {
    opportunity: { opportunityId: `opportunity:${id}`, scope: basis.scope, targetRef: "target:delivered-proposal",
      instanceRef: `stage:${id}`, sourceRef: `source:${id}`, stage: "initial", conditionRef: "condition:npm-adapter",
      baselineRef: `baseline:${id}`, windowRef: "window:focused-goal",
      offer: { offerId: `offer:${id}`, owner: { plane: "agent", domain: "tool" }, policyRef: "policy:bounded-research-v1",
        reserve: { tokens: 2000, calls: 1, steps: 1 }, maxPromptChars: 8000 } },
    source: { issueId: `issue:${id}`, grantId: `grant:${id}`, sourceBindingRef: `binding:${id}`,
      domainStage: { stageRef: `stage:${id}`, kind: "initial", policyRef: "policy:bounded-research-v1",
        sourceReportId: `report:${id}`, readiness: { kind: "ready", evidenceRefs: [`source:${id}`] } } },
    readiness: { kind: "ready", sourceRef: "business:handoff", now: 100, nextHandoff: null },
    target: { kind: "boundary-independent", sourceRef: "target:stage-boundary" },
    fee: { kind: "hard-budget-only", sourceRef: "policy:budget-is-hard-cap" }, purpose: "focused_learning",
    objective: { instanceId: `objective:${id}`, criterion: "proposal_delivered", definitionRef: "criterion:proposal-v1",
      familyRef: "family:npm-research", familySourceRef: "protocol:compatible-research-stages-v1" },
  };
}

function observation(id: string, outcome: CentralPursuitObservation["outcome"]): CentralPursuitObservation {
  const current = candidate();
  return { unitId: `episode:${id}`, scope: basis.scope, conditionRef: current.opportunity.conditionRef,
    objective: { ...current.objective, instanceId: `objective:past-${id}` }, grantId: `grant:past-${id}`,
    stageRef: `stage:past-${id}`, sourceRef: `receipt:${id}`, revisionRef: `revision:${id}`, sequence: 1, outcome };
}

function prediction(candidates = [candidate()], observations: CentralPursuitObservation[] = []) {
  const result = predictCentralPursuitCandidates(candidates, observations, basis);
  if (result.status !== "ready") assert.fail(result.reason);
  return result;
}

function nearAnalyticVariance(actual: number, expected: number) {
  // These two positive analytic oracles are powers of two: EPSILON * expected
  // is one ULP. The kernel's log/exp path need not reproduce their exact bits.
  const tolerance = 8 * Number.EPSILON * expected;
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} within ${tolerance}`);
}

test("a real first objective receives a labeled Jeffreys reference prediction without fake history", () => {
  const source = candidate(), before = JSON.stringify(source), result = prediction([source]), row = result.predictions[0]!;

  assert.equal(row.mean, 1 / 2);
  nearAnalyticVariance(row.variance, 1 / 8);
  assert.equal(row.posteriorAlpha, 1 / 2);
  assert.equal(row.posteriorBeta, 1 / 2);
  assert.deepEqual([row.qualified, row.noResult, row.pending], [0, 0, 0]);
  assert.deepEqual(row.pendingMeanRange, [1 / 2, 1 / 2]);
  assert.equal(row.support, "reference_prior");
  assert.equal(row.interpretation, "declared_objective_completion_not_economic_gain");
  assert.ok(result.assumptions.some(value => value.includes("not observed")));
  assert.equal(JSON.stringify(source), before);
});

test("qualified and final no-result heads update the model; pending labels remain an incomplete range", () => {
  const rows = [observation("qualified", "qualified"), observation("pending-one", "pending"), observation("pending-two", "pending")];
  const result = prediction([candidate()], rows), row = result.predictions[0]!;

  assert.equal(row.mean, 3 / 4);
  nearAnalyticVariance(row.variance, 1 / 16);
  assert.deepEqual([row.qualified, row.noResult, row.pending], [1, 0, 2]);
  assert.deepEqual(row.pendingMeanRange, [3 / 8, 7 / 8]);
  assert.equal(row.support, "updated_reference_model");
  assert.ok(row.sourceRefs.includes("receipt:qualified"));
  const revised = prediction([candidate()], rows.map(item => item.unitId === "episode:qualified"
    ? { ...item, revisionRef: "revision:corrected", outcome: "closed_no_result" } : item));

  assert.equal(revised.predictions[0]!.mean, 1 / 4);
  assert.notEqual(revised.modelRef, result.modelRef);
  assert.equal(prediction([candidate()], [observation("only-pending", "pending")]).predictions[0]!.mean, 1 / 2);
});

test("declared compatible families share across real caps while criteria, conditions and family sources remain separate", () => {
  const first = candidate(), deeper = candidate("deeper");
  const changedCap: CentralPursuitCandidate = { ...deeper, opportunity: { ...deeper.opportunity,
    offer: { ...deeper.opportunity.offer, policyRef: "policy:compatible-deeper-research-v2",
      reserve: { tokens: 4000, calls: 2, steps: 2 }, maxPromptChars: 16000 } } };
  const result = prediction([first, changedCap], [observation("past", "qualified")]);

  assert.deepEqual(result.predictions.map(row => row.mean), [3 / 4, 3 / 4]);

  for (const changed of [
    { ...first, objective: { ...first.objective, criterion: "checker_verified" as const } },
    { ...first, objective: { ...first.objective, definitionRef: "criterion:other" } },
    { ...first, objective: { ...first.objective, familyRef: "family:other" } },
    { ...first, objective: { ...first.objective, familySourceRef: "protocol:other" } },
    { ...first, opportunity: { ...first.opportunity, conditionRef: "condition:other" } },
  ]) assert.equal(prediction([changed], [observation("past", "qualified")]).predictions[0]!.mean, 1 / 2);

  assert.equal(centralPursuitFamilyKey(basis.scope, first.objective, first.opportunity.conditionRef),
    centralPursuitFamilyKey(basis.scope, deeper.objective, deeper.opportunity.conditionRef));
});

test("independent-episode and objective duplication cannot multiply effective evidence", () => {
  const row = observation("one", "qualified");

  for (const rows of [[row, row], [row, { ...row, unitId: "episode:another-event" }]]) {
    assert.equal(predictCentralPursuitCandidates([candidate()], rows, basis).status, "invalid");
  }

  const original = candidate(), alternate = candidate("alternate");

  // Alternative real stages can pursue the same objective; the composition counts its fulfillment once.
  assert.equal(prediction([original, { ...alternate, objective: original.objective }]).predictions.length, 2);
  assert.equal(predictCentralPursuitCandidates([original, original], [], basis).status, "invalid");
});

test("future, foreign-scope and malformed projections fail at the boundary", () => {
  const row = observation("one", "qualified");
  for (const bad of [{ ...row, sequence: basis.boardSequence + 1 }, { ...row, scope: "workspace:other" },
    { ...row, objective: { ...row.objective, familySourceRef: "" } }]) {
    assert.equal(predictCentralPursuitCandidates([candidate()], [bad], basis).status, "invalid");
  }
  assert.equal(predictCentralPursuitCandidates([candidate()], [], { ...basis, boardSequence: -1 }).status, "invalid");
});
