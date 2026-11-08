import { testScratchPath } from "../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { createFilePermissionStore } from "../../../../../adapters/permission-store/file-ledger.js";
import { ok } from "../../../../../tooling/contract/result.js";
import { centralLearningSpent } from "../../../../control/coordination-contract.js";
import { contentHashOf } from "../../../../control/hash.js";
import { npmTreeTestData } from "../adapters/acquisition/npm-install-test-support.js";
import { planNpmLockedTree } from "../adapters/acquisition/npm-tree-plan.js";
import { acquireLearningChoice } from "../adapters/acquisition/learning-acquisition-host.js";
import type { NpmInstallPlan } from "../../../../../tooling/contract/npm-install.js";
import { toolLearningDecisionVersionId } from "../domain/evolution/decision-identity.js";
import { resultVersionId, type ToolLearningPlan } from "../domain/evolution/pipeline.js";
import type { ToolLearningDecision } from "../domain/evolution/learning-plan.js";
import { enqueueToolLearningPlan } from "./pipeline-queue.js";
import { savePipelineAsset } from "./pipeline-assets.js";
import { recordToolAcquisitionFailure } from "./acquisition-failure.js";
import { createToolLearningFunding } from "./learning-funding.js";
import { readToolAcquisition, recordToolAcquisitionInstalled, saveToolAcquisitionPlan } from "./acquisition-continuation.js";
import { reviewAcquisitionInquiry } from "./acquisition-inquiry-review.js";
import { runAcquisitionInquiry } from "./acquisition-inquiry.js";
import { recoverExpiredAcquisitionInquiry } from "./acquisition-inquiry-recovery.js";
import { claimAcquisitionAdaptation } from "./acquisition-adaptation-jobs.js";
import { acquisitionInquirySpecFromBoard } from "./acquisition-inquiry-reader.js";
import { committedInquiryDecision } from "./acquisition-inquiry-committed.js";
import { proposedAcquisitionInquiryOutcome, finishAcquisitionInquiry } from "./acquisition-inquiry-result.js";
import { toolAcquisitionFailureFromBoard } from "./acquisition-failure-reader.js";
import { isJsonValue, recordOf } from "../domain/evolution/parse.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import { ToolLearningServiceError } from "../domain/evolution/service-error.js";

const reasoning = { rationale: "TEST ONLY investigate an actual host obstacle", existingInsufficiency: "TEST ONLY", expectedBenefit: "TEST ONLY hypothesis", constructionCost: "TEST ONLY bounded research", alternatives: ["keep existing tools"] };

