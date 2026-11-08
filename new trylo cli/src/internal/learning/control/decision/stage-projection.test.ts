import assert from "node:assert/strict";
import test from "node:test";
import type { LearningAllocationOffer } from "../allocation-contract.js";
import type { CoordinationAction } from "../coordination-contract.js";
import { centralLearningSpent } from "../coordination-contract.js";
import { reduce } from "../reducer.js";
import { emptyBoardState } from "../state.js";
import { isCentralDecisionStageSource, projectCentralDecisionStage } from "./stage-projection.js";
import type { CentralDecisionStageInput } from "./stage-projection.js";

// Synthetic sources exercise canonical accounting and worker transitions. No provider or
// private subsystem worker runs, and these receipts do not establish real learning quality.
const scope = "workspace:central-stage-contract", issuedAt = "2026-11-04T00:00:00.000Z";

function fixture(domain: "prompt" | "workflow" = "prompt") {
  let state = emptyBoardState(), serial = 0;
  const send = (action: CoordinationAction) => {
    const result = reduce(state, { type: "coordinate_learning", commandId: `stage-command:${++serial}`, issuedAt, action });
    if (result.ok) state = result.state;
    return result;
  };
  const accept = (action: CoordinationAction) => {
    const result = send(action);
    assert.ok(result.ok, result.ok ? "" : `${result.reason}:${result.detail}`);
    return result;
  };

  accept({ kind: "open_budget", expectedSequence: state.sequence, budget: { schemaVersion: 1,
    budgetId: "root:stage", scope, unit: "total_model_tokens", limits: { tokens: 10000, calls: 20, steps: 20 },
    authorizationRef: "host:explicit-stage-budget" } });
  accept({ kind: "report", issueId: "issue:stage", scope, problemKey: "grounded-stage",
    report: { reportId: "report:stage", source: { subsystem: domain === "prompt" ? "method" : "workflow",
      taskId: "task:stage", versionId: "input:stage" }, facts: ["grounded synthetic inefficiency"], evidenceRefs: ["evidence:stage"] } });
  accept({ kind: "decide", issueId: "issue:stage", expectedRevision: state.learningIssues![0]!.revision,
    decision: "focused_learning", reason: "explicit bounded test source", sourceRefs: ["input:stage", "evidence:stage"] });
  const offer = (tokens = 400, calls = 2): LearningAllocationOffer => ({ offerId: "offer:stage", owner: { plane: "agent", domain },
    policyRef: "policy:stage", reserve: { tokens, calls, steps: calls }, maxPromptChars: 10000 });
  const input = (kind: "initial" | "continuation" = "initial", quotedOffer = offer()): CentralDecisionStageInput => ({
    board: state, scope, budgetId: "root:stage", issueId: "issue:stage", grantId: "grant:stage",
    sourceBindingRef: "host-source:stage", offer: quotedOffer, domainStage: { stageRef: `source-stage:${kind}`,
      kind, policyRef: quotedOffer.policyRef, sourceReportId: "report:stage", readiness: { kind: "ready", evidenceRefs: ["evidence:stage"] } },
  });
  const grant = () => state.centralLearningGrants![0]!;
  const fund = () => accept({ kind: "fund", domain, issueId: "issue:stage", expectedRevision: state.learningIssues![0]!.revision,
    grantId: "grant:stage", allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 600, maxCalls: 2, maxSteps: 2,
      maxPromptChars: 10000 }, budgetId: "root:stage", expectedSequence: state.sequence,
    authorizationRef: "host:stage-allocation", planRef: "plan:stage" });
  const claim = () => accept({ kind: "claim", jobId: grant().jobId,
    expectedAttempt: state.jobs.find(item => item.jobId === grant().jobId)!.attempt, claimId: "claim:stage",
    ownerId: "owner:stage", expiresAt: "2026-11-04T00:01:00.000Z" });
  const reserve = () => accept({ kind: "reserve", grantId: grant().grantId, claimId: "claim:stage",
    reservationId: "reservation:stage", maxTokens: 300 });
  const settle = () => accept({ kind: "settle", grantId: grant().grantId, reservationId: "reservation:stage",
    usage: { kind: "reported", totalTokens: 100 } });
  const finish = (kind: "yielded" | "completed") => accept({ kind: "finish", jobId: grant().jobId, claimId: "claim:stage",
    result: kind === "yielded" ? { kind, reason: "domain confirmed its macro-stage boundary" } : { kind, resultRefs: ["result:stage"] } });
  const reconcile = () => accept({ kind: "rebudget", grantId: grant().grantId, expectedSequence: state.sequence,
    limits: centralLearningSpent(grant()), authorizationRef: "host:reconcile", planRef: "plan:release-unused" });

  return { state: () => state, send, accept, input, offer, grant, fund, claim, reserve, settle, finish, reconcile };
}

