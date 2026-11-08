import assert from "node:assert/strict";
import test from "node:test";
import { reduce } from "../reducer.js";
import { emptyBoardState } from "../state.js";
import type { BoardState } from "../state.js";
import type { CentralLearningAgentDomain, CoordinationAction } from "../coordination-contract.js";
import { centralBudgetProjection } from "../central-budget-state.js";
import { prepareAllocationApplication } from "../allocation-application-plan.js";
import { allocationAuditCommand } from "../allocation-application-state.js";
import { createCentralPursuitObservationDraft, readCentralPursuitObservations } from "../../../integration/learning-allocation/pursuit-observations.js";
import { decideCentralLearningPursuit } from "./pursuit-model.js";
import type { CentralPursuitCandidate, CentralPursuitInput, CentralPursuitObservation, CentralPursuitResult } from "./pursuit-contract.js";

const date = "2026-11-04T15:00:00.000Z", scope = "workspace:pursuit-model", budgetId = "budget:pursuit-model";
const resources = (tokens: number, calls = 1) => ({ tokens, calls, steps: calls });

type Spec = { readonly id: string; readonly domain: CentralLearningAgentDomain; readonly family: string; readonly tokens?: number; readonly fee?: number };

function act(board: BoardState, action: CoordinationAction): BoardState {
  const next = reduce(board, { type: "coordinate_learning", commandId: `contract:${board.sequence}:${action.kind}`, issuedAt: date, action });
  if (!next.ok) assert.fail(JSON.stringify(next));
  return next.state;
}

function fixture(specs: readonly Spec[], tokens = 200, horizon = 1): CentralPursuitInput {
  let board = emptyBoardState();
  const candidates: CentralPursuitCandidate[] = specs.map(spec => {
    const source = spec.domain === "collaboration" ? { teamRunId: `team:${spec.id}`, taskId: `task:${spec.id}`, memberId: `member:${spec.id}` }
      : { subsystem: spec.domain === "prompt" ? "method" as const : spec.domain, taskId: `task:${spec.id}`, versionId: `source:${spec.id}` };

    board = act(board, { kind: "report", scope, issueId: `issue:${spec.id}`, problemKey: `problem:${spec.id}`,
      report: { reportId: `report:${spec.id}`, source, facts: ["Declared bounded stage for this synthetic contract"], evidenceRefs: [`source:${spec.id}`] } });
    board = act(board, { kind: "decide", issueId: `issue:${spec.id}`, expectedRevision: 1,
      decision: "focused_learning", reason: "Explicit contract objective", sourceRefs: [`source:${spec.id}`] });

    return { opportunity: { opportunityId: `opportunity:${spec.id}`, scope, targetRef: "target:qualified-objective",
      instanceRef: `stage:${spec.id}`, sourceRef: `source:${spec.id}`, stage: "initial", conditionRef: "condition:contract",
      baselineRef: `baseline:${spec.id}`, windowRef: "window:objective-stage", offer: { offerId: `offer:${spec.id}`,
        owner: { plane: "agent", domain: spec.domain }, policyRef: `policy:${spec.id}`,
        reserve: resources(spec.tokens ?? 100), maxPromptChars: 1000 } },
      source: { issueId: `issue:${spec.id}`, grantId: `grant:${spec.id}`, sourceBindingRef: `binding:${spec.id}`,
        domainStage: { stageRef: `stage:${spec.id}`, kind: "initial", policyRef: `policy:${spec.id}`,
          sourceReportId: `report:${spec.id}`, readiness: { kind: "ready", evidenceRefs: [`source:${spec.id}`] } } },
      readiness: { kind: "ready", sourceRef: "business:confirmed-boundary", now: 100, nextHandoff: null },
      target: { kind: "boundary-independent", sourceRef: "objective:fixed-backlog-window" },
      fee: spec.fee === undefined ? { kind: "hard-budget-only", sourceRef: "objective:hard-resource-cap" }
        : { kind: "utility", sourceRef: "objective:declared-interference-fee", now: spec.fee, atHandoff: spec.fee },
      purpose: "focused_learning", objective: { instanceId: `objective:${spec.id}`, criterion: "checker_verified",
        definitionRef: "criterion:external-check-v1", familyRef: `family:${spec.family}`, familySourceRef: `protocol:${spec.family}` } };
  });

  board = act(board, { kind: "open_budget", expectedSequence: board.sequence, budget: { schemaVersion: 1, budgetId, scope,
    unit: "total_model_tokens", limits: resources(tokens, 8), authorizationRef: "host:contract-root" } });

  return { schemaVersion: 1, board, candidates, observations: [], horizon, basis: { scope, boardSequence: board.sequence,
    budgetId, utilityUnit: "qualified_objective_completions", valuationRef: "source:contract-objective" } };
}