async function fixture(t: TestContext, options: { funded?: boolean; frozen?: boolean; failureCode?: string; centralScope?: string } = {}) {
  const base = testScratchPath("acquisition-inquiry-tests");
  await mkdir(base, { recursive: true });
  const boardRoot = await mkdtemp(path.join(base, "case-"));
  assert.equal(path.dirname(boardRoot), base);
  t.after(() => rm(boardRoot, { recursive: true, force: true }));
  let clock = 0;
  const now = () => clock, at = () => new Date(clock).toISOString(), data = npmTreeTestData(), scope = data.plan.tree.scope;
  const centralScope = options.centralScope ?? scope;
  const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope, capability: "TEST ONLY same-grant acquisition research", createdAt: at(),
    trigger: { runId: "TEST_ONLY_task", proposalKey: "TEST_ONLY_original", evidenceRefs: ["TEST_ONLY_original_task_contract"], action: "user_requested" } };
  const enqueued = await enqueueToolLearningPlan(boardRoot, plan);
  assert.ok(enqueued.ok);
  const jobId = enqueued.jobId;
  const decision: ToolLearningDecision = { ...reasoning, action: "acquire", candidate: { platform: "npm", id: "test-cli", version: "1.0.0" }, adaptation: "TEST ONLY" };
  const approvalId = toolLearningDecisionVersionId({ jobId, attempt: 1, step: 1, decision });

  await withBoardWriter(boardRoot, async store => {
    assert.ok((await store.apply({ type: "start_job", commandId: "TEST_ONLY_start", issuedAt: at(), jobId })).ok);
    assert.ok((await savePipelineAsset(store, { versionId: approvalId, kind: "workflow", source: "inferred", scope, issuedAt: at(),
      content: { type: "tool_learning_decision", schemaVersion: 1, jobId, attempt: 1, step: 1, decision } })).ok);
    assert.ok((await savePipelineAsset(store, { versionId: resultVersionId(jobId, 1), kind: "workflow", source: "inferred", scope, issuedAt: at(),
      content: { type: "tool_learning_result", schemaVersion: 1, jobId, attempt: 1, occurredAt: at(), outcome: "waiting_approval", code: "acquisition_approval_required", decision, decisionVersionId: approvalId,
        search: { status: "complete", failures: [], candidates: [{ ...decision.candidate, sourceUrl: "https://www.npmjs.com/package/test-cli", licenseSpdx: "MIT" }] } } })).ok);
  });

  if (options.funded !== false) {
    const initial = createToolLearningFunding({ boardRoot, scope, centralScope, now });
    assert.ok(await initial.allowance(plan));
    await initial.release();
  }

  await withBoardWriter(boardRoot, async store => { assert.ok((await store.apply({ type: "complete_job", commandId: "TEST_ONLY_wait", issuedAt: at(), jobId, next: "waiting_approval" })).ok); });

  if (options.frozen) assert.ok((await saveToolAcquisitionPlan({ boardRoot, jobId, scope, approvalId, plan: data.plan, issuedAt: at() })).ok);

  const saved = await recordToolAcquisitionFailure({ boardRoot, jobId, scope, approvalId, issuedAt: at(), phase: options.frozen ? "install" : "resolve",
    failure: { code: options.failureCode ?? (options.frozen ? "quarantine_busy" : "npm_resolver_unavailable") } });
  assert.ok(saved.ok);
  const state = async () => {
    const loaded = await createBoardReader(boardRoot).load();
    assert.ok(loaded.ok);
    return loaded.state;
  };
  let calls = 0, searchCalls = 0;
  const services = async (continuationJobId: string, unconfirmed: boolean | "retain_claim" = false) => {
    const funding = createToolLearningFunding({ boardRoot, scope, centralScope, now, continuationJobId });
    return { allowance: (value: ToolLearningPlan) => funding.allowance(value),
      plan: async (context: import("../domain/evolution/learning-plan.js").ToolLearningContext) => {
        assert.equal(context.acquisitionInquiry?.failureRef, saved.versionId);
        assert.ok(context.acquisitionFailures?.some(row => row.ref === saved.versionId));
        const slot = `TEST_ONLY_inquiry_${++calls}`;
        assert.ok((await funding.reserve(slot, 128)).ok);
        assert.ok((await funding.settle(slot, { kind: "reported", totalTokens: 16 })).ok);
        return calls % 2 === 1 ? { ...reasoning, action: "research", query: "TEST ONLY supported alternative" }
          : { ...reasoning, action: "acquire", candidate: { platform: "npm", id: "leaf", version: "1.0.0" }, adaptation: "TEST ONLY expose existing leaf API" };
      },
      search: async () => {
        searchCalls++;
        return { status: "complete" as const, candidates: [{ platform: "npm", id: "leaf", version: "1.0.0", sourceUrl: "https://www.npmjs.com/package/leaf", licenseSpdx: "MIT" }], failures: [] };
      },
      evolve: async () => { assert.fail("research cannot generate source or execute a tool"); },
      releaseAllowance: async () => {
        if (unconfirmed === "retain_claim") {
          assert.ok((await funding.reserve("TEST_ONLY_unknown_tail", 128)).ok);
          throw new Error("TEST ONLY lost owner before lease closeout");
        }
        await funding.release();
        if (unconfirmed) throw new Error("TEST ONLY lost process before outcome commit");
      } };
  };

  return { boardRoot, scope, centralScope, jobId, approvalId, plan, data, failureRef: saved.versionId, now, at, state, services,
    setNow: (value: number) => { clock = value }, calls: () => calls, searchCalls: () => searchCalls };
}

