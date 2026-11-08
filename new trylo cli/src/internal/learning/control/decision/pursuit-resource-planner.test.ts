import assert from "node:assert/strict";
import test from "node:test";
import { reduce } from "../reducer.js";
import { emptyBoardState, type BoardState } from "../state.js";
import type { CoordinationAction } from "../coordination-contract.js";
import { readSequentialAllocation } from "../sequential-allocation-read.js";
import { planSequentialAllocation } from "../sequential-allocation.js";
import { createCentralPursuitObservationDraft, readCentralPursuitObservations } from "../../../integration/learning-allocation/pursuit-observations.js";
import { decideCentralLearningPursuit } from "./pursuit-model.js";
import { centralPursuitTreatmentRef } from "./pursuit-resource-model.js";
import type { CentralPursuitCandidate, CentralPursuitInput } from "./pursuit-contract.js";

const scope = "workspace:pursuit-resource-planner", budgetId = "budget:resource-planner", date = "2026-11-04T15:00:00.000Z";
const resources = (tokens: number, calls = 1) => ({ tokens, calls, steps: calls });

function act(board: BoardState, action: CoordinationAction): BoardState {
  const result = reduce(board, { type: "coordinate_learning", commandId: `resource:${board.sequence}`, issuedAt: date, action });
  if (!result.ok) assert.fail(JSON.stringify(result));
  return result.state;
}

function candidate(id: string, tokens: number, resourceModel: boolean, otherFamily = false): CentralPursuitCandidate {
  const policyRef = otherFamily ? "policy:independent-c" : "policy:resource-protocol";
  return { opportunity: { opportunityId: `opportunity:${id}`, scope, targetRef: "target:qualified-objective",
    instanceRef: `stage:${id}`, sourceRef: `source:${id}`, stage: "initial", conditionRef: "condition:stable-protocol",
    baselineRef: `baseline:${id}`, windowRef: "window:real-backlog", offer: { offerId: `offer:${id}`,
      owner: { plane: "agent", domain: otherFamily ? "skill" : "tool" }, policyRef, reserve: resources(tokens), maxPromptChars: 1000 } },
    source: { issueId: `issue:${id}`, grantId: `grant:${id}`, sourceBindingRef: `binding:${id}`, domainStage: {
      stageRef: `stage:${id}`, kind: "initial", policyRef, sourceReportId: `report:${id}`,
      readiness: { kind: "ready", evidenceRefs: [`source:${id}`] } } },
    readiness: { kind: "ready", sourceRef: "business:confirmed", now: 100, nextHandoff: null },
    target: { kind: "boundary-independent", sourceRef: "source:fixed-backlog-context" },
    fee: { kind: "hard-budget-only", sourceRef: "source:hard-budget" }, purpose: "focused_learning",
    objective: { instanceId: `objective:${id}`, criterion: "checker_verified", definitionRef: "criterion:external-check-v1",
      familyRef: otherFamily ? "family:independent-c" : "family:resource-response",
      familySourceRef: otherFamily ? "source:independent-c" : "source:stable-resource-family",
      ...(!otherFamily && resourceModel ? { resourceModel: { kind: "shared_or_exact_treatment" as const,
        sourceRef: "source:resource-response-model-class" } } : {}) } };
}

function focus(board: BoardState, current: CentralPursuitCandidate): BoardState {
  const owner = current.opportunity.offer.owner;
  if (owner.plane !== "agent" || (owner.domain !== "tool" && owner.domain !== "skill")) assert.fail("fixture_owner");

  const id = current.source.issueId;

  board = act(board, { kind: "report", scope, issueId: id, problemKey: `problem:${id}`, report: {
    reportId: current.source.domainStage.sourceReportId, source: { subsystem: owner.domain, taskId: `task:${id}`, versionId: "source:v1" },
    facts: ["Synthetic contract uses a real Board/source/offer, not measured production efficacy"], evidenceRefs: [current.opportunity.sourceRef] } });

  return act(board, { kind: "decide", issueId: id, expectedRevision: 1, decision: "focused_learning",
    reason: "Declared independent objective episode", sourceRefs: [current.opportunity.sourceRef] });
}

function fund(board: BoardState, current: CentralPursuitCandidate, managed = false): BoardState {
  const issue = board.learningIssues?.find(row => row.issueId === current.source.issueId), owner = current.opportunity.offer.owner;
  if (issue === undefined || owner.plane !== "agent") assert.fail("fixture_source");

  const reserve = current.opportunity.offer.reserve;

  return act(board, { kind: "fund", issueId: issue.issueId, expectedRevision: issue.revision, grantId: current.source.grantId,
    domain: owner.domain, allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: reserve.tokens,
      maxCalls: reserve.calls, maxSteps: reserve.steps, maxPromptChars: current.opportunity.offer.maxPromptChars },
    ...(managed ? { budgetId, expectedSequence: board.sequence, authorizationRef: "host:resource-stage", planRef: "plan:resource-stage" } : {}) });
}