function rebased(input: CentralPursuitInput, board: BoardState): CentralPursuitInput {
  const read = readCentralPursuitObservations(board, scope);
  if (read.status !== "ready") assert.fail(read.reason);
  return { ...input, board, basis: { ...input.basis, boardSequence: board.sequence }, observations: read.observations };
}

function decided(input: CentralPursuitInput) {
  const result = decideCentralLearningPursuit(input);
  if (result.status !== "decided") assert.fail(result.reason);
  return result;
}

function near(actual: number, expected: number): void { assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`); }

function selected(result: Extract<CentralPursuitResult, { status: "decided" }>): string | null {
  return "evaluation" in result.nextStep ? result.nextStep.evaluation.candidate.opportunity.opportunityId : null;
}

function fund(input: CentralPursuitInput, candidate: CentralPursuitCandidate): BoardState {
  const issue = input.board.learningIssues?.find(row => row.issueId === candidate.source.issueId);

  assert.ok(issue);
  const reserve = candidate.opportunity.offer.reserve, owner = candidate.opportunity.offer.owner;
  if (owner.plane !== "agent") assert.fail("agent_stage_required");

  return act(input.board, { kind: "fund", issueId: issue.issueId, expectedRevision: issue.revision,
    grantId: candidate.source.grantId, domain: owner.domain,
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: reserve.tokens, maxCalls: reserve.calls,
      maxSteps: reserve.steps, maxPromptChars: candidate.opportunity.offer.maxPromptChars }, budgetId,
    authorizationRef: "host:contract-stage", planRef: "plan:contract-setup", expectedSequence: input.board.sequence });
}

function observe(board: BoardState, candidate: CentralPursuitCandidate, id: string, outcome: CentralPursuitObservation["outcome"],
  historical = true): BoardState {
  const draft = createCentralPursuitObservationDraft({ unitId: `episode:${id}`, scope,
    conditionRef: candidate.opportunity.conditionRef, objective: { ...candidate.objective,
      instanceId: historical ? `objective:past-${id}` : candidate.objective.instanceId },
    grantId: candidate.source.grantId, stageRef: candidate.source.domainStage.stageRef,
    sourceRef: `checker:${id}`, revisionRef: `revision:${id}`, outcome });
  if (draft.status !== "ready") assert.fail(draft.reason);

  const next = reduce(board, { type: "record_reward_v2_fact", commandId: `observation:${id}`, issuedAt: date,
    expectedSequence: board.sequence, fact: draft.value });
  if (!next.ok) assert.fail(JSON.stringify(next));

  return next.state;
}

function bHistory(input: CentralPursuitInput): CentralPursuitInput {
  const b = input.candidates.find(row => row.opportunity.opportunityId === "opportunity:B")!;
  let board = observe(input.board, b, "b-good-1", "qualified");
  board = observe(board, b, "b-good-2", "qualified");
  board = observe(board, b, "b-no-result", "closed_no_result");
  return rebased(input, board);
}

test("zero history yields a real application accepted by original preparation, audit and funding reducers", () => {
  const input = fixture([{ id: "A", domain: "tool", family: "A" }]), result = decided(input);

  assert.equal(result.nextStep.kind, "fund_and_dispatch");

  if (result.nextStep.kind !== "fund_and_dispatch" || result.nextStep.application === null) assert.fail("funding_application_required");

  const evaluation = result.nextStep.evaluation, stage = evaluation.stage, offer = evaluation.candidate.opportunity.offer;
  if (stage.status !== "ready" || result.plan?.decision.kind !== "offer") assert.fail("actual_ready_stage_required");

  const prepared = prepareAllocationApplication({ ...result.nextStep.application, authorizationRef: "host:independent-contract-authorization",
    bindingsJson: JSON.stringify([{ offerId: offer.offerId, offerHash: result.plan.decision.offerHash, policyRef: offer.policyRef,
      sourceBindingRef: stage.sourceBindingRef, authorizedAllowance: { schemaVersion: 2, unit: "total_model_tokens",
        maxTokens: 1000, maxCalls: 8, maxSteps: 8, maxPromptChars: 1000 }, issueId: stage.issueId,
      expectedIssueRevision: stage.expectedIssueRevision, grantId: stage.grantId, mode: stage.mode, chargedAtBasis: stage.chargedAtBasis }]) });
  if (!prepared.ok) assert.fail(JSON.stringify(prepared));

  const audit = reduce(input.board, allocationAuditCommand(prepared.prepared, date));
  if (!audit.ok) assert.fail(JSON.stringify(audit));

  let board = audit.state;

  for (const draft of prepared.prepared.drafts) { const next = reduce(board, { ...draft, issuedAt: date });
    if (!next.ok) assert.fail(JSON.stringify(next));
  board = next.state; }

  assert.equal(board.centralLearningGrants?.[0]?.grantId, stage.grantId);
  assert.equal(centralBudgetProjection(board, budgetId)?.occupied.tokens, 100);
});

test("an original-writer no-result observation changes the winner between new family opportunities", () => {
  const input = fixture([{ id: "pastA", domain: "tool", family: "A" }, { id: "A", domain: "tool", family: "A" },
    { id: "B", domain: "skill", family: "B" }], 300);
  const current = { ...input, candidates: input.candidates.slice(1) }, past = input.candidates[0]!;

  assert.equal(selected(decided(current)), "opportunity:A");
  let board = fund(input, past);
  const job = board.jobs.find(row => row.coordination?.grantId === past.source.grantId)!;

  board = act(board, { kind: "claim", jobId: job.jobId, expectedAttempt: job.attempt, claimId: "claim:pastA",
    ownerId: "worker:pastA", expiresAt: "2026-11-04T15:10:00.000Z" });
  board = act(board, { kind: "reserve", grantId: past.source.grantId, claimId: "claim:pastA", reservationId: "reservation:pastA", maxTokens: 100 });
  board = act(board, { kind: "settle", grantId: past.source.grantId, reservationId: "reservation:pastA", usage: { kind: "reported", totalTokens: 20 } });
  board = act(board, { kind: "finish", jobId: job.jobId, claimId: "claim:pastA", result: { kind: "completed", resultRefs: [] } });
  board = observe(board, past, "pastA-closed-check", "closed_no_result", false);
  const after = decided(rebased(current, board));

  assert.equal(selected(after), "opportunity:B");
  near(after.evaluations[0]!.prediction.mean, 1 / 4);
  near(after.evaluations[1]!.prediction.mean, 1 / 2);
});

test("the real A1 A2 B backlog earns the independently derived 9/8 adaptive value", () => {
  const input = fixture([{ id: "A1", domain: "tool", family: "A" }, { id: "A2", domain: "tool", family: "A" },
    { id: "B", domain: "skill", family: "B" }], 200, 2), result = decided(input);
  assert.equal(selected(result), "opportunity:A1");
  assert.ok(result.plan);
  near(result.plan.netPolicyValue, 9 / 8);
});

function informationCase(): CentralPursuitInput {
  return bHistory(fixture([{ id: "A1", domain: "tool", family: "A", tokens: 100, fee: 51 / 100 },
    { id: "A2", domain: "tool", family: "A", tokens: 200 }, { id: "B", domain: "skill", family: "B", tokens: 200 }], 300, 2));
}

test("negative immediate value survives local timing stop and wins by the 271/400 joint policy", () => {
  const input = informationCase(), result = decided(input);
  assert.equal(result.evaluations[0]?.timing?.status === "ready" && result.evaluations[0].timing.advice, "stop");
  assert.equal(selected(result), "opportunity:A1");
  assert.ok(result.plan);
  near(result.plan.netPolicyValue, 271 / 400);
  const unrelated = { ...input, candidates: input.candidates.map((row, index) => index !== 1 ? row : { ...row,
    objective: { ...row.objective, familyRef: "family:independent-A2", familySourceRef: "protocol:independent-A2" } }) };
  assert.equal(selected(decided(unrelated)), "opportunity:B");
});

test("a covered stage dispatches with zero free tokens without issuing a second grant", () => {
  const input = fixture([{ id: "A", domain: "tool", family: "A" }], 100), board = fund(input, input.candidates[0]!);
  const result = decided(rebased(input, board));
  assert.equal(result.remaining.tokens, 0);
  assert.equal(result.nextStep.kind, "dispatch_existing");
  if (result.nextStep.kind === "dispatch_existing") assert.equal(result.nextStep.application, null);
  assert.equal(board.centralLearningGrants?.length, 1);
});

test("funding does not strand an informative negative-immediate covered prefix in wait", () => {
  const input = informationCase(), board = fund(input, input.candidates[0]!), result = decided(rebased(input, board));
  assert.equal(result.nextStep.kind, "dispatch_existing");
  assert.equal(selected(result), "opportunity:A1");
  const option = result.options.find(row => row.kind === "covered_prefix");
  assert.ok(option);
  near(option.value, 271 / 400);
});

test("a low-value held commitment offers canonical reconciliation before redirecting money", () => {
  const initial = fixture([{ id: "A", domain: "tool", family: "A", tokens: 200 }, { id: "B", domain: "skill", family: "B" }], 200);
  let board = fund(initial, initial.candidates[0]!);

  board = observe(board, initial.candidates[0]!, "a-prior-no-result", "closed_no_result");
  const a = initial.candidates[0]!, input = rebased({ ...initial, candidates: [{ ...a, opportunity: { ...a.opportunity,
    stage: "continuation", instanceRef: "stage:A-next" }, source: { ...a.source, domainStage: { ...a.source.domainStage,
      kind: "continuation", stageRef: "stage:A-next" } } }, initial.candidates[1]!] }, board);
  const result = decided(input);

  assert.equal(result.remaining.tokens, 0);
  assert.equal(result.nextStep.kind, "reconcile_then_replan");
  assert.equal(centralBudgetProjection(board, budgetId)?.available.tokens, 0);
  board = act(board, { kind: "rebudget", grantId: a.source.grantId, expectedSequence: board.sequence, limits: resources(0, 0),
    authorizationRef: "host:contract-root", planRef: "plan:confirmed-release" });
  const next = decided(rebased(input, board));

  assert.equal(next.nextStep.kind, "fund_and_dispatch");
  assert.equal(selected(next), "opportunity:B");
});

test("fulfilled objectives and alternate attempts cannot manufacture another completion or independent trial", () => {
  const input = fixture([{ id: "A1", domain: "tool", family: "A" }, { id: "A2", domain: "tool", family: "A", tokens: 200 }], 300, 2);
  const original = input.candidates[0]!, sameObjective = { ...input, candidates: [original,
    { ...input.candidates[1]!, objective: original.objective }] };
  const result = decided(sameObjective);
  assert.ok(result.plan);
  near(result.plan.netPolicyValue, 1 / 2);
  const fulfilled = observe(input.board, original, "already-qualified", "qualified", false);
  const after = decided(rebased(sameObjective, fulfilled));

  assert.equal(after.nextStep.kind, "stop");
  assert.ok(after.plan);
  near(after.plan.netPolicyValue, 0);
});

test("in-flight declarations without a grant and malformed fee or source references cannot fund", () => {
  const input = fixture([{ id: "A", domain: "tool", family: "A" }]), current = input.candidates[0]!;
  const flight = decided({ ...input, candidates: [{ ...current, readiness: { kind: "in_flight", sourceRef: "worker:original-boundary" } }] });

  assert.equal(flight.nextStep.kind, "wait");
  assert.equal(input.board.centralLearningGrants?.length ?? 0, 0);

  for (const candidate of [{ ...current, fee: { kind: "hard-budget-only" as const, sourceRef: "" } },
    { ...current, source: { ...current.source, sourceBindingRef: "" } },
    { ...current, target: { kind: "deadline" as const, sourceRef: "target:deadline", useBy: 200,
      durationUpperBound: 10, durationSourceRef: "duration:stage", grossSupport: {
        minimum: .4, maximum: .6, sourceRef: "invalid:interval-around-mean" } } }]) {
    assert.equal(decideCentralLearningPursuit({ ...input, candidates: [candidate] }).status, "rejected");
  }
});
