import assert from "node:assert/strict";
import test from "node:test";
import { reduce } from "../reducer.js";
import { emptyBoardState } from "../state.js";
import type { BoardState } from "../state.js";
import type { CentralLearningAgentDomain, CoordinationAction } from "../coordination-contract.js";
import { prepareAllocationApplication } from "../allocation-application-plan.js";
import { allocationAuditCommand } from "../allocation-application-state.js";
import { centralBudgetProjection } from "../central-budget-state.js";
import { decideCentralLearning } from "./decision-model.js";
import type { CentralDecisionCandidate, CentralDecisionInput } from "./decision-contract.js";
import type { CentralResponseHistory, CentralResponseOpportunity } from "./prediction-input.js";

const date = "2026-11-04T12:00:00.000Z";
const resources = (tokens: number, calls = 1) => ({ tokens, calls, steps: calls });
const scope = "workspace:central-decision-contract";
const budgetId = "budget:decision-contract";

// Synthetic paired-window labels exercise the composition; they are not real product benefit evidence.
function fixture(domains: readonly CentralLearningAgentDomain[] = ["tool", "workflow"], tokens = 1000): CentralDecisionInput {
  let board = emptyBoardState();
  const act = (action: CoordinationAction) => {
    const next = reduce(board, { type: "coordinate_learning", commandId: `setup:${board.sequence}`,
      issuedAt: date, action });
    assert.equal(next.ok, true);
    board = next.state;
  };

  for (const domain of domains) {
    const source = domain === "collaboration" ? { teamRunId: "team:contract", taskId: "task:contract", memberId: "member:contract" }
      : { subsystem: domain === "prompt" ? "method" as const : domain, taskId: "task:contract", versionId: `source:${domain}` };
    act({ kind: "report", scope, issueId: `issue:${domain}`, problemKey: `problem:${domain}`,
      report: { reportId: `report:${domain}`, source, facts: ["Synthetic bounded domain macro-stage"], evidenceRefs: [`source:${domain}`] } });
    act({ kind: "decide", issueId: `issue:${domain}`, expectedRevision: 1,
      decision: "focused_learning", reason: "Contract-only focused source", sourceRefs: [`source:${domain}`] });
  }

  act({ kind: "open_budget", expectedSequence: board.sequence, budget: { schemaVersion: 1, budgetId, scope,
    unit: "total_model_tokens", limits: resources(tokens, 8), authorizationRef: "host:contract-root" } });
  const opportunities: CentralResponseOpportunity[] = domains.map(domain => ({ opportunityId: `opportunity:${domain}`,
    scope, targetRef: "target:fixed-window", instanceRef: `stage:${domain}:initial`, sourceRef: `source:${domain}`,
    stage: "initial", conditionRef: "condition:contract-matched", baselineRef: `baseline:${domain}`,
    windowRef: "window:fixed-contract", offer: { offerId: `offer:${domain}`, owner: { plane: "agent", domain },
      policyRef: `policy:${domain}:v1`, reserve: resources(600), maxPromptChars: 1000 } }));
  const history = opportunities.flatMap((opportunity, index) => measurements(opportunity, index === 0 ? [.2, .4] : [.5, .7]));
  const candidates: CentralDecisionCandidate[] = opportunities.map(opportunity => {
    assert.equal(opportunity.offer.owner.plane, "agent");
    const domain = opportunity.offer.owner.plane === "agent" ? opportunity.offer.owner.domain : "user";

    return { opportunityId: opportunity.opportunityId,
      source: { issueId: `issue:${domain}`, grantId: `grant:${domain}`, sourceBindingRef: `source-binding:${domain}`,
        domainStage: { stageRef: `stage:${domain}:initial`, kind: "initial", policyRef: opportunity.offer.policyRef,
          sourceReportId: `report:${domain}`, readiness: { kind: "ready", evidenceRefs: [opportunity.sourceRef] } } },
      readiness: { kind: "ready", sourceRef: "business:idle-boundary", now: 100, nextHandoff: null },
      target: { kind: "boundary-independent", sourceRef: "objective:contract-fixed-start-family" },
      fee: { kind: "hard-budget-only", sourceRef: "objective:resources-as-hard-caps" } };
  });

  return { schemaVersion: 1, board, candidates, prediction: {
    basis: { scope, boardSequence: board.sequence, budgetId, utilityUnit: "fixed-window-success-difference", valuationRef: "input:contract" },
    target: { key: "target:fixed-window", estimand: "learning_policy_response", utilityUnit: "fixed-window-success-difference", referenceKey: "reference:idle",
      baselineRuleKey: "rule:no-new-learning", windowRef: "window:fixed-contract" },
    opportunities, history, limits: { maxObservations: 32, maxLatentDimension: 8, maxQueries: 8, maxComponents: 1 } } };
}

