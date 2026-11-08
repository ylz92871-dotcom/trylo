import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { centralLearningSpent } from "../../../../control/coordination-contract.js";
import { acquisitionInquiryJobId, acquisitionInquiryOutcomeId, acquisitionInquirySpecId, type AcquisitionInquiryOutcome,
  type AcquisitionInquirySpec } from "../domain/evolution/acquisition-inquiry.js";
import { toolLearningDecisionVersionId } from "../domain/evolution/decision-identity.js";
import { toolLearningFundingIdentity } from "../domain/evolution/funding-identity.js";
import type { ToolLearningDecision } from "../domain/evolution/learning-plan.js";
import { toolLearningJobId, type ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { acquisitionRecoveryFixture } from "../testing/acquisition-recovery-fixture.js";
import { recordToolAcquisitionFailure } from "./acquisition-failure.js";
import { createToolLearningFunding } from "./learning-funding.js";
import { savePipelineAsset } from "./pipeline-assets.js";
import { enqueueToolLearningPlan, nextToolLearningDispatch } from "./pipeline-queue.js";
import { toolFundingOriginFromBoard } from "./tool-funding-origin.js";

/** TEST ONLY canonical Board observations. The synthetic installed receipt and
 * controlled reservations do not assert a download, provider or native run. */
async function reviewFixture(t: TestContext, ordinaryNomination = false) {
  const fx = await acquisitionRecoveryFixture(t, { evidenceRefs: ["TEST_ONLY_original_task_anchor"],
    ...(ordinaryNomination ? { triggerAction: "replace_or_add" } : {}) });

  await fx.funding.release();
  const failed = await recordToolAcquisitionFailure({ ...fx, phase: "install", failure: { code: "hash_mismatch" }, issuedAt: fx.at() });

  assert.ok(failed.ok);
  const jobId = acquisitionInquiryJobId(fx.jobId, fx.approvalId), specVersionId = acquisitionInquirySpecId(jobId, 1);
  const spec: AcquisitionInquirySpec = { type: "tool_acquisition_inquiry_spec", schemaVersion: 1, jobId, attempt: 1,
    originalJobId: fx.jobId, approvalId: fx.approvalId, failureRef: failed.versionId, scope: fx.scope,
    rootJobId: fx.jobId, rootPlanHash: contentHashOf(fx.plan) };
  const decision: Extract<ToolLearningDecision, { action: "acquire" }> = {
    action: "acquire", candidate: { platform: "npm", id: "replacement-cli", version: "2.0.0" },
    rationale: "TEST ONLY replacement after a host acquisition failure", existingInsufficiency: "TEST ONLY immutable acquisition failure",
    expectedBenefit: "TEST ONLY", constructionCost: "TEST ONLY", alternatives: ["defer"], adaptation: "TEST ONLY exact replacement API",
  };
  const planningDecisionVersionId = toolLearningDecisionVersionId({ jobId, attempt: 1, step: 1, decision });
  const plan: ToolLearningPlan = { ...fx.plan, trigger: { ...fx.plan.trigger, proposalKey: `acquisition-review:${jobId}:1`,
    evidenceRefs: [...new Set([...fx.plan.trigger.evidenceRefs, failed.versionId, planningDecisionVersionId])] }, fundingOrigin: { rootJobId: fx.jobId, rootPlanHash: contentHashOf(fx.plan),
      inquiryJobId: jobId, inquiryAttempt: 1, outcomeVersionId: acquisitionInquiryOutcomeId(jobId, 1) } };
  const reviewJobId = toolLearningJobId(plan);
  const outcome: AcquisitionInquiryOutcome = { type: "tool_acquisition_inquiry_result", schemaVersion: 1, jobId, attempt: 1,
    specVersionId, scope: fx.scope, status: "proposed", code: "acquisition_approval_required", planningDecisionVersionId, decision,
    search: { status: "complete", candidates: [{ ...decision.candidate, sourceUrl: "https://www.npmjs.com/package/replacement-cli", licenseSpdx: "MIT" }], failures: [] },
    review: { plan, jobId: reviewJobId, decisionVersionId: toolLearningDecisionVersionId({ jobId: reviewJobId, attempt: 1, step: 1, decision }) } };

  await withBoardWriter(fx.boardRoot, async store => {
    assert.ok((await store.apply({ type: "enqueue_job", commandId: `${jobId}:enqueue`, issuedAt: fx.at(),
      job: { jobId, domain: "tool", scope: fx.scope, observationId: fx.jobId, maxAttempts: 3, dedupeKey: jobId } })).ok);
    assert.ok((await store.apply({ type: "start_job", commandId: `${jobId}:start`, issuedAt: fx.at(), jobId })).ok);

    for (const [versionId, content] of [[specVersionId, spec], [planningDecisionVersionId,
      { type: "tool_learning_decision", schemaVersion: 1, jobId, attempt: 1, step: 1, decision }],
      [acquisitionInquiryOutcomeId(jobId, 1), outcome]] as const) {
      assert.ok((await savePipelineAsset(store, { versionId, content, kind: "workflow", source: "inferred", scope: fx.scope, issuedAt: fx.at() })).ok);
    }
  });
  const enqueueReview = async (selected = plan) => {
    const queued = await enqueueToolLearningPlan(fx.boardRoot, selected);
    assert.ok(queued.ok);
    assert.ok((await withBoardWriter(fx.boardRoot, store => store.apply({ type: "start_job", commandId: `${queued.jobId}:start`,
      issuedAt: fx.at(), jobId: queued.jobId }))).ok);
    return queued.jobId;
  };

  return { ...fx, inquiryJobId: jobId, reviewPlan: plan, reviewJobId, enqueueReview };
}

test("an acquisition continuation with a missing original grant cannot create an issue or refill allowance", async t => {
  const fx = await acquisitionRecoveryFixture(t, { funded: false });
  const funding = createToolLearningFunding({ boardRoot: fx.boardRoot, scope: fx.scope, now: fx.now, continuationJobId: fx.childJobId });
  assert.equal(await funding.allowance(fx.plan), undefined);
  const state = await fx.state();
  assert.equal(state.centralLearningGrants?.length ?? 0, 0);
  assert.equal(state.learningIssues?.length ?? 0, 0);
});

test("an acquisition inquiry and its exact review spend one original grant without resetting reservations", async t => {
  const fx = await reviewFixture(t), before = await fx.state(), grant = before.centralLearningGrants![0]!;
  const proof = toolFundingOriginFromBoard(before, fx.reviewPlan);
  assert.ok(proof.ok);
  assert.equal(proof.rootJobId, fx.jobId);
  assert.deepEqual(proof.rootPlan, fx.plan);
  assert.equal(fx.reviewPlan.trigger.evidenceRefs[0], "TEST_ONLY_original_task_anchor");
  assert.deepEqual(toolLearningFundingIdentity(fx.reviewPlan), toolLearningFundingIdentity(fx.plan));
  const inquiry = createToolLearningFunding({ boardRoot: fx.boardRoot, scope: fx.scope, now: fx.now, continuationJobId: fx.inquiryJobId });
  const inquiryBudget = await inquiry.allowance(fx.plan);
  assert.ok(inquiryBudget);
  assert.equal(inquiryBudget.grantId, grant.grantId);
  assert.ok((await inquiry.reserve("TEST_ONLY_inquiry_call", 200)).ok);
  assert.ok((await inquiry.settle("TEST_ONLY_inquiry_call", { kind: "reported", totalTokens: 100 })).ok);
  await inquiry.release();
  await fx.enqueueReview();
  const review = createToolLearningFunding({ boardRoot: fx.boardRoot, scope: fx.scope, now: fx.now });
  const reviewBudget = await review.allowance(fx.reviewPlan);
  assert.ok(reviewBudget);
  assert.equal(reviewBudget.grantId, grant.grantId);
  const state = await fx.state(), final = state.centralLearningGrants![0]!;

  assert.equal(state.centralLearningGrants!.length, 1);
  assert.equal(state.learningIssues!.length, 1);
  assert.deepEqual(centralLearningSpent(final), { calls: 2, tokens: 1100, steps: 2 });
  assert.equal(final.reservations[0]?.usage?.kind, "unknown");
  assert.equal(reviewBudget.callsRemaining, grant.allowance.maxCalls - 2);
  await review.release();
});

test("a review cannot change the task or fabricate a root backlink to obtain another grant", async t => {
  const fx = await reviewFixture(t), before = await fx.state();
  const forged = { ...fx.reviewPlan, capability: "TEST ONLY forged extra task" };
  const rejected = await enqueueToolLearningPlan(fx.boardRoot, forged);
  assert.equal(rejected.ok, false);
  const funding = createToolLearningFunding({ boardRoot: fx.boardRoot, scope: fx.scope, now: fx.now });

  assert.equal(toolFundingOriginFromBoard(await fx.state(), forged).ok, false);
  assert.equal(await funding.allowance(forged), undefined);
  const after = await fx.state();
  assert.deepEqual(after.centralLearningGrants, before.centralLearningGrants);
  assert.deepEqual(after.learningIssues, before.learningIssues);
});

test("a descendant cannot re-fund a closed original grant or bypass a changed focus decision", async t => {
  const fx = await reviewFixture(t);
  await fx.enqueueReview();
  const identity = toolLearningFundingIdentity(fx.plan), state = await fx.state();
  const issue = state.learningIssues!.find(row => row.issueId === identity.issueId)!;

  assert.ok((await withBoardWriter(fx.boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "TEST_ONLY_refocus", issuedAt: fx.at(),
    action: { kind: "decide", issueId: issue.issueId, expectedRevision: issue.revision, decision: "focused_learning",
      reason: "TEST ONLY a new central focus revision", sourceRefs: [] } }))).ok);
  const funding = createToolLearningFunding({ boardRoot: fx.boardRoot, scope: fx.scope, now: fx.now });

  assert.equal(await funding.allowance(fx.reviewPlan), undefined);
  const focused = await fx.state(), changed = focused.learningIssues!.find(row => row.issueId === identity.issueId)!;

  assert.ok((await withBoardWriter(fx.boardRoot, store => store.apply({ type: "coordinate_learning", commandId: "TEST_ONLY_close", issuedAt: fx.at(),
    action: { kind: "decide", issueId: changed.issueId, expectedRevision: changed.revision, decision: "ordinary_execution",
      reason: "TEST ONLY central veto", sourceRefs: [] } }))).ok);
  assert.equal(await funding.allowance(fx.reviewPlan), undefined);
  const final = await fx.state();
  assert.equal(final.centralLearningGrants!.length, 1);
  assert.equal(final.centralLearningGrants![0]!.status, "closed");
  assert.equal(centralLearningSpent(final.centralLearningGrants![0]!).tokens, 1000);
});