test("public inquiry researches under one original grant, creates a new exact review, then explicit new approval continues acquisition/adaptation under that grant", async t => {
  const fx = await fixture(t, { centralScope: "D:\\workspace\\tool-central-inquiry" }), before = await fx.state(), review = await reviewAcquisitionInquiry(fx);
  assert.ok(review.ok && review.ready && review.reviewId, JSON.stringify(review));
  const proposed = await runAcquisitionInquiry({ ...fx, reviewId: review.reviewId, services: id => fx.services(id), signal: new AbortController().signal });

  assert.ok(proposed.ok && "reviewJobId" in proposed && typeof proposed.reviewJobId === "string", JSON.stringify(proposed));
  assert.equal(fx.calls(), 2);
  assert.equal(fx.searchCalls(), 1);
  const choice = await readToolAcquisition(fx.boardRoot, proposed.reviewJobId, fx.scope);
  assert.ok(choice.ok);
  assert.equal(choice.decision.candidate.id, "leaf");
  assert.notEqual(choice.approvalId, fx.approvalId);
  assert.ok(choice.learningPlan.trigger.evidenceRefs.includes("TEST_ONLY_original_task_contract"));
  let state = await fx.state();
  assert.equal(state.centralLearningGrants?.length, 1);
  assert.equal(centralLearningSpent(state.centralLearningGrants![0]!).calls, 2);
  assert.equal(state.jobs.find(row => row.jobId === fx.jobId)?.state, "waiting_approval");
  assert.equal(contentHashOf(state.assets.find(row => row.versionId === fx.approvalId)), contentHashOf(before.assets.find(row => row.versionId === fx.approvalId)));
  const synchronization = await reviewAcquisitionInquiry(fx);
  assert.ok(synchronization.ok && synchronization.reviewId);
  assert.ok(!(await runAcquisitionInquiry({ ...fx, reviewId: `acquisition-inquiry-review_v1_${"0".repeat(64)}`, services: async () => { assert.fail("stale confirm cannot construct services"); }, signal: new AbortController().signal })).ok);
  assert.ok((await runAcquisitionInquiry({ ...fx, reviewId: synchronization.reviewId, services: async () => { assert.fail("committed replay is zero model"); }, signal: new AbortController().signal })).ok);
  const leaf = fx.data.plan.tree.packages.find(row => row.name === "leaf")!, oldLock = fx.data.plan.lock.packages;
  assert.ok(recordOf(oldLock));
  const entry = oldLock[leaf.location];
  assert.ok(isJsonValue(entry));
  const lock: JsonObject = { lockfileVersion: 3, packages: { "": { dependencies: { leaf: "1.0.0" } }, [leaf.location]: entry } };
  const tree = planNpmLockedTree({ scope: fx.scope, name: "leaf", version: "1.0.0", target: fx.data.target, lock });
  assert.ok(tree.ok);
  const installation: NpmInstallPlan = { type: "npm_install_plan", schemaVersion: 1, lock, tree: tree.tree, packages: fx.data.plan.packages.filter(row => row.location === leaf.location) };

  assert.ok((await saveToolAcquisitionPlan({ boardRoot: fx.boardRoot, jobId: choice.jobId, scope: fx.scope, approvalId: choice.approvalId, plan: installation, issuedAt: fx.at() })).ok);
  let sourceReads = 0, grants = 0;
  const permissions = createFilePermissionStore({ path: path.join(fx.boardRoot, "TEST_ONLY_permissions") });
  const acquire = (approvalId: string) => acquireLearningChoice({ boardRoot: fx.boardRoot, jobId: choice.jobId, scope: fx.scope, approvalId, now: fx.now,
    target: fx.data.target, installationRoot: path.join(fx.boardRoot, "installed"), resolution: { nodeExecutable: process.execPath, npmCli: "", scratchRoot: path.join(fx.boardRoot, "scratch") },
    signal: new AbortController().signal, approval: permissions,
    issueGrant: id => {
      grants++;
      return permissions.issue({ action: "acquire", candidateId: id, packageVersionId: id, scope: fx.scope, issuedAt: fx.at(), expiry: new Date(300_000).toISOString() });
    },
    transport: { get: async request => {
      sourceReads++;
      const body = fx.data.bodies.get(request.url);
      assert.ok(body);
      return ok({ status: 200, body });
    } } });

  assert.equal((await acquire(fx.approvalId)).ok, false);
  assert.equal(sourceReads, 0);
  assert.equal(grants, 0, "the old approval cannot switch the package");
  assert.ok((await acquire(choice.approvalId)).ok);
  assert.equal(sourceReads, 1);
  const claim = await claimAcquisitionAdaptation({ boardRoot: fx.boardRoot, jobId: choice.jobId, scope: fx.scope, approvalId: choice.approvalId, workspaceId: fx.scope, now: fx.now });

  assert.ok(claim.ok && !claim.completed);
  const funding = createToolLearningFunding({ boardRoot: fx.boardRoot, scope: fx.scope, centralScope: fx.centralScope, now: fx.now, continuationJobId: claim.continuationJobId });
  const allowance = await funding.allowance(choice.learningPlan);
  assert.ok(allowance);
  assert.equal(allowance.grantId, before.centralLearningGrants![0]!.grantId);
  assert.ok((await funding.reserve("TEST_ONLY_later_adaptation_call", 128)).ok);
  assert.ok((await funding.settle("TEST_ONLY_later_adaptation_call", { kind: "reported", totalTokens: 8 })).ok);
  await funding.release();
  state = await fx.state();
  assert.equal(state.centralLearningGrants?.length, 1);
  assert.equal(centralLearningSpent(state.centralLearningGrants![0]!).calls, 3);
  assert.equal(centralLearningSpent(state.centralLearningGrants![0]!).tokens, 40);
});

