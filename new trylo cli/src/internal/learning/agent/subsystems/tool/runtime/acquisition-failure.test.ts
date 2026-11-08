import { testScratchPath } from "../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { createFilePermissionStore } from "../../../../../adapters/permission-store/file-ledger.js";
import { contentHashOf } from "../../../../control/hash.js";
import { decodeToolAcquisitionFailure, toolAcquisitionFailureVersion } from "../domain/evolution/acquisition-failure.js";
import { toolLearningDecisionVersionId } from "../domain/evolution/decision-identity.js";
import type { ToolLearningDecision } from "../domain/evolution/learning-plan.js";
import { boundToolLearningContext } from "../domain/evolution/learning-context-budget.js";
import { resultVersionId, type ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { npmTreeTestData } from "../adapters/acquisition/npm-install-test-support.js";
import { acquireLearningChoice } from "../adapters/acquisition/learning-acquisition-host.js";
import { enqueueToolLearningPlan, waitingToolJobReady } from "./pipeline-queue.js";
import { savePipelineAsset } from "./pipeline-assets.js";
import { recordToolAcquisitionFailure } from "./acquisition-failure.js";
import { toolAcquisitionFailureFromBoard, toolLearningAcquisitionFailures } from "./acquisition-failure-reader.js";
import { reviewToolLearningAcquisition } from "./acquisition-review.js";
import { recordToolAcquisitionInstalled, saveToolAcquisitionPlan } from "./acquisition-continuation.js";
import { toolLearningInputFingerprint } from "./pipeline-planning.js";
import { npmInstallId } from "../../../../../tooling/contract/npm-install.js";
import { workToolLearningPipeline } from "./pipeline-worker.js";

async function fixture(t: TestContext) {
  const base = testScratchPath("acquisition-failure-tests");
  await mkdir(base, { recursive: true });
  const boardRoot = await mkdtemp(path.join(base, "case-"));
  assert.equal(path.dirname(boardRoot), base);
  t.after(() => rm(boardRoot, { recursive: true, force: true }));
  const data = npmTreeTestData(), scope = data.plan.tree.scope, issuedAt = new Date(0).toISOString();
  const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope, capability: "TEST ONLY acquisition failure",
    trigger: { runId: "TEST_ONLY", proposalKey: "TEST_ONLY", evidenceRefs: [], action: "user_requested" }, createdAt: issuedAt };
  const queued = await enqueueToolLearningPlan(boardRoot, plan);
  assert.ok(queued.ok);
  const jobId = queued.jobId;
  const decision: ToolLearningDecision = { action: "acquire", candidate: { platform: "npm", id: "test-cli", version: "1.0.0" }, adaptation: "TEST ONLY",
    rationale: "TEST ONLY", existingInsufficiency: "TEST ONLY", expectedBenefit: "TEST ONLY", constructionCost: "TEST ONLY", alternatives: [] };
  const approvalId = toolLearningDecisionVersionId({ jobId, attempt: 1, step: 1, decision });

  await withBoardWriter(boardRoot, async store => {
    assert.ok((await store.apply({ type: "start_job", commandId: "TEST_ONLY_start", issuedAt, jobId })).ok);
    assert.ok((await savePipelineAsset(store, { versionId: approvalId, kind: "workflow", scope, source: "inferred", issuedAt,
      content: { type: "tool_learning_decision", schemaVersion: 1, jobId, attempt: 1, step: 1, decision } })).ok);
    assert.ok((await savePipelineAsset(store, { versionId: resultVersionId(jobId, 1), kind: "workflow", scope, source: "inferred", issuedAt,
      content: { type: "tool_learning_result", schemaVersion: 1, jobId, attempt: 1, occurredAt: issuedAt, outcome: "waiting_approval", code: "acquisition_approval_required",
        search: { status: "complete", candidates: [{ ...decision.candidate, sourceUrl: "https://www.npmjs.com/package/test-cli", licenseSpdx: "MIT" }], failures: [] }, decision, decisionVersionId: approvalId } })).ok);
    assert.ok((await store.apply({ type: "complete_job", commandId: "TEST_ONLY_finish", issuedAt, jobId, next: "waiting_approval" })).ok);
  });
  const state = async () => {
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };

  return { boardRoot, jobId, approvalId, scope, plan, data, issuedAt, state };
}