test("a proven review is not counted twice against ordinary daily nomination admission", async t => {
  const fx = await reviewFixture(t, true);
  await fx.enqueueReview();

  for (let index = 1; index <= 2; index++) {
    const ordinary: ToolLearningPlan = { ...fx.plan, trigger: { ...fx.plan.trigger, runId: `TEST_ONLY_new_task_${index}`,
      proposalKey: `TEST_ONLY_new_problem_${index}`, evidenceRefs: [] } };
    const queued = await enqueueToolLearningPlan(fx.boardRoot, ordinary);
    assert.ok(queued.ok);
  }

  const fourth: ToolLearningPlan = { ...fx.plan, trigger: { ...fx.plan.trigger, runId: "TEST_ONLY_fourth_task",
    proposalKey: "TEST_ONLY_fourth_problem", evidenceRefs: [] } };
  const refused = await enqueueToolLearningPlan(fx.boardRoot, fourth);
  assert.equal(refused.ok, false);

  if (!refused.ok) assert.equal(refused.code, "automatic_proposal_daily_limit");

  assert.equal((await fx.state()).centralLearningGrants!.length, 1, "admission and its continuation cannot issue another grant");
});

test("a partially materialized review is left for zero-provider inquiry recovery instead of ordinary dispatch", async t => {
  const fx = await reviewFixture(t), before = await fx.state();
  const queued = await enqueueToolLearningPlan(fx.boardRoot, fx.reviewPlan);
  assert.ok(queued.ok);
  const next = await nextToolLearningDispatch(fx.boardRoot, fx.scope, true, [fx.reviewJobId]);
  assert.ok(next.ok);
  assert.equal(next.jobId, undefined);
  const after = await fx.state();

  assert.equal(after.jobs.find(row => row.jobId === fx.reviewJobId)?.state, "queued");
  assert.equal(after.jobs.find(row => row.jobId === fx.reviewJobId)?.attempt, 0);
  assert.deepEqual(after.centralLearningGrants, before.centralLearningGrants);
});