test("a lost closeout recovers its committed terminal decision after expiry without resending the model", async t => {
  const fx = await fixture(t), view = await reviewAcquisitionInquiry(fx);
  assert.ok(view.ok && view.reviewId);
  const stopped = await runAcquisitionInquiry({ ...fx, reviewId: view.reviewId, signal: new AbortController().signal, services: id => fx.services(id, true) });
  assert.ok(!stopped.ok);
  assert.equal(stopped.code, "inquiry_cleanup_unconfirmed");
  assert.equal(fx.calls(), 2);
  fx.setNow(600_001);
  const recovery = await reviewAcquisitionInquiry(fx);
  assert.ok(recovery.ok && recovery.recovery?.recoverable && recovery.recovery.reviewId);
  assert.ok((await recoverExpiredAcquisitionInquiry({ ...fx, reviewId: recovery.recovery.reviewId })).ok);
  assert.equal(fx.calls(), 2);
  const done = await reviewAcquisitionInquiry(fx);
  assert.ok(done.ok);
  assert.ok(done.outcome?.reviewJobId);
  assert.equal((await fx.state()).centralLearningGrants?.length, 1);
});

test("missing original funding cannot mint a grant or start a research worker", async t => {
  const fx = await fixture(t, { funded: false }), view = await reviewAcquisitionInquiry(fx);
  assert.ok(view.ok);
  assert.equal(view.ready, false);
  assert.equal(view.code, "learning_allowance_required");
  const result = await runAcquisitionInquiry({ ...fx, reviewId: `acquisition-inquiry-review_v1_${"0".repeat(64)}`, signal: new AbortController().signal,
    services: async () => { assert.fail("missing-grant review cannot construct services"); } });
  assert.ok(!result.ok);
  assert.equal((await fx.state()).centralLearningGrants?.length ?? 0, 0);
  assert.equal((await fx.state()).jobs.length, 1);
});

test("a crash after committed review but before lease cleanup replays through the public sync without new model work or spent reset", async t => {
  const fx = await fixture(t), view = await reviewAcquisitionInquiry(fx);
  assert.ok(view.ok && view.reviewId);
  assert.ok(!(await runAcquisitionInquiry({ ...fx, reviewId: view.reviewId, signal: new AbortController().signal, services: id => fx.services(id, "retain_claim") })).ok);
  let state = await fx.state();
  const source = await readToolAcquisition(fx.boardRoot, fx.jobId, fx.scope);
  assert.ok(source.ok);
  const spec = acquisitionInquirySpecFromBoard(state, view.inquiryJobId, 1, fx.scope);
  assert.ok(spec.ok && spec.spec);
  const failure = toolAcquisitionFailureFromBoard(state, fx.failureRef, fx.scope);
  assert.ok(failure.ok);
  const known = committedInquiryDecision(state, { jobId: view.inquiryJobId, attempt: 1, plan: fx.plan, search: source.search });
  assert.ok(known.ok && known.decision);
  const outcome = proposedAcquisitionInquiryOutcome({ spec: spec.spec, plan: fx.plan, failure: failure.failure, decision: known.decision,
    decisionVersionId: known.decisionVersionId, search: known.search, occurredAt: known.occurredAt });
  assert.ok(outcome);
  assert.ok((await withBoardWriter(fx.boardRoot, store => finishAcquisitionInquiry(store, outcome, fx.at()))).ok, "TEST ONLY crash boundary: terminal review committed, cleanup not called");
  const active = await reviewAcquisitionInquiry(fx);
  assert.ok(active.ok && active.reviewId);
  const early = await runAcquisitionInquiry({ ...fx, reviewId: active.reviewId, signal: new AbortController().signal, services: async () => { assert.fail("sync cannot create services"); } });

  assert.ok(!early.ok);
  assert.equal(early.code, "inquiry_funding_closeout_active");
  state = await fx.state();
  const spent = centralLearningSpent(state.centralLearningGrants![0]!);
  assert.ok(state.centralLearningGrants![0]!.claim);
  fx.setNow(600_001);
  const expired = await reviewAcquisitionInquiry(fx);
  assert.ok(expired.ok && expired.reviewId);
  assert.ok((await runAcquisitionInquiry({ ...fx, reviewId: expired.reviewId, signal: new AbortController().signal, services: async () => { assert.fail("expired sync is zero model"); } })).ok);
  const cleaned = (await fx.state()).centralLearningGrants![0]!;
  assert.equal(cleaned.claim, undefined);
  assert.deepEqual(centralLearningSpent(cleaned), spent);
  assert.equal(cleaned.reservations.find(row => row.reservationId === "TEST_ONLY_unknown_tail")?.usage?.kind, "unknown");
  assert.equal(fx.calls(), 2);
});

