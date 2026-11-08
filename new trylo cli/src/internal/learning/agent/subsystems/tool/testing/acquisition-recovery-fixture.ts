import { testScratchPath } from "../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { npmInstallId } from "../../../../../tooling/contract/npm-install.js";
import { npmTreeTestData } from "../adapters/acquisition/npm-install-test-support.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { resultVersionId } from "../domain/evolution/pipeline.js";
import type { ToolLearningDecision } from "../domain/evolution/learning-plan.js";
import { toolLearningDecisionVersionId } from "../domain/evolution/decision-identity.js";
import { acquisitionAdaptationJobId } from "../domain/evolution/acquisition-identity.js";
import { enqueueToolLearningPlan } from "../runtime/pipeline-queue.js";
import { savePipelineAsset } from "../runtime/pipeline-assets.js";
import { recordToolAcquisitionInstalled, saveToolAcquisitionPlan } from "../runtime/acquisition-continuation.js";
import { claimAcquisitionAdaptation } from "../runtime/acquisition-adaptation-jobs.js";
import { createToolLearningFunding } from "../runtime/learning-funding.js";

/** TEST ONLY Board/central-budget lifecycle. Installed receipt is synthetic;
 * this fixture never asserts package acquisition, model or isolation acceptance. */
export async function acquisitionRecoveryFixture(t: TestContext, options: { readonly funded?: boolean; readonly fundingAt?: number; readonly queuedOnly?: boolean;
  readonly evidenceRefs?: readonly string[]; readonly triggerAction?: string; readonly centralScope?: string } = {}) {
  const base = testScratchPath("acquisition-recovery-tests");
  await mkdir(base, { recursive: true });
  const boardRoot = await mkdtemp(path.join(base, "case-"));
  assert.equal(path.dirname(boardRoot), base);
  t.after(() => rm(boardRoot, { recursive: true, force: true }));
  let clock = 0;
  const now = () => clock, at = () => new Date(clock).toISOString(), data = npmTreeTestData(), scope = data.plan.tree.scope;
  const centralScope = options.centralScope ?? scope;
  const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope, capability: "TEST ONLY recover exact npm worker",
    createdAt: at(), trigger: { runId: "recovery-test", proposalKey: "recovery", action: options.triggerAction ?? "user_requested", evidenceRefs: options.evidenceRefs ?? [] } };
  const enqueued = await enqueueToolLearningPlan(boardRoot, plan);
  assert.ok(enqueued.ok);
  const jobId = enqueued.jobId, decision: ToolLearningDecision = { action: "acquire", candidate: { platform: "npm", id: "test-cli", version: "1.0.0" },
    rationale: "TEST ONLY", existingInsufficiency: "TEST ONLY", expectedBenefit: "TEST ONLY", constructionCost: "TEST ONLY",
    alternatives: ["keep current"], adaptation: "TEST ONLY existing npm API" };
  const approvalId = toolLearningDecisionVersionId({ jobId, attempt: 1, decision, step: 1 });

  await withBoardWriter(boardRoot, async store => {
    assert.ok((await store.apply({ type: "start_job", commandId: "test-original-start", issuedAt: at(), jobId })).ok);
  });

  if (options.funded !== false) {
    const originalFunding = createToolLearningFunding({ boardRoot, scope, centralScope, now });
    assert.ok(await originalFunding.allowance(plan));
    await originalFunding.release();
  }

  await withBoardWriter(boardRoot, async store => {
    assert.ok((await savePipelineAsset(store, { versionId: approvalId, kind: "workflow", scope, source: "inferred", issuedAt: at(),
      content: { type: "tool_learning_decision", schemaVersion: 1, jobId, attempt: 1, step: 1, decision } })).ok);
    assert.ok((await savePipelineAsset(store, { versionId: resultVersionId(jobId, 1), kind: "workflow", scope, source: "inferred", issuedAt: at(),
      content: { type: "tool_learning_result", schemaVersion: 1, jobId, attempt: 1, outcome: "waiting_approval", code: "acquisition_approval_required",
        search: { status: "complete", candidates: [{ ...decision.candidate, sourceUrl: "https://www.npmjs.com/package/test-cli", licenseSpdx: "MIT" }], failures: [] },
        occurredAt: at(), decision, decisionVersionId: approvalId } })).ok);
    assert.ok((await store.apply({ type: "complete_job", commandId: "test-original-finish", issuedAt: at(), jobId, next: "waiting_approval" })).ok);
  });
  assert.ok((await saveToolAcquisitionPlan({ boardRoot, jobId, scope, approvalId, plan: data.plan, issuedAt: at() })).ok);
  assert.ok((await recordToolAcquisitionInstalled({ boardRoot, jobId, scope, approvalId, plan: data.plan,
    grantId: "TEST_ONLY_synthetic_installed_receipt", issuedAt: at() })).ok);
  const childJobId = acquisitionAdaptationJobId(jobId, approvalId, npmInstallId(data.plan));

  if (options.queuedOnly) await withBoardWriter(boardRoot, async store => {
    assert.ok((await store.apply({ type: "enqueue_job", commandId: `${childJobId}:enqueue`, issuedAt: at(),
      job: { jobId: childJobId, observationId: jobId, domain: "tool", scope, maxAttempts: 3, dedupeKey: childJobId } })).ok);
  });

  const input = { boardRoot, jobId, scope, approvalId, childJobId, attempt: 1, now };
  const claim = await claimAcquisitionAdaptation({ ...input, workspaceId: scope });
  assert.ok(claim.ok && !claim.completed);
  clock = options.fundingAt ?? 0;
  const funding = createToolLearningFunding({ boardRoot, scope, centralScope, now, continuationJobId: childJobId });

  if (options.funded !== false) {
    assert.ok(await funding.allowance(plan));
    assert.ok((await funding.reserve("TEST_ONLY_pending_call", 1000)).ok);
  }

  const state = async () => {
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };

  return { ...input, centralScope, data, plan, funding, state, at, setNow: (value: number) => { clock = value },
    admission: { jobId: childJobId, attempt: 1 }, workspaceId: scope };
}
