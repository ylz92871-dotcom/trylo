import assert from "node:assert/strict";
import test from "node:test";
import { withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { centralLearningSpent } from "../../../../control/coordination-contract.js";
import { npmInstallId } from "../../../../../tooling/contract/npm-install.js";
import { acquisitionRecoveryFixture } from "../testing/acquisition-recovery-fixture.js";
import { toolLearningFundingIdentity } from "../domain/evolution/funding-identity.js";
import { reviewAcquisitionAdaptationRecovery, acquisitionRecoveryFromBoard, acquisitionRecoveryFenceId } from "./acquisition-adaptation-recovery-review.js";
import { recoverExpiredAcquisitionAdaptation } from "./acquisition-adaptation-operator-recovery.js";
import { claimAcquisitionAdaptation } from "./acquisition-adaptation-jobs.js";
import { createToolLearningFunding } from "./learning-funding.js";
import { saveNpmLearningArtifact } from "./npm-adaptation-artifacts.js";
import { acquisitionAdaptationClaimActive } from "./acquisition-adaptation-lease.js";
import { monitorToolJob } from "./pipeline-monitor.js";
import { prepareAcquisitionFundingRestart } from "./acquisition-funding-restart.js";
import { contentHashOf } from "../../../../control/hash.js";

test("a current worker cannot be recovered and a later central claim protects it beyond the pre-funding lease", async t => {
  const fx = await acquisitionRecoveryFixture(t, { fundingAt: 300_000 });

  fx.setNow(600_001);
  const view = await reviewAcquisitionAdaptationRecovery(fx);
  assert.ok(view.ok);
  assert.equal(view.recoverable, false);
  assert.equal(view.code, "acquisition_claim_active");
  assert.equal(view.expiresAt, new Date(900_000).toISOString());
  assert.equal((await recoverExpiredAcquisitionAdaptation({ ...fx, reviewId: `tool-adaptation-recovery-review_v1_${"0".repeat(64)}` })).ok, false);
  const binding = { originalJobId: fx.jobId, approvalId: fx.approvalId, installationId: npmInstallId(fx.data.plan),
    jobId: fx.childJobId, attempt: 1, scope: fx.scope, plan: fx.plan };
  const monitor = monitorToolJob({ boardRoot: fx.boardRoot, ...fx.admission, signal: new AbortController().signal,
    claimActive: state => acquisitionAdaptationClaimActive(state, { ...binding, now: fx.now() }) });

  t.after(() => monitor.close());
  await monitor.check();
  assert.equal(monitor.signal.aborted, false);
  fx.setNow(900_001);
  await monitor.check();
  assert.equal(monitor.signal.aborted, true);
});

test("workspace-root funding survives npm child admission, monitoring and exact expired recovery", async t => {
  const fx = await acquisitionRecoveryFixture(t, { centralScope: "D:\\workspace\\tool-central-budget" });
  const binding = { originalJobId: fx.jobId, approvalId: fx.approvalId, installationId: npmInstallId(fx.data.plan),
    jobId: fx.childJobId, attempt: 1, scope: fx.scope, plan: fx.plan, now: fx.now() };
  const state = await fx.state();
  assert.notEqual(fx.scope, fx.centralScope);
  assert.equal(state.centralLearningGrants![0]!.scope, fx.centralScope);
  assert.equal(acquisitionAdaptationClaimActive(state, binding), true);
  const issue = state.learningIssues![0]!;

  assert.equal(acquisitionAdaptationClaimActive({ ...state, learningIssues: [{ ...issue, scope: "foreign-root" }] }, binding), false);
  const current = await reviewAcquisitionAdaptationRecovery(fx);
  assert.ok(current.ok);
  assert.equal(current.code, "acquisition_claim_active");
  fx.setNow(600_001);
  const expired = await reviewAcquisitionAdaptationRecovery(fx);
  assert.ok(expired.ok && expired.recoverable && expired.reviewId);
  assert.ok((await recoverExpiredAcquisitionAdaptation({ ...fx, reviewId: expired.reviewId })).ok);
  const next = await claimAcquisitionAdaptation(fx);
  assert.ok(next.ok && !next.completed);
  assert.equal(next.admission.attempt, 2);
  const funding = createToolLearningFunding({ boardRoot: fx.boardRoot, scope: fx.scope, centralScope: fx.centralScope, now: fx.now, continuationJobId: fx.childJobId });
  const allowance = await funding.allowance(fx.plan);
  assert.ok(allowance);
  assert.equal(allowance.grantId, toolLearningFundingIdentity(fx.plan).grantId);
  assert.equal(allowance.callsRemaining, 7);
  await funding.release();
  assert.equal((await fx.state()).centralLearningGrants!.length, 1);
});

test("explicit expired recovery fences old writes, charges unknown calls and resumes only within the original grant", async t => {
  const fx = await acquisitionRecoveryFixture(t), initial = await fx.state();
  const grantId = toolLearningFundingIdentity(fx.plan).grantId, firstGrant = initial.centralLearningGrants!.find(row => row.grantId === grantId)!;
  const spent = centralLearningSpent(firstGrant);

  fx.setNow(600_001);
  const view = await reviewAcquisitionAdaptationRecovery(fx);
  assert.ok(view.ok && view.recoverable && view.reviewId);
  const selection = { ...fx, reviewId: view.reviewId };

  assert.ok((await recoverExpiredAcquisitionAdaptation(selection)).ok);
  assert.ok((await recoverExpiredAcquisitionAdaptation(selection)).ok, "same explicit recovery is idempotent");
  const recovered = await fx.state(), grant = recovered.centralLearningGrants!.find(row => row.grantId === grantId)!;

  assert.equal(recovered.jobs.find(row => row.jobId === fx.childJobId)?.state, "waiting_evidence");
  assert.deepEqual(centralLearningSpent(grant), spent);
  assert.equal(grant.claim, undefined);
  assert.ok(grant.reservations.every(row => row.state === "settled" && row.usage?.kind === "unknown"));
  const late = await saveNpmLearningArtifact({ ...fx, scope: fx.scope, versionId: "TEST_ONLY_late_output", content: { source: "TEST ONLY" }, issuedAt: fx.at() });

  assert.ok(!late.ok && late.code === "stale_job_result");
  assert.equal((await fx.funding.reserve("TEST_ONLY_late_model_call", 1000)).ok, false);
  const second = await claimAcquisitionAdaptation(fx);
  assert.ok(second.ok && !second.completed);
  assert.equal(second.admission.attempt, 2);
  const funding = createToolLearningFunding({ boardRoot: fx.boardRoot, scope: fx.scope, now: fx.now, continuationJobId: fx.childJobId });
  const allowance = await funding.allowance(fx.plan);
  assert.ok(allowance);
  assert.equal(allowance.grantId, grantId);
  assert.equal(allowance.callsRemaining, firstGrant.allowance.maxCalls - 1);
  assert.equal(allowance.tokensRemaining, firstGrant.allowance.maxTokens - 1000);
  assert.equal((await recoverExpiredAcquisitionAdaptation(selection)).ok, false, "old recovery cannot fence attempt two");
});

test("a crash after the fence can finish cleanup without replaying any model, install or permission operation", async t => {
  const fx = await acquisitionRecoveryFixture(t);
  fx.setNow(600_001);
  const view = await reviewAcquisitionAdaptationRecovery(fx);
  assert.ok(view.ok && view.recoverable && view.reviewId);
  const fenced = await withBoardWriter(fx.boardRoot, store => store.apply({ type: "complete_job", commandId: acquisitionRecoveryFenceId(fx.childJobId, 1, view.reviewId!),
    issuedAt: fx.at(), jobId: fx.childJobId, next: "waiting_evidence" }));
  assert.ok(fenced.ok);
  assert.ok((await recoverExpiredAcquisitionAdaptation({ ...fx, reviewId: view.reviewId })).ok);
  const state = await fx.state();
  assert.equal(state.centralLearningGrants![0]!.reservations[0]?.usage?.kind, "unknown");
  assert.equal(state.jobs.find(row => row.jobId === fx.childJobId)?.attempt, 1);
});

test("stopped-attempt cleanup preserves spent budget without burning an attempt on another active owner", async t => {
  const fx = await acquisitionRecoveryFixture(t), first = await fx.state();
  const protectedOwner = await withBoardWriter(fx.boardRoot, store => prepareAcquisitionFundingRestart(store, { plan: fx.plan, child: undefined, issuedAt: fx.at() }));

  assert.ok("ok" in protectedOwner && !protectedOwner.ok && "code" in protectedOwner && protectedOwner.code === "learning_claim_active");
  assert.equal((await fx.state()).jobs.find(row => row.jobId === fx.childJobId)?.attempt, 1);
  const stopped = await withBoardWriter(fx.boardRoot, store => store.apply({ type: "complete_job", commandId: "TEST_ONLY_failed_worker_finished",
    issuedAt: fx.at(), jobId: fx.childJobId, next: "waiting_evidence" }));
  assert.ok(stopped.ok);
  const resumed = await claimAcquisitionAdaptation(fx);
  assert.ok(resumed.ok && !resumed.completed);
  assert.equal(resumed.admission.attempt, 2);
  const next = await fx.state();

  assert.deepEqual(centralLearningSpent(next.centralLearningGrants![0]!), centralLearningSpent(first.centralLearningGrants![0]!));
  assert.equal(next.centralLearningGrants![0]!.claim, undefined);
  assert.equal(next.centralLearningGrants![0]!.reservations[0]?.usage?.kind, "unknown");
});

test("closed grants keep epoch reservations charged and cannot spend another child attempt after recovery", async t => {
  const fx = await acquisitionRecoveryFixture(t);

  assert.ok((await fx.funding.reserve("TEST_ONLY_second_pending_call", 500)).ok);
  assert.ok((await fx.funding.settle("TEST_ONLY_pending_call", { kind: "reported", totalTokens: 2000 })).ok);
  const before = (await fx.state()).centralLearningGrants![0]!;
  assert.equal(before.status, "closed");
  fx.setNow(600_001);
  const view = await reviewAcquisitionAdaptationRecovery(fx);
  assert.ok(view.ok && view.recoverable && view.reviewId);
  assert.equal(view.budget.claimId, undefined);
  assert.equal(view.budget.pendingReservations, 1);
  const selected = { ...fx, reviewId: view.reviewId };

  assert.ok((await recoverExpiredAcquisitionAdaptation(selected)).ok);
  assert.ok((await recoverExpiredAcquisitionAdaptation(selected)).ok);
  const after = (await fx.state()).centralLearningGrants![0]!;

  assert.equal(after.status, "closed");
  assert.deepEqual(centralLearningSpent(after), centralLearningSpent(before));
  assert.equal(after.reservations.find(row => row.reservationId === "TEST_ONLY_second_pending_call")?.usage?.kind, "unknown");
  const retry = await claimAcquisitionAdaptation(fx);
  assert.ok(!retry.ok);
  assert.equal(retry.code, "learning_grant_closed");
  assert.equal((await fx.state()).jobs.find(row => row.jobId === fx.childJobId)?.attempt, 1);
});

test("a pre-funding crash has a durable expiry while unleased legacy age remains unknown", async t => {
  const fx = await acquisitionRecoveryFixture(t, { funded: false, queuedOnly: true });

  fx.setNow(600_001);
  const state = await fx.state(), view = await reviewAcquisitionAdaptationRecovery(fx);
  assert.ok(view.ok && view.recoverable && view.reviewId);
  const legacy = acquisitionRecoveryFromBoard({ ...state, assets: state.assets.filter(row => !(typeof row.content === "object" && row.content !== null
    && "type" in row.content && row.content.type === "tool_acquisition_adaptation_lease")) }, fx);

  assert.ok(legacy.ok);
  assert.equal(legacy.view.recoverable, false);
  assert.equal(legacy.view.code, "acquisition_claim_expiry_unknown");
  assert.ok((await recoverExpiredAcquisitionAdaptation({ ...fx, reviewId: view.reviewId })).ok);
  assert.equal((await fx.state()).centralLearningGrants?.length ?? 0, 0, "recovery does not invent a budget grant");
});

test("an invalid candidate-shaped asset is a typed corruption diagnostic instead of a false ready result", async t => {
  const fx = await acquisitionRecoveryFixture(t);
  fx.setNow(600_001);
  const state = await fx.state(), asset = state.assets[0]!;
  const content = { type: "npm_tool_production_package", learning: { jobId: fx.childJobId, attempt: 1 }, source: "TEST ONLY incomplete asset" };
  const corrupted = { ...state, assets: [...state.assets, { ...asset, versionId: `tool-production_v1_${"f".repeat(64)}`, content, contentHash: contentHashOf(content) }] };
  const result = acquisitionRecoveryFromBoard(corrupted, fx);

  assert.ok(!result.ok);
  assert.equal(result.code, "invalid_continuation_candidate");
  assert.equal((await fx.state()).jobs.find(row => row.jobId === fx.childJobId)?.state, "running");
});

test("wrong binding or stale budget review cannot recover another attempt and three attempts remain the hard ceiling", async t => {
  const fx = await acquisitionRecoveryFixture(t);
  fx.setNow(600_001);
  const view = await reviewAcquisitionAdaptationRecovery(fx);
  assert.ok(view.ok && view.recoverable && view.reviewId);

  for (const change of [{ scope: "workspace:other" }, { approvalId: `tool-decision_v1_${"f".repeat(64)}` }, { attempt: 2 }, { childJobId: `tool-adaptation_v1_${"f".repeat(64)}` }]) {
    assert.equal((await recoverExpiredAcquisitionAdaptation({ ...fx, reviewId: view.reviewId, ...change })).ok, false);
  }

  assert.equal((await recoverExpiredAcquisitionAdaptation({ ...fx, reviewId: `tool-adaptation-recovery-review_v1_${"0".repeat(64)}` })).ok, false);
  assert.ok((await fx.funding.settle("TEST_ONLY_pending_call", { kind: "reported", totalTokens: 50 })).ok);
  assert.equal((await recoverExpiredAcquisitionAdaptation({ ...fx, reviewId: view.reviewId })).ok, false, "a late actual usage receipt changes the exact review");
  const current = await reviewAcquisitionAdaptationRecovery(fx);
  assert.ok(current.ok && current.recoverable && current.reviewId);
  assert.ok((await recoverExpiredAcquisitionAdaptation({ ...fx, reviewId: current.reviewId })).ok);

  for (const attempt of [2, 3]) {
    const claim = await claimAcquisitionAdaptation(fx);
    assert.ok(claim.ok && !claim.completed);
    assert.equal(claim.admission.attempt, attempt);
    fx.setNow(fx.now() + 600_001);
    const next = await reviewAcquisitionAdaptationRecovery({ ...fx, attempt });
    assert.ok(next.ok && next.recoverable && next.reviewId);
    const recovered = await recoverExpiredAcquisitionAdaptation({ ...fx, attempt, reviewId: next.reviewId });
    assert.ok(recovered.ok);
    assert.equal(recovered.canResume, attempt < 3);
  }

  assert.equal((await claimAcquisitionAdaptation(fx)).ok, false);
  assert.equal((await fx.state()).jobs.find(row => row.jobId === fx.childJobId)?.attempt, 3);
});
