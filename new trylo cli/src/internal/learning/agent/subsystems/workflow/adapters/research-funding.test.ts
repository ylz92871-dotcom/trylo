import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { centralLearningSpent } from "../../../../control/coordination-contract.js";
import { searchImprovementFixture } from "../testing/improvement-fixtures.js";
import { createWorkflowImprovementFunding } from "./improvement-funding.js";
import { commitWorkflowImprovementRecord } from "./improvement-board.js";
import type { WorkflowResearchCheckpoint } from "../runtime/research-state.js";

async function fixture(t: TestContext, allowance = 12_000) {
  const boardRoot = await mkdtemp(path.join(tmpdir(), "workflow-research-funding-"));

  t.after(() => rm(boardRoot, { recursive: true, force: true }));
  const source = searchImprovementFixture();
  const record = { type: "workflow_improvement_opportunity" as const, schemaVersion: 1 as const,
    opportunity: source.opportunity, evidence: source.evidence };
  let clock = 1_793_761_200_000;
  const options = { boardRoot, scope: source.opportunity.task.scope, centralScope: "D:/workspace/workflow-research",
    budgetId: "original-authorized-run", allowance, now: () => clock, research: true as const };
  const funding = createWorkflowImprovementFunding({ ...options, researchOwnerId: "research-owner-a" });
  const funded = await funding.fund(record);
  assert.ok(funded.ok);
  const research = funding.research;
  assert.ok(research);

  return { boardRoot, options, record, funding, funded: funded.value, research,
    advance: (milliseconds: number) => { clock += milliseconds; },
    async read() {
      const loaded = await createBoardReader(boardRoot).load();
      assert.ok(loaded.ok);
      return loaded.state;
    } };
}

test("research reserves each request on the original grant and measured usage releases unused tokens for its next step", async t => {
  const fx = await fixture(t);
  const initial = await fx.read();

  assert.equal(initial.centralLearningGrants?.[0]?.allowance.maxCalls, 4);
  assert.equal(initial.centralLearningGrants?.[0]?.allowance.maxSteps, 4);
  const first = await fx.research.reserve(fx.funded, { stepId: "wf-research:0", maxTokens: 12_000 });
  assert.ok(first.ok);
  const beforeModel = await fx.read();
  const committed = beforeModel.centralLearningGrants?.[0]?.reservations[0];

  assert.equal(committed?.reservationId, first.value.reservationId);
  assert.equal(committed?.claimId, first.value.claimId);
  assert.equal(committed?.state, "reserved");
  assert.deepEqual((await fx.research.inspect(fx.funded)), { ok: true, value: {
    remaining: { tokens: 0, calls: 3, steps: 3 }, maxPromptChars: 24_000, state: "running",
    activeClaim: beforeModel.centralLearningGrants?.[0]?.claim,
    attemptedStepIds: ["wf-research:0"], unknownStepIds: ["wf-research:0"] } });
  assert.ok((await fx.funding.settle(first.value, { kind: "reported", totalTokens: 1200 })).ok);
  const afterFirst = await fx.research.inspect(fx.funded);
  assert.ok(afterFirst.ok);
  assert.deepEqual(afterFirst.value.remaining, { tokens: 10_800, calls: 3, steps: 3 });
  assert.deepEqual(afterFirst.value.unknownStepIds, []);
  const second = await fx.research.reserve(fx.funded, { stepId: "wf-research:1" });
  assert.ok(second.ok);
  assert.equal(second.value.grantId, first.value.grantId);
  assert.equal(second.value.claimId, first.value.claimId);
  assert.equal(second.value.maxTokens, 10_800);
  assert.ok((await fx.funding.settle(second.value, { kind: "reported", totalTokens: 800 })).ok);
  const final = await fx.read();

  assert.equal(final.centralLearningGrants?.length, 1);
  assert.equal(final.centralLearningGrants?.[0]?.reservations.length, 2);
  assert.deepEqual(centralLearningSpent(final.centralLearningGrants![0]!), { tokens: 2000, calls: 2, steps: 2 });
});