test("an active other grant owner prevents research, while a frozen plan with actual install failure remains investigable", async t => {
  const fx = await fixture(t, { frozen: true }), view = await reviewAcquisitionInquiry(fx);
  assert.ok(view.ok && view.ready);
  const state = await fx.state(), grant = state.centralLearningGrants![0]!, budget = state.jobs.find(row => row.jobId === grant.jobId)!;

  await withBoardWriter(fx.boardRoot, async store => { assert.ok((await store.apply({ type: "coordinate_learning", commandId: "TEST_ONLY_other_claim", issuedAt: fx.at(),
    action: { kind: "claim", jobId: grant.jobId, expectedAttempt: budget.attempt, claimId: "TEST_ONLY_other", ownerId: "TEST_ONLY_other", expiresAt: new Date(300_000).toISOString() } })).ok); });
  const blocked = await reviewAcquisitionInquiry(fx);
  assert.ok(blocked.ok);
  assert.equal(blocked.code, "learning_claim_active");
  assert.ok(!(await runAcquisitionInquiry({ ...fx, reviewId: view.reviewId!, signal: new AbortController().signal, services: async () => { assert.fail("active owner cannot be taken over"); } })).ok);
  assert.ok((await recordToolAcquisitionInstalled({ ...fx, plan: fx.data.plan, grantId: "TEST_ONLY_synthetic_success", issuedAt: fx.at() })).ok);
  const installed = await reviewAcquisitionInquiry(fx);
  assert.ok(installed.ok);
  assert.equal(installed.code, "acquisition_already_installed");
  assert.equal(fx.calls(), 0);
});

test("research cannot turn a structurally blocked exact package into another approval for the same bytes", async t => {
  const fx = await fixture(t, { failureCode: "npm_shrinkwrap_unsupported" }), view = await reviewAcquisitionInquiry(fx);
  assert.ok(view.ok && view.ready && view.reviewId);
  const result = await runAcquisitionInquiry({ ...fx, reviewId: view.reviewId, signal: new AbortController().signal, services: async id => {
    const services = await fx.services(id);
    return { ...services, plan: async context => {
      await services.plan(context);
      return { ...reasoning, action: "acquire", candidate: { platform: "npm", id: "test-cli", version: "1.0.0" }, adaptation: "TEST ONLY a different adapter cannot remove shrinkwrap" };
    } };
  } });

  assert.ok(result.ok);
  assert.equal(result.code, "same_candidate_unresolved");
  assert.equal(result.status, "waiting_evidence");
  assert.equal("reviewJobId" in result, false);
  assert.equal((await fx.state()).jobs.filter(job => job.jobId.startsWith("tool-learning_v1_")).length, 1);
  const again = await reviewAcquisitionInquiry(fx);
  assert.ok(again.ok);
  assert.equal(again.ready, false);
  assert.equal(again.code, "inquiry_waiting_for_new_evidence");
  const nextFact = await recordToolAcquisitionFailure({ ...fx, issuedAt: fx.at(), phase: "resolve", failure: { code: "npm_bundled_dependency_unsupported" } });
  assert.ok(nextFact.ok);
  const renewed = await reviewAcquisitionInquiry({ ...fx, failureRef: nextFact.versionId });
  assert.ok(renewed.ok && renewed.ready);
  assert.equal(renewed.inquiryJobId, again.inquiryJobId);
  assert.equal(renewed.attempt, 1);
  assert.equal(fx.calls(), 1, "new evidence prepares a review instead of automatically calling a model");
});