function measurements(opportunity: CentralResponseOpportunity, values: readonly number[], offset = 0): CentralResponseHistory[] {
  return values.map((value, index) => ({ ...opportunity, unitId: `unit:${opportunity.opportunityId}:${index + offset}`,
    instanceRef: `past:${opportunity.opportunityId}:${index + offset}`, sequence: index + 1,
    revisionRef: `revision:${index + offset}`, sourceRef: `paired-window:${opportunity.opportunityId}:${index + offset}`,
    outcome: { kind: "paired_window", candidateUtility: value, baselineUtility: 0 } }));
}

function decided(input: CentralDecisionInput) {
  const result = decideCentralLearning(input);
  assert.equal(result.status, "decided", JSON.stringify(result));
  return result;
}

test("a deployed-condition response cannot fund a whole learning policy through the direct decision API", () => {
  const input = fixture(), { estimand: _estimand, ...legacyTarget } = input.prediction.target;
  for (const target of [legacyTarget, { ...legacyTarget, estimand: "deployment_response" as const }]) {
    assert.deepEqual(decideCentralLearning({ ...input, prediction: { ...input.prediction, target } }), {
      status: "rejected", reason: "central_decision_learning_policy_estimand_required" });
  }
});

test("updated posterior changes the actual timing/allocation winner, not just a diagnostic forecast", () => {
  const input = fixture(), first = decided(input);

  assert.equal(first.recommendation, "now");
  assert.equal(first.selected?.opportunityId, "opportunity:workflow");
  assert.ok(first.selected?.timing?.status === "ready" && first.selected.timing.analysis?.status === "analyzed");
  const tool = input.prediction.opportunities[0]!;
  const next = decided({ ...input, prediction: { ...input.prediction,
    history: [...input.prediction.history, ...measurements(tool, [1.8], 2)] } });

  assert.equal(next.selected?.opportunityId, "opportunity:tool");
  assert.ok(Math.abs(next.selected!.query!.mean - .8) < 1e-12);
  assert.notEqual(first.decisionRef, next.decisionRef);
  assert.ok(next.application);
});

test("deferred program competes for the same resources and never creates a current application", () => {
  const input = fixture();
  const candidates = input.candidates.map((row, index): CentralDecisionCandidate => index === 1 ? { ...row,
    readiness: { kind: "ready", sourceRef: "business:work-active", now: 100,
      nextHandoff: { at: 200, sourceRef: "business:known-handoff" } },
    fee: { kind: "utility", sourceRef: "objective:measured-business-interference", now: .5, atHandoff: 0 } } : row);
  const result = decided({ ...input, candidates });

  assert.equal(result.recommendation, "defer");
  assert.equal(result.selected?.opportunityId, "opportunity:workflow");
  assert.equal(result.application, null);
  assert.equal(result.plan.decision.kind, "offer");
});

test("the selected numerical plan binds real source/revision/resources and is accepted by the original funding application", () => {
  const input = fixture(), result = decided(input), selected = result.selected!;

  assert.ok(result.application);
  assert.equal(selected.stage.status, "ready");

  if (selected.stage.status !== "ready") throw new Error("stage_not_ready");

  const offer = selected.query!.offer;
  const prepared = prepareAllocationApplication({ ...result.application,
    authorizationRef: "host:independent-authorization",
    bindingsJson: JSON.stringify([{ offerId: offer.offerId,
      offerHash: result.plan.decision.kind === "offer" ? result.plan.decision.offerHash : "",
      policyRef: offer.policyRef, sourceBindingRef: selected.stage.sourceBindingRef,
      authorizedAllowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 5000,
        maxCalls: 8, maxSteps: 8, maxPromptChars: 1000 }, issueId: selected.stage.issueId,
      expectedIssueRevision: selected.stage.expectedIssueRevision, grantId: selected.stage.grantId,
      mode: selected.stage.mode, chargedAtBasis: selected.stage.chargedAtBasis }]) });

  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  let board: BoardState = input.board;
  const audit = reduce(board, allocationAuditCommand(prepared.prepared, date));

  assert.equal(audit.ok, true, JSON.stringify(audit));
  board = audit.state;

  for (const draft of prepared.prepared.drafts) {
    const funded = reduce(board, { ...draft, issuedAt: date });
    assert.equal(funded.ok, true, JSON.stringify(funded));
    board = funded.state;
  }

  assert.equal(board.centralLearningGrants?.length, 1);
  assert.equal(board.centralLearningGrants?.[0]?.domain, "workflow");
  assert.equal(centralBudgetProjection(board, budgetId)?.occupied.tokens, 600);
});

