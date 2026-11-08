import { testScratchPath } from "../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { BoardCommand } from "../../../../control/commands.js";
import type { CoordinationAction } from "../../../../control/coordination-contract.js";
import { toolLearningFundingClaimId, toolLearningFundingIdentity } from "../domain/evolution/funding-identity.js";
import { resultVersionId, type ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { enqueueToolLearningPlan, waitingToolJobReady } from "./pipeline-queue.js";
import { nominateToolLearningSource } from "./learning-funding.js";
import { savePipelineAsset } from "./pipeline-assets.js";
import { createToolCentralLearning } from "./central-learning.js";
import { acquisitionRecoveryFixture } from "../testing/acquisition-recovery-fixture.js";
import { acquisitionAdaptationResultId } from "../domain/evolution/acquisition-identity.js";
import { toolInternalRecipeVersionId, toolLearningDecisionVersionId } from "../domain/evolution/decision-identity.js";
import type { ToolLearningDecision } from "../domain/evolution/learning-plan.js";
import { contentHashOf } from "../../../../control/hash.js";

const at = "2026-11-05T01:00:00.000Z", scope = "tool:expiry-assets", centralScope = "tool:expiry-workspace";
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 10000, maxCalls: 4, maxSteps: 4, maxPromptChars: 12000 };

async function fixture(t: TestContext, confirmed: boolean) {
  const parent = testScratchPath("tool-expired-recovery");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "case-"));

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    await rm(root, { recursive: true, force: true });
  });
  const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope, capability: "TEST ONLY expiry recovery",
    createdAt: at, trigger: { runId: "task:expiry", proposalKey: "test:expiry", action: "user_requested", evidenceRefs: ["source:expiry"] } };
  const queued = await enqueueToolLearningPlan(root, plan);
  assert.ok(queued.ok);
  const identity = toolLearningFundingIdentity(plan);
  let serial = 0;
  const command = async (value: BoardCommand) => {
    const result = await withBoardWriter(root, board => board.apply(value));
    assert.ok(result.ok, JSON.stringify(result));
    return result.state;
  };
  const act = (action: CoordinationAction) => command({ type: "coordinate_learning", commandId: `expiry-test:${++serial}`, issuedAt: at, action });
  const load = async () => {
    const result = await createBoardReader(root).load();
    assert.ok(result.ok);
    return result.state;
  };

  assert.ok((await nominateToolLearningSource({ boardRoot: root, scope, centralScope, now: () => Date.parse(at) }, plan, new AbortController().signal)).ok);
  await act({ kind: "decide", issueId: identity.issueId, expectedRevision: 1, decision: "focused_learning", reason: "TEST original source", sourceRefs: ["source:expiry"] });
  await act({ kind: "open_budget", expectedSequence: (await load()).sequence, budget: { schemaVersion: 1, budgetId: "test:expiry-root", scope: centralScope,
    unit: "total_model_tokens", limits: { tokens: 20000, calls: 8, steps: 8 }, authorizationRef: "test:expiry-authorized" } });
  await act({ kind: "fund", domain: "tool", issueId: identity.issueId, expectedRevision: 2, grantId: identity.grantId, allowance,
    budgetId: "test:expiry-root", expectedSequence: (await load()).sequence, authorizationRef: "test:expiry-authorized", planRef: "test:expiry-plan" });
  await command({ type: "start_job", commandId: "test:start-pipeline", jobId: queued.jobId, issuedAt: at });
  const grant = (await load()).centralLearningGrants![0]!, claimId = toolLearningFundingClaimId(plan, queued.jobId, 1, 1);

  await act({ kind: "claim", jobId: grant.jobId, expectedAttempt: 0, claimId, ownerId: identity.ownerId, expiresAt: "2026-11-05T01:01:00.000Z" });
  await act({ kind: "reserve", grantId: grant.grantId, claimId, reservationId: "test:original-request", maxTokens: 1000 });
  const confirm = async () => {
    const saved = await withBoardWriter(root, board => savePipelineAsset(board, { versionId: resultVersionId(queued.jobId, 1), kind: "workflow", scope,
      source: "inferred", issuedAt: at, content: { type: "tool_learning_result", schemaVersion: 1, jobId: queued.jobId, attempt: 1,
        outcome: "waiting_evidence", code: "learning_budget_exhausted", search: { status: "complete", candidates: [], failures: [] }, occurredAt: at } }));
    assert.ok(saved.ok);
  };

  if (confirmed) await confirm();

  let calls = 0;
  const owner = (now: number) => createToolCentralLearning({ boardRoot: root, scope, centralScope, now: () => now,
    authorized: () => true, modelRef: "test:model", mode: "after_turn", run: async () => {
      calls++;
      return { ok: true };
    } });

  return { root, plan, act, load, owner, identity, confirm, jobId: queued.jobId, calls: () => calls };
}