function fixture(ids: readonly string[], tokens: number, horizon: number, resourceModel = true): CentralPursuitInput {
  let board = emptyBoardState();

  for (const [id, amount, outcome] of [["pastA", 200, "qualified"], ["pastB", 100, "closed_no_result"]] as const) {
    const past = candidate(id, amount, resourceModel);

    board = fund(focus(board, past), past);
    const draft = createCentralPursuitObservationDraft({ unitId: `episode:${id}`, scope, conditionRef: past.opportunity.conditionRef,
      objective: past.objective, grantId: past.source.grantId, stageRef: past.source.domainStage.stageRef,
      sourceRef: `checker:${id}`, revisionRef: `revision:${id}`, outcome,
      ...(resourceModel ? { treatmentRef: centralPursuitTreatmentRef(past.opportunity.offer) } : {}) });
    if (draft.status !== "ready") assert.fail(draft.reason);

    const result = reduce(board, { type: "record_reward_v2_fact", commandId: `observe:${id}`, issuedAt: date,
      expectedSequence: board.sequence, fact: draft.value });
    if (!result.ok) assert.fail(JSON.stringify(result));

    board = result.state;
  }

  const candidates = ids.map(id => candidate(id, id === "B" ? 100 : 200, resourceModel, id === "C"));

  for (const current of candidates) board = focus(board, current);

  board = act(board, { kind: "open_budget", expectedSequence: board.sequence, budget: { schemaVersion: 1, budgetId, scope,
    unit: "total_model_tokens", limits: resources(tokens, 8), authorizationRef: "host:resource-root" } });
  const observed = readCentralPursuitObservations(board, scope);
  if (observed.status !== "ready") assert.fail(observed.reason);

  return { schemaVersion: 1, board, candidates, observations: observed.observations, horizon,
    basis: { scope, boardSequence: board.sequence, budgetId, utilityUnit: "qualified_objective_completions", valuationRef: "source:resource-backlog" } };
}

function decide(input: CentralPursuitInput) {
  const result = decideCentralLearningPursuit(input);
  if (result.status !== "decided") assert.fail(result.reason);
  return result;
}

function near(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`); }

test("learned resource hypotheses change the actual selected cap and funded value, beyond fit diagnostics", () => {
  const input = fixture(["B", "A1"], 200, 1), before = JSON.stringify(input), result = decide(input);

  assert.equal(result.nextStep.kind, "fund_and_dispatch");

  if (result.nextStep.kind !== "fund_and_dispatch" || result.plan === null) assert.fail("funded_plan_required");

  assert.equal(result.nextStep.evaluation.candidate.opportunity.opportunityId, "opportunity:A1");
  assert.equal(result.nextStep.evaluation.candidate.opportunity.offer.reserve.tokens, 200);
  near(result.plan.netPolicyValue, 2 / 3);
  near(Math.exp(result.evaluations[1]!.prediction.resourceModel!.shared.logWeight), 1 / 3);
  const flat = decide(fixture(["B", "A1"], 200, 1, false));
  if (flat.nextStep.kind !== "fund_and_dispatch" || flat.plan === null) assert.fail("flat_plan_required");

  assert.equal(flat.nextStep.evaluation.candidate.opportunity.opportunityId, "opportunity:B");
  near(flat.plan.netPolicyValue, 1 / 2);
  assert.equal(JSON.stringify(input), before);
});

test("local Bellman feedback updates the observed treatment and H weights before choosing the next real objective", () => {
  const input = fixture(["A1", "A2", "B", "C"], 400, 2), result = decide(input);
  if (result.nextStep.kind !== "fund_and_dispatch" || result.nextStep.application === null || result.plan === null) assert.fail("application_required");

  assert.equal(result.nextStep.evaluation.candidate.opportunity.opportunityId, "opportunity:A1");
  near(result.plan.netPolicyValue, 65 / 48);
  const request = readSequentialAllocation(result.nextStep.application.proposalJson);
  if (request === undefined) assert.fail("canonical_request_required");

  const root = request.states.find(row => row.stateId === request.initialStateId)!;
  const first = root.offers.find(row => row.offer.offerId === "offer:A1")!;

  near(first.outcomes[0]!.probability, 2 / 3);

  for (const [outcome, aRate, bRate, winner] of [[0, 25 / 32, 11 / 32, "offer:A2"], [1, 7 / 16, 5 / 16, "offer:C"]] as const) {
    const nextStateId = first.outcomes[outcome]!.nextStateId, state = request.states.find(row => row.stateId === nextStateId)!;
    near(state.offers.find(row => row.offer.offerId === "offer:A2")!.outcomes[0]!.probability, aRate);
    near(state.offers.find(row => row.offer.offerId === "offer:B")!.outcomes[0]!.probability, bRate);
    const child = planSequentialAllocation(JSON.stringify({ ...request, initialStateId: nextStateId, remaining: resources(200, 7), horizon: 1 }));
    if (child.status !== "planned" || child.plan.decision.kind !== "offer") assert.fail("child_offer_required");
    assert.equal(child.plan.decision.offer.offerId, winner);
  }

  assert.equal(input.observations.length, 2);
  assert.equal(input.board.rewardV2Facts?.length, 2);
});

test("a covered resource-sensitive prefix retains the same 65/48 value without recharging its grant", () => {
  const input = fixture(["A1", "A2", "B", "C"], 400, 2), first = input.candidates[0]!;
  const board = fund(input.board, first, true), result = decide({ ...input, board,
    basis: { ...input.basis, boardSequence: board.sequence } });

  assert.equal(result.remaining.tokens, 200);
  assert.equal(result.nextStep.kind, "dispatch_existing");

  if (result.nextStep.kind !== "dispatch_existing") assert.fail("covered_prefix_required");

  assert.equal(result.nextStep.evaluation.candidate.opportunity.opportunityId, "opportunity:A1");
  assert.equal(result.nextStep.application, null);
  near(result.options.find(row => row.kind === "covered_prefix" && row.grantId === first.source.grantId)!.value, 65 / 48);
});