test("unknown charges stay occupied and the same step cannot be sent again after a new factory or budget label", async t => {
  const fx = await fixture(t);
  const first = await fx.research.reserve(fx.funded, { stepId: "wf-research:0", maxTokens: 5000 });
  assert.ok(first.ok);
  assert.ok((await fx.funding.settle(first.value, { kind: "unknown", reason: "response_tail_missing" })).ok);
  const before = await fx.read();
  const retry = await fx.research.reserve(fx.funded, { stepId: "wf-research:0" });

  assert.ok(!retry.ok);
  assert.equal(retry.code, "workflow_research_step_already_attempted");
  const bound = createWorkflowImprovementFunding({ ...fx.options, budgetId: "restart-label",
    researchOwnerId: "research-owner-b", binding: { grantId: fx.funded.grantId, inputVersionId: fx.funded.inputVersionId } });

  assert.ok(bound.research);
  const restartedRetry = await bound.research.reserve(fx.funded, { stepId: "wf-research:0" });

  assert.ok(!restartedRetry.ok);
  assert.equal(restartedRetry.code, "workflow_research_step_already_attempted");
  const view = await bound.research.inspect(fx.funded);
  assert.ok(view.ok);
  assert.deepEqual(view.value.remaining, { tokens: 7000, calls: 3, steps: 3 });
  assert.deepEqual(view.value.unknownStepIds, ["wf-research:0"]);
  const after = await fx.read();
  assert.equal(after.sequence, before.sequence);
  assert.equal(after.centralLearningGrants?.length, 1);
});

test("two concurrent reservations of the same step create exactly one spend address", async t => {
  const fx = await fixture(t);
  const attempts = await Promise.all([
    fx.research.reserve(fx.funded, { stepId: "wf-research:0", maxTokens: 3000 }),
    fx.research.reserve(fx.funded, { stepId: "wf-research:0", maxTokens: 3000 }),
  ]);

  assert.equal(attempts.filter(item => item.ok).length, 1);
  const rejected = attempts.find(item => !item.ok);
  assert.ok(rejected && !rejected.ok);
  assert.ok(["workflow_research_step_already_attempted", "multi_writer"].includes(rejected.code));
  // The Board may reject a concurrent writer instead of serializing it. Once its
  // lock is free, the same address must still be unable to send a second request.
  const replay = await fx.research.reserve(fx.funded, { stepId: "wf-research:0" });

  assert.ok(!replay.ok);
  assert.equal(replay.code, "workflow_research_step_already_attempted");
  const state = await fx.read();
  assert.equal(state.centralLearningGrants?.[0]?.reservations.length, 1);
});

test("a different factory owner cannot share a live research claim even with the same original budget ID", async t => {
  const fx = await fixture(t);
  const first = await fx.research.reserve(fx.funded, { stepId: "wf-research:0", maxTokens: 3000 });
  assert.ok(first.ok);
  assert.ok((await fx.funding.settle(first.value, { kind: "reported", totalTokens: 600 })).ok);
  const other = createWorkflowImprovementFunding({ ...fx.options, researchOwnerId: "research-owner-b" });
  assert.ok(other.research);
  const before = await fx.read();
  const claimed = await other.research.claim(fx.funded);
  assert.ok(!claimed.ok);
  assert.equal(claimed.code, "learning_claim_active");
  const reserved = await other.research.reserve(fx.funded, { stepId: "wf-research:1" });

  assert.ok(!reserved.ok);
  assert.equal(reserved.code, "learning_claim_active");
  const after = await fx.read();
  assert.equal(after.sequence, before.sequence);
  assert.equal(after.centralLearningGrants?.[0]?.claim?.ownerId, "research-owner-a");
});