test("expired tool construction retains its committed recipe without repurchasing a returned plan", async t => {
  for (const boundary of ["planning_only", "unknown_usage", "generation_reserved"] as const) await t.test(boundary, async child => {
    const f = await fixture(child, false);
    const evidence = [
      { sampleId: "one", role: "source" as const, input: 1, expected: { kind: "value" as const, value: 1 } },
      { sampleId: "two", role: "source" as const, input: 2, expected: { kind: "value" as const, value: 2 } },
      { sampleId: "zero", role: "variation" as const, input: 0, expected: { kind: "value" as const, value: 0 } },
      { sampleId: "invalid", role: "counterexample" as const, input: null, expected: { kind: "error" as const, code: "invalid_input" } },
    ];
    const decision: ToolLearningDecision = { action: "create", rationale: "TEST controlled identity contract", existingInsufficiency: "TEST no implementation",
      expectedBenefit: "TEST hypothesis", constructionCost: "TEST one generation", alternatives: [],
      request: { schemaVersion: 1, requestId: "test:interrupted", scope, capability: f.plan.capability, operation: "create", evidence, maxAttempts: 1 },
      sampleOrigins: evidence.map(sample => ({ sampleId: sample.sampleId, kind: "synthesized", ref: "test:controlled-contract" })) };
    const recipeVersionId = toolInternalRecipeVersionId(decision), decisionVersionId = toolLearningDecisionVersionId({ jobId: f.jobId, attempt: 1, step: 1, decision });
    const saved = await withBoardWriter(f.root, async board => {
      const receipt = await savePipelineAsset(board, { versionId: decisionVersionId, kind: "workflow", scope, source: "inferred", issuedAt: at,
        content: { type: "tool_learning_decision", schemaVersion: 1, jobId: f.jobId, attempt: 1, step: 1, contextHash: contentHashOf("test:context"), grantId: f.identity.grantId, decision } });
      assert.ok(receipt.ok);
      return savePipelineAsset(board, { versionId: recipeVersionId, kind: "verification_recipe", scope, source: "inferred", issuedAt: at,
        content: { type: "tool_learning_recipe", schemaVersion: 1, automation: "after_turn", request: decision.request } });
    });
    assert.ok(saved.ok);

    if (boundary !== "unknown_usage") await f.act({ kind: "settle", grantId: f.identity.grantId, reservationId: "test:original-request",
      usage: { kind: "reported", model: "test:model", inputTokens: 20, outputTokens: 10, totalTokens: 30 } });

    if (boundary === "generation_reserved") {
      const claimId = (await f.load()).centralLearningGrants![0]!.claim!.claimId;
      await f.act({ kind: "reserve", grantId: f.identity.grantId, claimId, reservationId: "test:generation", maxTokens: 1000 });
    }

    const original = await f.load();
    const recovered = await f.owner(Date.parse(at) + 120000).recover(new AbortController().signal, f.identity.issueId);
    assert.ok(recovered.ok);
    const state = await f.load(), job = state.jobs.find(row => row.jobId === f.jobId)!;

    if (boundary === "planning_only") {
      assert.equal(recovered.results[0]!.status, "recovered", "The committed plan must resume construction without another planning request");
      assert.equal(job.state, "waiting_evidence");
      assert.equal(job.attempt, 1);
      const result = state.assets.find(row => row.versionId === resultVersionId(f.jobId, 1))!.content;

      assert.ok(typeof result === "object" && result !== null && "recipeVersionId" in result);
      assert.equal(result.recipeVersionId, recipeVersionId);
      assert.equal(waitingToolJobReady(state, job, f.plan, "after_turn", true), false, "A host interruption must not automatically buy another call");
      assert.equal(waitingToolJobReady(state, job, f.plan, "manual", true, true), true, "An exact-job manual resume must retain the committed construction");
      assert.deepEqual(state.assets.find(row => row.versionId === recipeVersionId)!.content,
        original.assets.find(row => row.versionId === recipeVersionId)!.content);
      assert.deepEqual(state.centralLearningGrants![0]!.reservations, original.centralLearningGrants![0]!.reservations);
    } else {
      assert.equal(recovered.results[0]!.status, "inspection_required");
      assert.equal(job.state, "running");
      assert.equal(state.assets.some(row => row.versionId === resultVersionId(f.jobId, 1)), false);
    }

    assert.equal(f.calls(), 0);
    assert.equal(state.centralLearningGrants!.length, 1);
  });
});

test("tool prepare locally completes a confirmed expired attempt and yields the original purse without running a worker", async t => {
  const f = await fixture(t, true);

  await f.owner(Date.parse(at) + 120000).prepare({ issueId: f.identity.issueId, authorizedAllowance: allowance }, new AbortController().signal);
  const state = await f.load(), grant = state.centralLearningGrants![0]!;

  assert.equal(state.jobs.find(job => job.jobId === f.jobId)!.state, "waiting_evidence");
  assert.equal(grant.claim, undefined);
  assert.equal(grant.status, "open");
  assert.equal(grant.allowance.maxTokens, 10000);
  assert.deepEqual(grant.reservations[0]!.usage, { kind: "unknown", reason: "previous_claim_expired" });
  assert.equal(grant.reservations.length, 1);
  assert.equal(f.calls(), 0);
});