test("a non-acquire strategy is a concrete model proposal for review without an executable review job", async t => {
  const fx = await fixture(t), view = await reviewAcquisitionInquiry(fx);
  assert.ok(view.ok && view.reviewId);
  const result = await runAcquisitionInquiry({ ...fx, reviewId: view.reviewId, signal: new AbortController().signal, services: async id => {
    const services = await fx.services(id);
    return { ...services, plan: async context => {
      await services.plan(context);
      return { ...reasoning, action: "defer", reason: "more_evidence", neededEvidence: ["TEST ONLY confirm runtime availability"] };
    } };
  } });

  assert.ok(result.ok);
  assert.equal("reviewJobId" in result, false);
  assert.equal(result.next, "wait_for_new_evidence");
  const stored = await reviewAcquisitionInquiry(fx);
  assert.ok(stored.ok);
  assert.equal(stored.outcome?.proposal?.kind, "model_strategy_proposal");
  assert.equal(stored.next, "inspect_or_wait");
  assert.equal(stored.outcome?.proposal?.action, "defer");
  assert.equal(stored.outcome?.proposal?.rationale, reasoning.rationale);
  assert.match(stored.outcome!.proposal!.planningDecisionVersionId, /^tool-decision_v1_[a-f0-9]{64}$/);
  assert.equal("request" in stored.outcome!.proposal!, false);
  assert.equal("source" in stored.outcome!.proposal!, false);
  assert.equal((await fx.state()).jobs.filter(job => job.jobId.startsWith("tool-learning_v1_")).length, 1);
});

test("an explicitly selected backup may retry a typed provider failure on the same fact and original grant without an automatic call", async t => {
  const fx = await fixture(t), first = await reviewAcquisitionInquiry(fx);
  assert.ok(first.ok && first.ready && first.reviewId);
  let amdCalls = 0;
  const failed = await runAcquisitionInquiry({ ...fx, reviewId: first.reviewId, signal: new AbortController().signal, services: async continuationJobId => {
    const funding = createToolLearningFunding({ boardRoot: fx.boardRoot, scope: fx.scope, now: fx.now, continuationJobId });
    return { allowance: plan => funding.allowance(plan), plan: async () => {
      amdCalls++;
      assert.ok((await funding.reserve("TEST_ONLY_AMD_unknown", 128)).ok);
      throw new ToolLearningServiceError("tool_planning_provider_error_invalid_request");
    }, search: async () => { assert.fail("failed planning cannot secretly search"); }, evolve: async () => { assert.fail("research cannot construct"); }, releaseAllowance: () => funding.release() };
  } });

  assert.ok(failed.ok);
  assert.equal(failed.status, "waiting_evidence");
  assert.equal(amdCalls, 1);
  assert.equal(fx.calls(), 0);
  const before = (await fx.state()).centralLearningGrants![0]!;
  assert.equal(centralLearningSpent(before).calls, 1);
  assert.equal(before.reservations[0]?.usage?.kind, "unknown");
  const retry = await reviewAcquisitionInquiry(fx);
  assert.ok(retry.ok && retry.ready && retry.reviewId);
  assert.equal(retry.failureRef, first.failureRef);
  assert.notEqual(retry.reviewId, first.reviewId);
  assert.equal(fx.calls(), 0, "reviewing readiness never selects or calls a backup automatically");
  const proposed = await runAcquisitionInquiry({ ...fx, reviewId: retry.reviewId, signal: new AbortController().signal, services: id => fx.services(id) });

  assert.ok(proposed.ok && "reviewJobId" in proposed);
  assert.equal(fx.calls(), 2);
  assert.equal(amdCalls, 1);
  const grants = (await fx.state()).centralLearningGrants!;
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.grantId, before.grantId);
  assert.equal(centralLearningSpent(grants[0]!).calls, 3);
  assert.equal(centralLearningSpent(grants[0]!).tokens, 160);
});
