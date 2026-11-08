import assert from "node:assert/strict";
import test from "node:test";
import { emptyBoardState, type BoardState } from "../state.js";
import { reduce } from "../reducer.js";
import type { CoordinationAction } from "../coordination-contract.js";
import { createCentralPursuitObservationDraft, readCentralPursuitObservations } from "../../../integration/learning-allocation/pursuit-observations.js";
import { decideCentralLearningPursuit } from "./pursuit-model.js";
import { advanceCentralPursuitResourceModel, centralPursuitTreatmentRef, fitCentralPursuitResourceModel,
  predictCentralPursuitResourceModel } from "./pursuit-resource-model.js";
import type { CentralPursuitResourceModelResult, CentralPursuitResourceObservation } from "./pursuit-resource-model.js";
import type { CentralPursuitCandidate, CentralPursuitInput } from "./pursuit-contract.js";

const scope = "workspace:pursuit-history-continuation", budgetId = "budget:history", date = "2026-11-04T15:00:00.000Z";

function act(board: BoardState, action: CoordinationAction): BoardState {
  const result = reduce(board, { type: "coordinate_learning", commandId: `setup:${board.sequence}`, issuedAt: date, action });
  if (!result.ok) assert.fail(JSON.stringify(result));
  return result.state;
}

function current(resourceModel: boolean): CentralPursuitCandidate {
  return { opportunity: { opportunityId: "opportunity:current", scope, targetRef: "target:objective", instanceRef: "stage:current",
    sourceRef: "source:current", stage: "initial", conditionRef: "condition:stable", baselineRef: "baseline:current", windowRef: "window:stage",
    offer: { offerId: "offer:current", owner: { plane: "agent", domain: "tool" }, policyRef: "policy:stable",
      reserve: { tokens: 100, calls: 1, steps: 1 }, maxPromptChars: 1000 } },
    source: { issueId: "issue:current", grantId: "grant:current", sourceBindingRef: "binding:current", domainStage: {
      stageRef: "stage:current", kind: "initial", policyRef: "policy:stable", sourceReportId: "report:current",
      readiness: { kind: "ready", evidenceRefs: ["source:current"] } } },
    readiness: { kind: "ready", sourceRef: "business:confirmed", now: 100, nextHandoff: null },
    target: { kind: "boundary-independent", sourceRef: "source:fixed-window" },
    fee: { kind: "hard-budget-only", sourceRef: "source:hard-cap" }, purpose: "focused_learning",
    objective: { instanceId: "objective:current", criterion: "checker_verified", definitionRef: "criterion:check",
      familyRef: "family:stable", familySourceRef: "source:sampling-protocol", ...(resourceModel ? {
        resourceModel: { kind: "shared_or_exact_treatment" as const, sourceRef: "source:resource-model" } } : {}) } };
}

function appendObservation(board: BoardState, candidate: CentralPursuitCandidate, index: number): BoardState {
  const treatmentOffer = index % 2 === 0 ? candidate.opportunity.offer : { ...candidate.opportunity.offer,
    reserve: { tokens: 200, calls: 1, steps: 1 } };
  const draft = createCentralPursuitObservationDraft({ unitId: `episode:${index}`, scope,
    conditionRef: candidate.opportunity.conditionRef, objective: { ...candidate.objective, instanceId: `objective:past-${index}` },
    grantId: "grant:historical-source", stageRef: `stage:historical-${index}`, sourceRef: `checker:episode-${index}`,
    revisionRef: `revision:${index}`, outcome: index % 2 === 0 ? "qualified" : "closed_no_result",
    ...(candidate.objective.resourceModel === undefined ? {} : { treatmentRef: centralPursuitTreatmentRef(treatmentOffer) }) });
  if (draft.status !== "ready") assert.fail(draft.reason);

  const result = reduce(board, { type: "record_reward_v2_fact", commandId: `observe:${index}`, issuedAt: date,
    expectedSequence: board.sequence, fact: draft.value });
  if (!result.ok) assert.fail(JSON.stringify(result));

  return result.state;
}