test("missing comparison history is explicit and never becomes a fabricated zero-value bid", () => {
  const input = fixture(), result = decided({ ...input, prediction: { ...input.prediction, history: [] } });
  assert.equal(result.recommendation, "wait_evidence");
  assert.equal(result.forecast.queries.length, 0);
  assert.equal(result.requirements.filter(row => row.reason === "paired_history_missing").length, 2);
  assert.equal(result.application, null);
});

test("negative future gross stops new investment without changing the issue's resolved state", () => {
  const input = fixture();
  const result = decided({ ...input, prediction: { ...input.prediction,
    history: input.prediction.opportunities.flatMap(row => measurements(row, [-.6, -.4])) } });
  assert.equal(result.recommendation, "stop");
  assert.equal(result.application, null);
  assert.ok(input.board.learningIssues?.every(issue => issue.decision.kind === "focused_learning"));
});

test("unknown completion timing requires evidence rather than making a false late-zero forecast", () => {
  const input = fixture(["tool"]), candidate = input.candidates[0]!;
  const result = decided({ ...input, candidates: [{ ...candidate, target: { kind: "deadline",
    sourceRef: "requirement:actual-use-by", useBy: 150, durationUpperBound: 100,
    durationSourceRef: "domain:upper-duration-receipt" } }] });
  assert.equal(result.recommendation, "wait_evidence");
  assert.ok(result.requirements.some(row => row.reason === "timely_completion_not_bounded"));
});

test("basis drift, domain mismatch and invalid provider envelopes fail before a funding application", () => {
  const input = fixture();

  assert.deepEqual(decideCentralLearning({ ...input, board: { ...input.board, sequence: input.board.sequence + 1 } }),
    { status: "rejected", reason: "central_decision_stale_basis" });
  const candidate = input.candidates[0]!;
  const mismatch = decided({ ...input, candidates: [{ ...candidate,
    source: { ...candidate.source, domainStage: { ...candidate.source.domainStage, sourceReportId: "report:workflow" } } }, input.candidates[1]!] });

  assert.equal(mismatch.evaluations[0]?.stage.status, "needs_source");
  const opportunity = input.prediction.opportunities[0]!;
  const invalid = decideCentralLearning({ ...input, prediction: { ...input.prediction,
    opportunities: [{ ...opportunity, offer: { ...opportunity.offer, reserve: resources(0, 0) } }, input.prediction.opportunities[1]!] } });

  assert.deepEqual(invalid, { status: "rejected", reason: "central_decision_provider_envelope_required" });
});

test("real depth envelopes compete as physical resources, without converting local quota numbers into money", () => {
  const depthInput = (tokens: number): CentralDecisionInput => {
    const input = fixture(["tool"], tokens), original = input.prediction.opportunities[0]!;
    const opportunities = [200, 800].map((reserve, index): CentralResponseOpportunity => ({ ...original,
      opportunityId: `depth:${index}`, offer: { ...original.offer, offerId: `depth-offer:${index}`, reserve: resources(reserve) } }));
    return { ...input, prediction: { ...input.prediction, opportunities,
      history: opportunities.flatMap((opportunity, index) => measurements(opportunity, index === 0 ? [.1, .3] : [.7, .9])) },
      candidates: opportunities.map(opportunity => ({ ...input.candidates[0]!, opportunityId: opportunity.opportunityId })) };
  };

  assert.equal(decided(depthInput(1000)).selected?.query?.offer.reserve.tokens, 800);
  const constrained = decided(depthInput(400));

  assert.equal(constrained.selected?.query?.offer.reserve.tokens, 200);
  assert.ok(constrained.requirements.some(row => row.reason === "current_resources_insufficient"));
});

test("a prediction for another macro-stage instance cannot finance this execution stage", () => {
  const input = fixture(), candidate = input.candidates[0]!;
  assert.deepEqual(decideCentralLearning({ ...input, candidates: [{ ...candidate, source: { ...candidate.source,
    domainStage: { ...candidate.source.domainStage, stageRef: "another-execution-stage" } } }, input.candidates[1]!] }),
  { status: "rejected", reason: "central_decision_candidate_binding" });
});