test("tool live claims stay busy; expiry without a result preserves inspection and never retries the paid attempt", async t => {
  const f = await fixture(t, false), before = await f.load();
  const live = await f.owner(Date.parse(at) + 1000).prepare({ issueId: f.identity.issueId, authorizedAllowance: allowance }, new AbortController().signal);

  assert.equal(live.status, "waiting");
  assert.equal((await f.load()).sequence, before.sequence);
  const expired = await f.owner(Date.parse(at) + 120000).prepare({ issueId: f.identity.issueId, authorizedAllowance: allowance }, new AbortController().signal);

  assert.equal(expired.status, "waiting");
  assert.equal(expired.reason, "tool_expired_sent_attempt_requires_inspection");
  const state = await f.load(), grant = state.centralLearningGrants![0]!;

  assert.equal(grant.claim, undefined);
  assert.equal(grant.reservations[0]!.usage?.kind, "unknown");
  assert.equal(state.jobs.find(job => job.jobId === f.jobId)!.state, "running");
  assert.equal(state.jobs.find(job => job.jobId === f.jobId)!.attempt, 1);
  assert.equal(f.calls(), 0);
  const again = await f.owner(Date.parse(at) + 180000).prepare({ issueId: f.identity.issueId, authorizedAllowance: allowance }, new AbortController().signal);

  assert.equal(again.status, "waiting");
  assert.equal((await f.load()).sequence, state.sequence);
  // The original worker can persist its result after expiry, then crash before
  // terminal. Its late receipt authorizes local completion, never a new lease.
  await f.confirm();
  const late = await f.load();

  await f.owner(Date.parse(at) + 240000).prepare({ issueId: f.identity.issueId, authorizedAllowance: allowance }, new AbortController().signal);
  const completed = await f.load();

  assert.equal(completed.jobs.find(job => job.jobId === f.jobId)!.state, "waiting_evidence");
  assert.deepEqual(completed.centralLearningGrants, late.centralLearningGrants);
  assert.equal(f.calls(), 0);
  await f.owner(Date.parse(at) + 300000).recover(new AbortController().signal, f.identity.issueId);
  assert.equal((await f.load()).sequence, completed.sequence);
});

test("tool central recovery reaches the original adaptation result owner; unknown children expose their exact existing operator route", async t => {
  for (const confirmed of [true, false]) await t.test(confirmed ? "confirmed_child_outcome" : "unknown_child", async childTest => {
    const fx = await acquisitionRecoveryFixture(childTest, { centralScope: "tool:child-expiry-central" });

    if (confirmed) {
      const saved = await withBoardWriter(fx.boardRoot, board => savePipelineAsset(board, { kind: "workflow", scope: fx.scope, source: "inferred", issuedAt: fx.at(),
        versionId: acquisitionAdaptationResultId(fx.childJobId, 1), content: { type: "tool_acquisition_adaptation_result", schemaVersion: 1,
          originalJobId: fx.jobId, jobId: fx.childJobId, attempt: 1, approvalId: fx.approvalId,
          ok: false, code: "test_confirmed_construction_failure", message: "TEST original returned failure; no external retry" } }));
      assert.ok(saved.ok);
    }

    fx.setNow(600001);
    let calls = 0;
    const owner = createToolCentralLearning({ boardRoot: fx.boardRoot, scope: fx.scope, centralScope: fx.centralScope, now: fx.now,
      authorized: () => true, modelRef: "test:child-model", mode: "after_turn", run: async () => {
        calls++;
        return { ok: true };
      } });
    const identity = toolLearningFundingIdentity(fx.plan), result = await owner.recover(new AbortController().signal, identity.issueId);

    assert.ok(result.ok, JSON.stringify(result));
    const state = await fx.state(), grant = state.centralLearningGrants![0]!;

    if (confirmed) {
      assert.equal(result.results[0]!.status, "recovered");
      assert.equal(grant.claim, undefined);
      assert.equal(state.jobs.find(job => job.jobId === fx.childJobId)!.state, "waiting_evidence");
      assert.equal(grant.reservations[0]!.usage?.kind, "unknown");
    } else {
      assert.equal(result.results[0]!.status, "inspection_required");
      assert.match(result.results[0]!.operatorRoute ?? "", /--recover-child/);
      assert.ok(result.results[0]!.sourceRefs?.includes(fx.approvalId));
      assert.equal(state.jobs.find(job => job.jobId === fx.childJobId)!.state, "running");
      assert.equal(grant.claim, undefined);
      assert.equal(grant.reservations[0]!.usage?.kind, "unknown");
      const repeated = await owner.recover(new AbortController().signal, identity.issueId);
      assert.ok(repeated.ok);
      assert.equal(repeated.results[0]!.status, "inspection_required");
      assert.equal((await fx.state()).sequence, state.sequence);
    }

    assert.equal(grant.reservations.length, 1);
    assert.equal(state.centralLearningGrants!.length, 1);
    assert.equal(calls, 0);
  });
});