test("workflow yield releases only the claim and resumes the same grant with its measured charges", async t => {
  const fx = await fixture(t);
  const first = await fx.research.reserve(fx.funded, { stepId: "wf-research:0", maxTokens: 4000 });
  assert.ok(first.ok);
  assert.ok((await fx.funding.settle(first.value, { kind: "reported", totalTokens: 1000 })).ok);
  const yielded = await fx.funding.finish(first.value, { kind: "yielded", reason: "workflow_research_segment_complete" });

  assert.ok(yielded.ok, yielded.ok ? "" : `${yielded.code}: ${yielded.message}`);
  const paused = await fx.read();

  assert.equal(paused.jobs.find(item => item.jobId === fx.funded.jobId)?.state, "queued");
  assert.equal(paused.centralLearningGrants?.[0]?.status, "open");
  assert.equal(paused.centralLearningGrants?.[0]?.claim, undefined);
  const restarted = createWorkflowImprovementFunding({ ...fx.options, budgetId: "restart-label", researchOwnerId: "research-owner-b",
    binding: { grantId: fx.funded.grantId, inputVersionId: fx.funded.inputVersionId } });
  assert.ok(restarted.research);
  const second = await restarted.research.reserve(fx.funded, { stepId: "wf-research:1" });
  assert.ok(second.ok);
  assert.equal(second.value.grantId, fx.funded.grantId);
  assert.notEqual(second.value.claimId, first.value.claimId);
  assert.equal(second.value.maxTokens, 11_000);
  const resumed = await fx.read();
  assert.equal(resumed.centralLearningGrants?.length, 1);
  assert.equal(resumed.centralLearningGrants?.[0]?.reservations[0]?.usage?.kind, "reported");
});

test("expired claim takeover preserves the old unresolved charge and never resends its step", async t => {
  const fx = await fixture(t);
  const first = await fx.research.reserve(fx.funded, { stepId: "wf-research:0", maxTokens: 5000 });
  assert.ok(first.ok);
  fx.advance(600_001);
  const restarted = createWorkflowImprovementFunding({ ...fx.options, researchOwnerId: "research-owner-b" });
  assert.ok(restarted.research);
  const takeover = await restarted.research.claim(fx.funded);
  assert.ok(takeover.ok);
  assert.notEqual(takeover.value.claimId, first.value.claimId);
  const state = await fx.read(), old = state.centralLearningGrants?.[0]?.reservations[0];

  assert.equal(old?.state, "settled");
  assert.deepEqual(old?.usage, { kind: "unknown", reason: "previous_claim_expired" });
  const retry = await restarted.research.reserve(fx.funded, { stepId: "wf-research:0" });

  assert.ok(!retry.ok);
  assert.equal(retry.code, "workflow_research_step_already_attempted");
  const snapshot = await restarted.research.inspect(fx.funded);
  assert.ok(snapshot.ok);
  assert.equal(snapshot.value.remaining.tokens, 7000);
  assert.deepEqual(snapshot.value.unknownStepIds, ["wf-research:0"]);
});

test("withdrawn original source cannot acquire a research claim or spend remaining funds", async t => {
  const fx = await fixture(t);
  const forgotten = await withBoardWriter(fx.boardRoot, store => store.apply({ type: "tombstone", commandId: "withdraw-research-source",
    issuedAt: new Date(fx.options.now()).toISOString(), entityType: "asset", entityId: fx.funded.inputVersionId,
    reason: "Withdraw the exact original source before research dispatch" }));
  assert.ok(forgotten.ok);
  const before = await fx.read();
  const claim = await fx.research.claim(fx.funded);
  assert.ok(!claim.ok);
  assert.equal(claim.code, "workflow_improvement_source_unavailable");
  const reserve = await fx.research.reserve(fx.funded, { stepId: "wf-research:0" });
  assert.ok(!reserve.ok);
  assert.equal(reserve.code, "workflow_improvement_source_unavailable");
  const after = await fx.read();
  assert.equal(after.sequence, before.sequence);
  assert.equal(after.centralLearningGrants?.[0]?.reservations.length, 0);
});

test("another visible source on the same issue cannot borrow the original input's research grant", async t => {
  const fx = await fixture(t);
  const otherRecord = { ...fx.record, opportunity: { ...fx.record.opportunity, opportunityId: "another-source-on-same-issue" } };
  const saved = await commitWorkflowImprovementRecord(fx.boardRoot, otherRecord, new Date(fx.options.now()).toISOString());
  assert.ok(saved.ok);
  const initial = await fx.read(), issue = initial.learningIssues![0]!;
  const reported = await withBoardWriter(fx.boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "another-research-source-report",
    issuedAt: new Date(fx.options.now()).toISOString(), action: { kind: "report", scope: fx.options.centralScope,
      issueId: issue.issueId, problemKey: issue.problemKey, expectedRevision: issue.revision,
      report: { reportId: "another-source-report", source: { subsystem: "workflow", taskId: "later-input", versionId: saved.value.versionId },
        facts: ["A different source was appended to the same research issue"], evidenceRefs: otherRecord.opportunity.evidenceRefs } } }));

  assert.ok(reported.ok);
  const before = await fx.read();
  const substituted = { ...fx.funded, inputVersionId: saved.value.versionId };
  const claim = await fx.research.claim(substituted);
  assert.ok(!claim.ok);
  assert.equal(claim.code, "learning_claim_conflict");
  const reserve = await fx.research.reserve(substituted, { stepId: "wf-research:0" });
  assert.ok(!reserve.ok);
  assert.equal(reserve.code, "learning_claim_conflict");
  const after = await fx.read();
  assert.equal(after.sequence, before.sequence);
  assert.equal(after.centralLearningGrants?.[0]?.reservations.length, 0);
});