test("a real host resolver-unavailable failure survives remount without granting, consuming a learning attempt or changing the approved decision", async t => {
  const fx = await fixture(t), before = await fx.state();
  let grants = 0, transportCalls = 0;
  const run = () => acquireLearningChoice({ ...fx, now: () => 1, installationRoot: path.join(fx.boardRoot, "install"), target: fx.data.target,
    resolution: { nodeExecutable: process.execPath, npmCli: "", scratchRoot: path.join(fx.boardRoot, "scratch") }, signal: new AbortController().signal,
    approval: createFilePermissionStore({ path: path.join(fx.boardRoot, "TEST_ONLY_permissions") }), issueGrant: async () => {
      grants++;
      throw new Error("TEST ONLY never issue");
    },
    transport: { get: async () => {
      transportCalls++;
      throw new Error("TEST ONLY never fetch");
    } } });
  const failed = await run();
  assert.ok(!failed.ok);
  assert.equal(failed.code, "npm_resolver_unavailable");
  assert.ok("failureRef" in failed);
  const after = await fx.state(), view = await reviewToolLearningAcquisition(fx.boardRoot, fx.jobId, fx.scope);
  assert.ok(view.ok);
  assert.equal(view.failure?.code, "npm_resolver_unavailable");
  assert.equal(view.failure?.recovery, "retry_explicitly");
  assert.equal(grants, 0);
  assert.equal(transportCalls, 0);
  assert.equal(after.jobs.find(row => row.jobId === fx.jobId)?.state, "waiting_approval");
  assert.equal(after.jobs.find(row => row.jobId === fx.jobId)?.attempt, 1);
  assert.equal(after.centralLearningGrants?.length ?? 0, 0);
  assert.equal(contentHashOf(after.assets.find(row => row.versionId === fx.approvalId)), contentHashOf(before.assets.find(row => row.versionId === fx.approvalId)));
  const fingerprint = toolLearningInputFingerprint(after, fx.plan);
  assert.notEqual(fingerprint, toolLearningInputFingerprint(before, fx.plan));
  assert.ok(!(await run()).ok);
  const replay = await fx.state();

  assert.equal(replay.assets.filter(row => row.versionId.startsWith("tool-acquisition-failure_v1_")).length, 1);
  assert.equal(toolLearningInputFingerprint(replay, fx.plan), fingerprint);
  assert.equal(grants, 0);
});

test("canonical failure observations exclude private diagnostic prose and bind exact scope and decision", async t => {
  const fx = await fixture(t), failure = { code: "npm_shrinkwrap_unsupported", message: "TEST ONLY private stderr", retainedScratchDirectory: "D:/TEST_ONLY_private",
    diagnostics: [{ packageName: "leaf", version: "1.1.0", stage: "selected_archive_semantics", code: "npm_shrinkwrap_unsupported", stderr: "TEST ONLY must disappear" }] };
  const saved = await recordToolAcquisitionFailure({ ...fx, phase: "resolve", failure });
  assert.ok(saved.ok);
  const state = await fx.state(), read = toolAcquisitionFailureFromBoard(state, saved.versionId, fx.scope);
  assert.ok(read.ok);
  assert.equal(JSON.stringify(read.failure).includes("private"), false);
  assert.equal(JSON.stringify(read.failure).includes("stderr"), false);
  assert.equal(decodeToolAcquisitionFailure({ ...read.failure, ref: undefined }), undefined, "the persisted shape cannot acquire projection keys");
  const { ref: _ref, ...content } = read.failure;
  assert.ok(decodeToolAcquisitionFailure(content));
  assert.equal(toolAcquisitionFailureVersion(content), saved.versionId);
  assert.equal(toolAcquisitionFailureFromBoard(state, saved.versionId, "TEST_ONLY_other_scope").ok, false);
  assert.equal((await recordToolAcquisitionFailure({ ...fx, phase: "resolve", failure, approvalId: `tool-decision_v1_${"0".repeat(64)}` })).ok, false);
  const corrupted = { ...state, assets: state.assets.map(row => row.versionId === saved.versionId ? { ...row, contentHash: "0".repeat(64) } : row) };

  assert.equal(toolAcquisitionFailureFromBoard(corrupted, saved.versionId, fx.scope).ok, false);
});

test("installed progress supersedes the visible old failure while a later explicit task can still read its safe historical fact", async t => {
  const fx = await fixture(t), saved = await recordToolAcquisitionFailure({ ...fx, phase: "resolve", failure: { code: "npm_shrinkwrap_unsupported" } });
  assert.ok(saved.ok);
  assert.ok((await saveToolAcquisitionPlan({ ...fx, plan: fx.data.plan })).ok);
  assert.ok((await recordToolAcquisitionInstalled({ ...fx, plan: fx.data.plan, grantId: "TEST_ONLY_synthetic_receipt" })).ok);
  const view = await reviewToolLearningAcquisition(fx.boardRoot, fx.jobId, fx.scope);
  assert.ok(view.ok);
  assert.equal(view.installation?.installationId, npmInstallId(fx.data.plan));
  assert.equal(view.installation?.installed, true);
  assert.equal(view.failure, undefined);
  const newPlan = { ...fx.plan, trigger: { ...fx.plan.trigger, runId: "TEST_ONLY_new_user_task", evidenceRefs: [saved.versionId] } };
  const historical = toolLearningAcquisitionFailures(await fx.state(), newPlan);
  assert.ok(historical.ok);
  assert.equal(historical.failures[0]?.ref, saved.versionId);
  const context = boundToolLearningContext({ plan: newPlan, availableTools: [], priorVersions: [], groundedSamples: [], requirements: [], search: { status: "complete", candidates: [], failures: [] },
    allowance: { grantId: "TEST_ONLY_no_real_grant", maxCalls: 1, maxTokens: 16000, callsRemaining: 1, tokensRemaining: 16000, maxPromptChars: 24000 }, acquisitionFailures: historical.failures });

  assert.ok(context);
  assert.equal(context.acquisitionFailures?.[0]?.ref, saved.versionId);
  assert.equal((await fx.state()).jobs.length, 1, "reading evidence does not start an investigation or acquisition child");
});