function fixture(resourceModel: boolean): CentralPursuitInput {
  const candidate = current(resourceModel);
  let board = act(emptyBoardState(), { kind: "report", scope, issueId: "issue:current", problemKey: "problem:current", report: {
    reportId: "report:current", source: { subsystem: "tool", taskId: "task:current", versionId: "source:v1" },
    facts: ["Synthetic independent episode prefix tests source capacity, not real provider efficacy"], evidenceRefs: ["source:current"] } });

  board = act(board, { kind: "decide", issueId: "issue:current", expectedRevision: 1, decision: "focused_learning",
    reason: "Current bounded stage", sourceRefs: ["source:current"] });
  board = act(board, { kind: "open_budget", expectedSequence: board.sequence, budget: { schemaVersion: 1, budgetId, scope,
    unit: "total_model_tokens", limits: { tokens: 100, calls: 1, steps: 1 }, authorizationRef: "host:root" } });

  for (let index = 0; index < 513; index++) board = appendObservation(board, candidate, index);

  return rebase({ schemaVersion: 1, board, candidates: [candidate], observations: [], horizon: 1,
    basis: { scope, budgetId, boardSequence: board.sequence, utilityUnit: "qualified_objective_completions", valuationRef: "value:source-prefix" } }, board);
}

function rebase(input: CentralPursuitInput, board: BoardState): CentralPursuitInput {
  const observed = readCentralPursuitObservations(board, scope);
  if (observed.status !== "ready") assert.fail(observed.reason);
  return { ...input, board, observations: observed.observations, basis: { ...input.basis, boardSequence: board.sequence } };
}

function decide(input: CentralPursuitInput) {
  const result = decideCentralLearningPursuit(input);
  if (result.status !== "decided") assert.fail(result.reason);
  if (result.nextStep.kind !== "fund_and_dispatch" || result.plan === null) assert.fail("current_stage_must_remain_decidable");
  return { result, prediction: result.evaluations[0]!.prediction, plan: result.plan };
}

function ready(result: CentralPursuitResourceModelResult) {
  if (result.status !== "ready") assert.fail(result.reason);
  return result;
}

function near(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`); }

test("513 canonical flat observations remain consumable by actual decisions and the next effective source update", () => {
  const input = fixture(false), first = decide(input);
  assert.equal(input.observations.length, 513);
  near(first.prediction.mean, 515 / 1028);
  near(first.plan.netPolicyValue, 515 / 1028);
  const next = decide(rebase(input, appendObservation(input.board, input.candidates[0]!, 514)));
  assert.equal(next.prediction.qualified, 258);
  near(next.prediction.mean, 517 / 1030);
  near(next.plan.netPolicyValue, 517 / 1030);
  assert.notEqual(next.result.decisionRef, first.result.decisionRef);
});

test("513 treatment observations retain their finite model and remain available to the next local Bayesian branch", () => {
  const input = fixture(true), first = decide(input), belief = first.prediction.resourceModel;
  if (belief === undefined) assert.fail("resource_belief_required");

  assert.equal(first.prediction.qualified + first.prediction.noResult, 513);
  assert.ok(Number.isFinite(belief.shared.logWeight));
  near(first.plan.netPolicyValue, first.prediction.mean);
  const next = decide(rebase(input, appendObservation(input.board, input.candidates[0]!, 514)));

  assert.equal(next.prediction.qualified + next.prediction.noResult, 514);
  const branch = ready(advanceCentralPursuitResourceModel(belief, { treatmentRef: belief.treatmentRef, outcome: 1 }));

  near(branch.mean, next.prediction.mean);
  near(branch.variance, next.prediction.variance);
});

test("more than 1024 finite treatment groups can advance a new treatment consistently with full replay", () => {
  const history: CentralPursuitResourceObservation[] = Array.from({ length: 1025 }, (_, index) => ({
    treatmentRef: `treatment:pending-${index}`, outcome: "pending" }));
  const fitted = ready(fitCentralPursuitResourceModel(history, "treatment:new"));

  assert.equal(fitted.belief.separate.groups.length, 1025);
  assert.equal(fitted.belief.pending.length, 1025);
  const advanced = ready(advanceCentralPursuitResourceModel(fitted.belief, { treatmentRef: "treatment:new", outcome: 1 }));
  const replayed = ready(fitCentralPursuitResourceModel([...history, { treatmentRef: "treatment:new", outcome: "qualified" }], "treatment:new"));

  assert.equal(advanced.belief.separate.groups.length, 1026);
  near(advanced.mean, 3 / 4);
  near(advanced.mean, replayed.mean);
  near(advanced.variance, replayed.variance);
  near(advanced.belief.shared.logWeight, replayed.belief.shared.logWeight);
  assert.equal(predictCentralPursuitResourceModel({ ...fitted.belief, pending: [
    { treatmentRef: "treatment:unsafe-a", count: Number.MAX_SAFE_INTEGER }, { treatmentRef: "treatment:unsafe-b", count: 1 }] }).status, "invalid");
});