test("a focused original source can fund once; an existing sufficient grant is reused", () => {
  const f = fixture(), prepared = projectCentralDecisionStage(f.input("initial", { ...f.offer(), maxPromptChars: 160000 }));

  assert.ok(prepared.status === "ready");
  assert.equal(prepared.mode, "fund");
  assert.deepEqual(prepared.chargedAtBasis, { tokens: 0, calls: 0, steps: 0 });
  f.fund();
  const existing = projectCentralDecisionStage(f.input("initial", f.offer(400, 1)));

  assert.equal(existing.status, "continue_existing");
  assert.equal(f.state().centralLearningGrants!.length, 1);
});

test("a real claim and reservation block stage financing even after the request settles", () => {
  const f = fixture();
  f.fund();
  f.claim();
  assert.equal(projectCentralDecisionStage(f.input("continuation")).status, "in_flight");
  f.reserve();
  assert.equal(projectCentralDecisionStage(f.input("continuation")).status, "in_flight");
  f.settle();
  assert.equal(projectCentralDecisionStage(f.input("continuation")).status, "in_flight");
  const blocked = f.send({ kind: "rebudget", grantId: f.grant().grantId, expectedSequence: f.state().sequence,
    limits: centralLearningSpent(f.grant()), authorizationRef: "host:premature-reconcile", planRef: "plan:premature" });

  assert.ok(!blocked.ok);
  assert.equal(blocked.reason, "learning_grant_unsettled");
});

test("a managed continuation can quote a larger source context without replacing its grant", () => {
  const f = fixture("workflow");
  f.fund();
  f.claim();
  f.reserve();
  f.settle();
  f.finish("yielded");
  const before = f.state();
  const result = projectCentralDecisionStage(f.input("continuation", { ...f.offer(400, 1), maxPromptChars: 160000 }));
  assert.equal(result.status, "continue_existing");
  assert.equal(result.grantId, "grant:stage");
  assert.equal(f.state(), before, "a quote neither changes the allowance nor spends more resources");
  assert.equal(f.grant().allowance.maxPromptChars, 10000);
  const invalid = projectCentralDecisionStage(f.input("continuation", { ...f.offer(400, 1), maxPromptChars: 1_000_000_001 }));
  assert.equal(invalid.status, "needs_source");
  if (invalid.status === "needs_source") assert.equal(invalid.reason, "stage_input_invalid");
});