test("stop-unconfirmed records an unknown stop and never claims an installation or terminal task", async t => {
  const fx = await fixture(t);
  assert.ok((await recordToolAcquisitionFailure({ ...fx, phase: "resolve", failure: { code: "npm_resolver_stop_unconfirmed" } })).ok);
  const view = await reviewToolLearningAcquisition(fx.boardRoot, fx.jobId, fx.scope);
  assert.ok(view.ok);
  assert.equal(view.failure?.recovery, "await_stop");
  assert.equal(view.installation, undefined);
  assert.equal(view.continuation, undefined);
  assert.equal((await fx.state()).jobs[0]?.state, "waiting_approval");
});

test("unrelated acquisition failures do not wake a capability while an explicit ref can reuse the exact historical fact", async t => {
  const fx = await fixture(t), before = await fx.state(), otherPlan = { ...fx.plan, capability: "TEST ONLY unrelated capability",
    trigger: { ...fx.plan.trigger, proposalKey: "TEST_ONLY_unrelated" } };
  const beforeFingerprint = toolLearningInputFingerprint(before, otherPlan);
  const queued = await enqueueToolLearningPlan(fx.boardRoot, otherPlan);
  assert.ok(queued.ok);
  await withBoardWriter(fx.boardRoot, async store => {
    assert.ok((await store.apply({ type: "start_job", commandId: "TEST_ONLY_other_start", issuedAt: fx.issuedAt, jobId: queued.jobId })).ok);
    assert.ok((await savePipelineAsset(store, { versionId: resultVersionId(queued.jobId, 1), kind: "workflow", scope: fx.scope, source: "inferred", issuedAt: fx.issuedAt,
      content: { type: "tool_learning_result", schemaVersion: 1, jobId: queued.jobId, attempt: 1, outcome: "waiting_evidence", code: "verification_recipe_required",
        occurredAt: fx.issuedAt, inputFingerprint: beforeFingerprint, search: { status: "complete", candidates: [], failures: [] } } })).ok);
    assert.ok((await store.apply({ type: "complete_job", commandId: "TEST_ONLY_other_wait", issuedAt: fx.issuedAt, jobId: queued.jobId, next: "waiting_evidence" })).ok);
  });
  const saved = await recordToolAcquisitionFailure({ ...fx, phase: "resolve", failure: { code: "npm_shrinkwrap_unsupported" } });
  assert.ok(saved.ok);
  const after = await fx.state(), unrelated = toolLearningAcquisitionFailures(after, otherPlan);
  assert.ok(unrelated.ok);
  assert.deepEqual(unrelated.failures, []);
  assert.equal(toolLearningInputFingerprint(after, otherPlan), beforeFingerprint);
  const waiting = after.jobs.find(job => job.jobId === queued.jobId);
  assert.ok(waiting);
  assert.equal(waitingToolJobReady(after, waiting, otherPlan, "after_turn", false), false);
  const worked = await workToolLearningPipeline({ boardRoot: fx.boardRoot, scope: fx.scope, now: () => 1, mode: "after_turn", signal: new AbortController().signal,
    services: { allowance: async () => { assert.fail("unrelated failure cannot request funds"); }, plan: async () => { assert.fail("unrelated failure cannot start paid planning"); },
      search: async () => { assert.fail("unrelated failure cannot start discovery"); }, evolve: async () => { assert.fail("unrelated failure cannot construct code"); } } });

  assert.ok(worked.ok);
  assert.deepEqual(worked.results, []);
  assert.equal((await fx.state()).jobs.find(job => job.jobId === queued.jobId)?.attempt, 1);
  const unknown = toolLearningAcquisitionFailures(after, { scope: fx.scope, trigger: { evidenceRefs: [] } });
  assert.ok(unknown.ok);
  assert.deepEqual(unknown.failures, []);
  const explicitPlan = { ...otherPlan, trigger: { ...otherPlan.trigger, evidenceRefs: [saved.versionId] } };
  const explicit = toolLearningAcquisitionFailures(after, explicitPlan);
  assert.ok(explicit.ok);
  assert.equal(explicit.failures[0]?.ref, saved.versionId);
  assert.notEqual(toolLearningInputFingerprint(after, explicitPlan), beforeFingerprint);
});