test("legacy one-shot funding keeps its original single-request allowance and no research port", async t => {
  const fx = await fixture(t);
  const legacyRoot = await mkdtemp(path.join(tmpdir(), "workflow-legacy-funding-"));

  t.after(() => rm(legacyRoot, { recursive: true, force: true }));
  const legacy = createWorkflowImprovementFunding({ ...fx.options, research: false, boardRoot: legacyRoot });

  assert.equal(legacy.research, undefined);
  const funded = await legacy.fund(fx.record);
  assert.ok(funded.ok);
  const state = await createBoardReader(legacyRoot).load();
  assert.ok(state.ok);
  assert.equal(state.state.centralLearningGrants?.[0]?.allowance.maxCalls, 1);
  assert.equal(state.state.centralLearningGrants?.[0]?.allowance.maxSteps, 1);
  const first = await legacy.reserve(funded.value);
  assert.ok(first.ok);
  assert.ok((await legacy.settle(first.value, { kind: "reported", totalTokens: 1000 })).ok);
  const second = await legacy.reserve(funded.value);
  assert.ok(!second.ok);
  assert.equal(second.code, "learning_claim_conflict");
});

test("generic record writes cannot manufacture research progress without the original confirmed step", async t => {
  const fx = await fixture(t);
  const reserved = await fx.research.reserve(fx.funded, { stepId: "wf-research:0", maxTokens: 3000 });
  assert.ok(reserved.ok);
  const checkpoint: WorkflowResearchCheckpoint = { type: "workflow_improvement_research", schemaVersion: 1,
    scope: fx.record.opportunity.task.scope, inputVersionId: fx.funded.inputVersionId, grantId: fx.funded.grantId,
    step: 0, reservationId: reserved.value.reservationId, contextRef: "test-only:confirmed-original-context",
    status: "continue", observation: { kind: "material_read", evidenceRefs: fx.record.opportunity.evidenceRefs.slice(0, 1) } };
  const before = await fx.read();
  const unconfirmed = await commitWorkflowImprovementRecord(fx.boardRoot, checkpoint, new Date(fx.options.now()).toISOString());

  assert.ok(!unconfirmed.ok);
  assert.equal(unconfirmed.code, "workflow_research_source_conflict");
  assert.equal((await fx.read()).sequence, before.sequence);
  assert.ok((await fx.funding.settle(reserved.value, { kind: "reported", totalTokens: 700 })).ok);
  const settled = await fx.read();
  const wrongSource = await commitWorkflowImprovementRecord(fx.boardRoot, { ...checkpoint, inputVersionId: "unrelated-source" },
    new Date(fx.options.now()).toISOString());

  assert.ok(!wrongSource.ok);
  assert.equal(wrongSource.code, "workflow_research_source_conflict");
  const renamedStep = await commitWorkflowImprovementRecord(fx.boardRoot, { ...checkpoint, step: 1 }, new Date(fx.options.now()).toISOString());

  assert.ok(!renamedStep.ok);
  assert.equal(renamedStep.code, "workflow_research_source_conflict");
  assert.equal((await fx.read()).sequence, settled.sequence);
  const confirmed = await commitWorkflowImprovementRecord(fx.boardRoot, checkpoint, new Date(fx.options.now()).toISOString());

  assert.ok(confirmed.ok, JSON.stringify(confirmed));
  assert.equal((await fx.read()).centralLearningGrants?.[0]?.reservations.length, 1);
});