test("method yield retains unused commitment; a real reconciliation enables a new continuation", () => {
  const f = fixture();
  f.fund();
  f.claim();
  f.reserve();
  f.settle();
  f.finish("yielded");
  const yielded = projectCentralDecisionStage(f.input("continuation"));

  assert.equal(yielded.status, "reconcile_then_replan");
  assert.deepEqual(yielded.chargedAtBasis, { tokens: 100, calls: 1, steps: 1 });
  assert.equal(f.grant().allowance.maxTokens, 600, "yield does not release a lifetime promise");
  f.reconcile();
  const continuation = projectCentralDecisionStage(f.input("continuation"));

  assert.ok(continuation.status === "ready");
  assert.equal(continuation.mode, "extend");
  assert.equal(continuation.grantId, yielded.grantId);
  assert.equal(continuation.expectedIssueRevision, f.state().learningIssues![0]!.revision);
  assert.notEqual(continuation.progressRef, yielded.progressRef, "resource changes invalidate the prior progress basis");
  assert.deepEqual(continuation.chargedAtBasis, { tokens: 100, calls: 1, steps: 1 });
  assert.equal(projectCentralDecisionStage(f.input("initial")).status, "needs_source", "same initial stage is not an additive continuation");
});

test("a completed workflow cannot be revived by an additional quoted stage", () => {
  const f = fixture("workflow");
  f.fund();
  assert.equal(projectCentralDecisionStage(f.input("initial", f.offer(400, 1))).status, "continue_existing");
  f.claim();
  f.reserve();
  f.settle();
  f.finish("completed");
  const before = f.state();

  for (const kind of ["initial", "continuation"] as const) {
    const result = projectCentralDecisionStage(f.input(kind));
    assert.equal(result.status, "terminal");
  }

  assert.equal(f.state(), before, "projection does not change a closed grant or worker");
  assert.equal(f.grant().status, "closed");
  assert.equal(f.state().jobs[0]!.state, "succeeded");
});

test("actual dependency waiting survives a caller's source-ready assertion", () => {
  const f = fixture();
  f.fund();
  f.claim();
  f.accept({ kind: "finish", jobId: f.grant().jobId, claimId: "claim:stage", result: { kind: "waiting_dependency", dependencies: [{
    dependencyId: "dependency:stage", owner: "tool", correlationRef: "correlation:stage",
    state: { kind: "waiting", reason: "original domain requires a tool result" },
  }] } });
  assert.equal(projectCentralDecisionStage(f.input("continuation")).status, "waiting_evidence");
  f.accept({ kind: "dependency", dependencyId: "dependency:stage", expectedRevision: 1,
    state: { kind: "ready", resultRef: "tool-result:stage", resultVersion: "v1", evidenceRefs: ["evidence:tool-result"] } });
  assert.equal(projectCentralDecisionStage(f.input("continuation", f.offer(400, 1))).status, "continue_existing");
});

test("the selected report, aggregate issue owner and original grant identities must agree", () => {
  const f = fixture();
  f.fund();
  const original = f.input(), wrongOwner: LearningAllocationOffer = { ...original.offer, owner: { plane: "agent", domain: "tool" } };
  const ownerMismatch = projectCentralDecisionStage({ ...original, offer: wrongOwner });

  assert.equal(ownerMismatch.status, "needs_source");

  if (ownerMismatch.status === "needs_source") assert.equal(ownerMismatch.reason, "stage_source_owner_mismatch");

  const reportMismatch = projectCentralDecisionStage({ ...original, domainStage: { ...original.domainStage, sourceReportId: "report:another" } });

  assert.equal(reportMismatch.status, "needs_source");
  const replacedGrant = projectCentralDecisionStage({ ...original, grantId: "grant:replacement" });

  assert.equal(replacedGrant.status, "needs_source", "a new identity cannot bypass the original open investment");
});

test("the public source sidecar guard rejects malformed nested shapes before projection", () => {
  const input = fixture().input();
  const source = { issueId: input.issueId, grantId: input.grantId, sourceBindingRef: input.sourceBindingRef, domainStage: input.domainStage };
  assert.equal(isCentralDecisionStageSource(source), true);
  assert.equal(isCentralDecisionStageSource({ ...source, domainStage: null }), false);
  assert.equal(isCentralDecisionStageSource({ ...source, domainStage: { ...source.domainStage, readiness: { kind: "ready", evidenceRefs: null } } }), false);
  assert.equal(isCentralDecisionStageSource({ ...source, unknownCapability: true }), false);
});
