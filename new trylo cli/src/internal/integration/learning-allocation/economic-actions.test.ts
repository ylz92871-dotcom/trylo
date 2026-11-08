import assert from "node:assert/strict";
import test from "node:test";
import { reduce } from "../../learning/control/reducer.js";
import { emptyBoardState } from "../../learning/control/state.js";
import type { BoardState } from "../../learning/control/state.js";
import type { CoordinationAction } from "../../learning/control/coordination-contract.js";
import { centralBudgetProjection } from "../../learning/control/central-budget-state.js";
import { decideCentralLearning } from "../../learning/control/decision/decision-model.js";
import { buildCentralResponseForecast } from "../../learning/control/decision/prediction-model.js";
import { simulateCentralReconcile } from "../../learning/control/decision/reconcile-option.js";
import type { CentralDecisionInput } from "../../learning/control/decision/decision-contract.js";
import type { CentralPursuitCandidate } from "../../learning/control/decision/pursuit-contract.js";
import type { CentralResponseHistory } from "../../learning/control/decision/prediction-input.js";
import { chooseCentralEconomicStep } from "./economic-actions.js";

const scope = "workspace:economic-actions", budgetId = "budget:economic-actions", date = "2026-11-04T15:00:00.000Z";

function act(board: BoardState, action: CoordinationAction): BoardState {
  const result = reduce(board, { type: "coordinate_learning", commandId: `economic:${board.sequence}:${action.kind}`, issuedAt: date, action });
  if (!result.ok) assert.fail(JSON.stringify(result));
  return result.state;
}

function fixture(valuesA = [1, 3], valuesB = [0, 2], tokens = 100) {
  let board = emptyBoardState();
  const originals: CentralPursuitCandidate[] = ["A", "B"].map(id => {
    const domain = id === "A" ? "tool" as const : "skill" as const;

    board = act(board, { kind: "report", scope, issueId: `issue:${id}`, problemKey: `problem:${id}`, report: {
      reportId: `report:${id}`, source: { subsystem: domain, taskId: `task:${id}`, versionId: `source:${id}` },
      facts: ["Declared real source stage for this synthetic contract"], evidenceRefs: [`source:${id}`] } });
    board = act(board, { kind: "decide", issueId: `issue:${id}`, expectedRevision: 1, decision: "focused_learning",
      reason: "Explicit contract source focus", sourceRefs: [`source:${id}`] });

    return { opportunity: { opportunityId: `opportunity:${id}`, scope, targetRef: "target:economic-window", instanceRef: `stage:${id}`,
      sourceRef: `source:${id}`, stage: "initial", conditionRef: "condition:fixed", baselineRef: `baseline:${id}`, windowRef: "window:fixed",
      offer: { offerId: `offer:${id}`, owner: { plane: "agent", domain }, policyRef: `policy:${id}`,
        reserve: { tokens: 100, calls: 2, steps: 2 }, maxPromptChars: 1000 } },
      source: { issueId: `issue:${id}`, grantId: `grant:${id}`, sourceBindingRef: `binding:${id}`, domainStage: {
        stageRef: `stage:${id}`, kind: "initial", policyRef: `policy:${id}`, sourceReportId: `report:${id}`,
        readiness: { kind: "ready", evidenceRefs: [`source:${id}`] } } },
      readiness: { kind: "ready", sourceRef: "business:confirmed", now: 100, nextHandoff: null },
      target: { kind: "boundary-independent", sourceRef: "objective:fixed-window" },
      fee: { kind: "hard-budget-only", sourceRef: "objective:hard-cap-only" }, purpose: "focused_learning",
      objective: { instanceId: `objective:${id}`, criterion: "checker_verified", definitionRef: "criterion:check",
        familyRef: `family:${id}`, familySourceRef: `source:family-${id}` } };
  });

  board = act(board, { kind: "open_budget", expectedSequence: board.sequence, budget: { schemaVersion: 1, budgetId, scope,
    unit: "total_model_tokens", limits: { tokens, calls: 8, steps: 8 }, authorizationRef: "host:economic-root" } });
  const history: CentralResponseHistory[] = originals.flatMap((candidate, i) => (i === 0 ? valuesA : valuesB).map((value, j) => ({
    ...candidate.opportunity, instanceRef: `past-stage:${i}:${j}`, unitId: `past-unit:${i}:${j}`, sequence: j + 1,
    revisionRef: `revision:${i}:${j}`, outcome: { kind: "paired_window", candidateUtility: value, baselineUtility: 0 } })));
  const input: CentralDecisionInput = { schemaVersion: 1, board, candidates: originals.map(row => ({ opportunityId: row.opportunity.opportunityId,
    source: row.source, readiness: row.readiness, target: row.target, fee: row.fee })), prediction: { basis: { scope,
      boardSequence: board.sequence, budgetId, utilityUnit: "economic:window-effect", valuationRef: "value:paired-source" },
    target: { key: "target:economic-window", estimand: "learning_policy_response", utilityUnit: "economic:window-effect", referenceKey: "population:fixed-window",
      baselineRuleKey: "baseline:no-new-learning", windowRef: "window:fixed" }, opportunities: originals.map(row => row.opportunity), history,
    limits: { maxObservations: 32, maxQueries: 8, maxLatentDimension: 8, maxComponents: 1 } } };

  return { input, originals };
}

function withBoard(input: CentralDecisionInput, board: BoardState): CentralDecisionInput {
  return { ...input, board, prediction: { ...input.prediction, basis: { ...input.prediction.basis, boardSequence: board.sequence } } };
}

function fundA(input: CentralDecisionInput): BoardState {
  const issue = input.board.learningIssues?.find(row => row.issueId === "issue:A");
  assert.ok(issue);
  return act(input.board, { kind: "fund", issueId: issue.issueId, expectedRevision: issue.revision, grantId: "grant:A", domain: "tool",
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 100, maxCalls: 2, maxSteps: 2, maxPromptChars: 1000 },
    budgetId, authorizationRef: "host:economic-stage", planRef: "plan:economic-fixture", expectedSequence: input.board.sequence });
}

function choose(input: CentralDecisionInput, originals: readonly CentralPursuitCandidate[]) {
  const decision = decideCentralLearning(input, buildCentralResponseForecast);
  if (decision.status !== "decided") assert.fail(decision.reason);
  const result = chooseCentralEconomicStep(input, decision, originals, buildCentralResponseForecast);
  if (result.status !== "ready") assert.fail(result.reason);
  return result;
}

test("conditional reconciliation is pure and releases only canonical unused commitment", () => {
  const { input } = fixture(), board = fundA(input), original = JSON.stringify(board);
  const simulated = simulateCentralReconcile(board, budgetId, "grant:A");
  if (simulated.status !== "ready") assert.fail(simulated.reason);

  assert.equal(centralBudgetProjection(board, budgetId)?.available.tokens, 0);
  assert.equal(simulated.projection.available.tokens, 100);
  assert.equal(simulated.board.sequence, board.sequence + 1);
  assert.equal(JSON.stringify(board), original);
  assert.equal(simulateCentralReconcile(simulated.board, budgetId, "grant:A").status, "unavailable");
});

test("an in-flight grant cannot release and an unknown settled bill retains its full charge", () => {
  const { input } = fixture();
  let board = fundA(input);
  const job = board.jobs.find(row => row.coordination?.grantId === "grant:A")!;

  board = act(board, { kind: "claim", jobId: job.jobId, expectedAttempt: job.attempt, claimId: "claim:A",
    ownerId: "worker:A", expiresAt: "2026-11-04T15:10:00.000Z" });
  assert.equal(simulateCentralReconcile(board, budgetId, "grant:A").status, "unavailable");
  board = act(board, { kind: "reserve", grantId: "grant:A", claimId: "claim:A", reservationId: "reservation:A", maxTokens: 50 });
  board = act(board, { kind: "settle", grantId: "grant:A", reservationId: "reservation:A", usage: { kind: "unknown", reason: "usage_tail_missing" } });
  board = act(board, { kind: "finish", jobId: job.jobId, claimId: "claim:A", result: { kind: "yielded", reason: "confirmed_boundary" } });
  const simulated = simulateCentralReconcile(board, budgetId, "grant:A");
  if (simulated.status !== "ready") assert.fail(simulated.reason);

  const grant = simulated.board.centralLearningGrants?.find(row => row.grantId === "grant:A");

  assert.equal(grant?.allowance.maxTokens, 50);
  assert.equal(grant?.allowance.maxCalls, 1);
  assert.equal(simulated.projection.available.tokens, 50);
});

test("economic new funding retains the original application and actual candidate mapping", () => {
  const { input, originals } = fixture([0, 2], [1, 3], 200), result = choose(input, originals);
  assert.equal(result.nextStep.kind, "fund_and_dispatch");
  if (result.nextStep.kind !== "fund_and_dispatch") assert.fail("new_funding_required");
  assert.equal(result.nextStep.evaluation.candidate, originals[1]);
  assert.ok(result.nextStep.application);
  assert.equal(result.options[0]?.value, 2);
});

test("covered economic response uses its actual expected effect even when the root has no free tokens", () => {
  const { input, originals } = fixture([1, 3], [0, 2]), current = withBoard(input, fundA(input)), result = choose(current, originals);
  assert.equal(result.nextStep.kind, "dispatch_existing");
  if (result.nextStep.kind !== "dispatch_existing") assert.fail("covered_dispatch_required");
  assert.equal(result.nextStep.evaluation.candidate.opportunity.opportunityId, "opportunity:A");
  assert.equal(result.nextStep.application, null);
  assert.equal(result.options.find(row => row.kind === "covered_prefix")?.value, 2);
});

test("a better economic alternative requires real reconciliation instead of predicted free money", () => {
  const { input, originals } = fixture([-2, 0], [1, 3]), current = withBoard(input, fundA(input)), original = JSON.stringify(current.board);
  const result = choose(current, originals);
  assert.equal(result.nextStep.kind, "reconcile_then_replan");
  assert.equal(result.options.find(row => row.kind === "conditional_reconcile")?.value, 2);
  assert.equal(centralBudgetProjection(current.board, budgetId)?.available.tokens, 0);
  assert.equal(JSON.stringify(current.board), original);
});

test("known nonpositive continuation can end only at a quiet boundary without unresolved competitors", () => {
  const { input, originals } = fixture([-2, 0], [-3, -1]), current = withBoard(input, fundA(input));

  assert.equal(choose(current, originals).nextStep.kind, "end_investment");
  const missing = { ...current, prediction: { ...current.prediction, history: current.prediction.history.filter(row => row.offer.offerId !== "offer:B") } };

  assert.equal(choose(missing, originals).nextStep.kind, "wait");
  const job = current.board.jobs.find(row => row.coordination?.grantId === "grant:A")!;
  const board = act(current.board, { kind: "claim", jobId: job.jobId, expectedAttempt: job.attempt, claimId: "claim:active",
    ownerId: "worker:active", expiresAt: "2026-11-04T15:10:00.000Z" });

  assert.equal(choose(withBoard(current, board), originals).nextStep.kind, "wait");
});
