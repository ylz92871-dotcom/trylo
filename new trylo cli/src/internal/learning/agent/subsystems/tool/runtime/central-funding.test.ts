import { testScratchPath } from "../../../../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { emptyUsage, type ProviderPort, type ProviderRequest } from "../../../../../ports/provider.js";
import type { BoardCommand } from "../../../../control/commands.js";
import type { CoordinationAction } from "../../../../control/coordination-contract.js";
import { centralLearningSpent } from "../../../../control/coordination-contract.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { toolLearningJobId } from "../domain/evolution/pipeline.js";
import { toolLearningFundingIdentity } from "../domain/evolution/funding-identity.js";
import { enqueueToolLearningPlan } from "./pipeline-queue.js";
import { createToolLearningFunding, nominateToolLearningSource, type ManagedToolFundingBinding } from "./learning-funding.js";
import { withToolLearningFunding } from "../adapters/evolution/funded-provider.js";
import { createToolCentralLearning } from "./central-learning.js";
import { savePipelineAsset } from "./pipeline-assets.js";
import { resultVersionId } from "../domain/evolution/pipeline.js";
import { contentHashOf } from "../../../../control/hash.js";
import { toolLearningDecisionVersionId } from "../domain/evolution/decision-identity.js";
import { toolLearningInputFingerprint } from "./pipeline-planning.js";
import { workToolLearningPipeline } from "./pipeline-worker.js";
import { ToolLearningServiceError } from "../domain/evolution/service-error.js";

const at = "2026-11-04T13:00:00.000Z", scope = "workspace:managed-tool-stage", centralScope = "workspace:managed-tool-root";
const request: ProviderRequest = { attemptId: "tool-planning:bounded-stage", model: "scripted", maxOutputTokens: 128,
  messages: [{ role: "user", content: "TEST ONLY bounded stage" }], tools: [] };

async function fixture(t: TestContext) {
  const parent = testScratchPath("tool-central-stage-funding");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "case-"));

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    await rm(root, { recursive: true, force: true });
  });
  const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope, capability: "TEST ONLY stage envelope",
    createdAt: at, trigger: { runId: "task:stage", proposalKey: "bounded-stage", action: "user_requested", evidenceRefs: ["task:source"] } };
  const queued = await enqueueToolLearningPlan(root, plan);
  assert.ok(queued.ok);
  const load = async () => {
    const result = await createBoardReader(root).load();
    assert.ok(result.ok);
    return result.state;
  };
  let serial = 0;
  const command = async (value: BoardCommand) => {
    const result = await withBoardWriter(root, store => store.apply(value));
    assert.ok(result.ok);
    return result.state;
  };
  const act = (action: CoordinationAction) => command({ type: "coordinate_learning", commandId: `stage-funding:${++serial}`, issuedAt: at, action });
  const nominated = await nominateToolLearningSource({ boardRoot: root, scope, centralScope, now: () => Date.parse(at) }, plan,
    new AbortController().signal);
  assert.ok(nominated.ok);
  const identity = toolLearningFundingIdentity(plan);

  await act({ kind: "decide", issueId: identity.issueId, expectedRevision: 1, decision: "focused_learning",
    reason: "TEST ONLY PA selected the actual source", sourceRefs: ["task:source"] });
  await act({ kind: "open_budget", expectedSequence: (await load()).sequence, budget: { schemaVersion: 1, budgetId: "root:stage", scope: centralScope,
    unit: "total_model_tokens", limits: { tokens: 20000, calls: 8, steps: 8 }, authorizationRef: "host:test-root" } });
  await act({ kind: "fund", issueId: identity.issueId, expectedRevision: 2, grantId: identity.grantId, domain: "tool",
    allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 10000, maxCalls: 3, maxSteps: 3, maxPromptChars: 10000 },
    budgetId: "root:stage", expectedSequence: (await load()).sequence, authorizationRef: "host:test-original", planRef: "plan:test-original" });
  await command({ type: "start_job", commandId: "stage-funding:start-original", jobId: queued.jobId, issuedAt: at });
  const state = await load();
  const binding: ManagedToolFundingBinding = { issueId: identity.issueId, grantId: identity.grantId, budgetId: "root:stage",
    expectedIssueRevision: state.learningIssues!.find(item => item.issueId === identity.issueId)!.revision,
    stage: { chargedAtStart: { tokens: 0, calls: 0, steps: 0 }, allowance: { schemaVersion: 2, unit: "total_model_tokens",
      maxTokens: 1000, maxCalls: 1, maxSteps: 1, maxPromptChars: 10000 } } };

  return { root, plan, binding, load, act, command, create: (managedBinding?: ManagedToolFundingBinding) => createToolLearningFunding({
    boardRoot: root, scope, centralScope, now: () => Date.parse(at), ...(managedBinding === undefined ? {} : { managedBinding }) }) };
}

for (const billing of ["reported", "unknown", "retry_reported_truncation", "retry_unknown_truncation", "schema_reported", "schema_unknown", "library_reported", "library_unknown"] as const) {
  test(`planning continuation preserves original receipts and accounting: ${billing}`, async t => {
    const libraryBoundary = billing.startsWith("library_");
    const f = await fixture(t), funding = f.create(f.binding), signal = new AbortController().signal;
    const originalAttempt = libraryBoundary ? 3 : 1, jobId = toolLearningJobId(f.plan);

    for (let attempt = 1; attempt < originalAttempt; attempt++) {
      await withBoardWriter(f.root, board => savePipelineAsset(board, { versionId: resultVersionId(jobId, attempt),
        kind: "workflow", scope, source: "inferred", issuedAt: at, content: { type: "tool_learning_result", schemaVersion: 1,
          jobId, attempt, outcome: "waiting_evidence", code: "verification_recipe_required",
          search: { status: "complete", candidates: [], failures: [] }, occurredAt: at } }));
      await f.command({ type: "complete_job", commandId: `test:prior:${attempt}`, issuedAt: at, jobId, next: "waiting_evidence" });
      await f.command({ type: "requeue_job", commandId: `test:prior-requeue:${attempt}`, issuedAt: at, jobId, expectedAttempt: attempt });
      await f.command({ type: "start_job", commandId: `test:prior-start:${attempt + 1}`, issuedAt: at, jobId });
    }

    assert.ok(await funding.allowance(f.plan));
    assert.ok((await funding.reserve("test:truncated-plan", 900)).ok);
    assert.ok((await funding.settle("test:truncated-plan", billing !== "unknown" && billing !== "schema_unknown" && billing !== "library_unknown"
      ? { kind: "reported", totalTokens: 100, model: "controlled" } : { kind: "unknown", reason: "test:transport" })).ok);
    await funding.release();
    const decision = { action: "research" as const, libraryQuery: "duration normalization", rationale: "Read the existing local library",
      existingInsufficiency: "No matching capability known", expectedBenefit: "Possible reuse", constructionCost: "Read only", alternatives: [] };
    const decisionVersionId = toolLearningDecisionVersionId({ jobId, attempt: originalAttempt, step: 1, decision });

    if (libraryBoundary) {
      await withBoardWriter(f.root, async board => {
        assert.ok((await savePipelineAsset(board, { versionId: decisionVersionId, kind: "workflow", scope, source: "inferred", issuedAt: at,
          content: { type: "tool_learning_decision", schemaVersion: 1, jobId, attempt: originalAttempt, step: 1,
            contextHash: contentHashOf("test:original-context"), decision, grantId: f.binding.grantId } })).ok);
        const request = { kind: "library", query: decision.libraryQuery };

        assert.ok((await savePipelineAsset(board, { versionId: `tool-research_v1_${contentHashOf({ jobId, step: 1, request })}`,
          kind: "workflow", scope, source: "inferred", issuedAt: at, content: { type: "tool_learning_research", schemaVersion: 1,
            jobId, scope, capability: f.plan.capability, attempt: originalAttempt, step: 1, request,
            library: { query: decision.libraryQuery, candidates: [], total: 0, truncated: false }, occurredAt: at } })).ok);
      });
    }

    const oldResult = { type: "tool_learning_result", schemaVersion: 1, jobId, attempt: originalAttempt,
      outcome: billing.startsWith("schema_") ? "waiting_evidence" : "failed",
      code: libraryBoundary ? "tool_planning_provider_error" : billing.startsWith("schema_") ? "invalid_learning_decision" : "tool_planning_incomplete_generation",
      ...(libraryBoundary ? { decision, decisionVersionId } : {}),
      inputFingerprint: toolLearningInputFingerprint(await f.load(), f.plan),
      inputFingerprintPolicy: 2, search: { status: "complete", candidates: [], failures: [] }, occurredAt: at };
    const saved = await withBoardWriter(f.root, board => savePipelineAsset(board, { versionId: resultVersionId(jobId, originalAttempt),
      content: oldResult, kind: "workflow", scope, source: "inferred", issuedAt: at }));
    assert.ok(saved.ok);

    if (billing.startsWith("schema_")) await f.command({ type: "complete_job", commandId: "test:old-planning-rejected", issuedAt: at, jobId, next: "waiting_evidence" });
    else {
      await f.command({ type: "fail_job", commandId: "test:old-planning-failed", issuedAt: at, jobId, terminal: "failed" });
      const unbound = await withBoardWriter(f.root, board => board.apply({ type: "requeue_job", commandId: "test:no-proof",
        issuedAt: at, jobId, expectedAttempt: originalAttempt }));
      assert.ok(!unbound.ok);
    }

    let calls = 0;
    const owner = createToolCentralLearning({ boardRoot: f.root, scope, centralScope, now: () => Date.parse(at),
      authorized: () => true, modelRef: "controlled", mode: "after_turn", run: async (selected, managedBinding, abort) => {
        const next = f.create(managedBinding);
        return workToolLearningPipeline({ boardRoot: f.root, scope, now: () => Date.parse(at), mode: "after_turn", signal: abort,
          jobIds: [selected], managedBinding, services: { allowance: plan => next.allowance(plan), releaseAllowance: () => next.release(),
            search: async () => { throw new Error("the completed original discovery must not restart"); },
            plan: async context => {
              if (libraryBoundary) assert.ok(context.research?.some(step => step.library?.query === decision.libraryQuery),
                "the completed original read-only research must reach the continued planner");

              calls++;
              assert.ok((await next.reserve("test:continued-plan", 500)).ok);
              assert.ok((await next.settle("test:continued-plan", billing === "retry_unknown_truncation"
                ? { kind: "unknown", reason: "test:transport" } : { kind: "reported", totalTokens: 100, model: "controlled" })).ok);

              if (billing === "retry_reported_truncation" || billing === "retry_unknown_truncation") throw new ToolLearningServiceError("tool_planning_incomplete_generation");

              return { action: "defer", reason: "not_worthwhile", neededEvidence: [], rationale: "TEST no useful reusable gap remains",
                existingInsufficiency: "TEST none", expectedBenefit: "TEST unknown", constructionCost: "TEST no construction", alternatives: [] };
            }, evolve: async () => { throw new Error("no construction authorized"); } } });
      } });
    const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const,
      maxTokens: 10000, maxCalls: 3, maxSteps: 3, maxPromptChars: 10000 };
    const stage = await owner.prepare({ issueId: f.binding.issueId, authorizedAllowance: allowance,
      operationAllowance: { ...allowance, maxTokens: 1000, maxCalls: 1, maxSteps: 1 } }, signal);

    if (billing === "unknown" || billing === "schema_unknown" || billing === "library_unknown") {
      assert.notEqual(stage.status, "ready");
      assert.equal(calls, 0);
      return;
    }

    assert.equal(stage.status, "ready", JSON.stringify(stage));
    if (stage.status !== "ready") return;

    const current = await f.load();
    const dispatched = await owner.dispatch({ issueId: f.binding.issueId, grantId: f.binding.grantId,
      expectedIssueRevision: current.learningIssues![0]!.revision, stageRef: stage.stageRef, policyRef: stage.policyRef,
      sourceBindingRef: stage.source.sourceBindingRef, offer: stage.offer }, signal);

    assert.ok(dispatched.ok, JSON.stringify(dispatched));
    assert.equal(calls, 1, JSON.stringify({ dispatched,
      latestResult: (await f.load()).assets.find(asset => asset.versionId === resultVersionId(jobId, originalAttempt + 1))?.content }));
    const after = await f.load();
    assert.equal(after.jobs.find(job => job.jobId === jobId)!.attempt, originalAttempt + 1);
    const expectedState = billing === "retry_reported_truncation" ? "waiting_evidence" : billing === "retry_unknown_truncation" ? "failed" : "succeeded";

    assert.equal(after.jobs.find(job => job.jobId === jobId)!.state, expectedState,
      JSON.stringify(after.assets.find(asset => asset.versionId === resultVersionId(jobId, originalAttempt + 1))?.content));
    assert.equal(after.centralLearningGrants!.length, 1);
    assert.deepEqual(after.assets.find(asset => asset.versionId === resultVersionId(jobId, originalAttempt))!.content, oldResult);
    assert.equal(centralLearningSpent(after.centralLearningGrants![0]!).tokens, billing === "retry_unknown_truncation" ? 600 : 200);
  });
}

test("a managed stage cannot spend the other calls in its wider original lifetime grant", async t => {
  const f = await fixture(t), funding = f.create(f.binding);
  assert.ok(await funding.allowance(f.plan));
  let calls = 0, serial = 0;
  const provider = withToolLearningFunding({ async *stream() { calls += 1;
    yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 80, outputTokens: 20, totalTokens: 100 } };
    yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
  } }, { funding, newId: () => `stage-request:${++serial}` });
  const drain = async (value: ProviderPort) => { for await (const event of value.stream(request, new AbortController().signal)) void event; };

  await drain(provider);
  await assert.rejects(drain(provider), /budget_exhausted/);
  const grant = (await f.load()).centralLearningGrants!.find(item => item.grantId === f.binding.grantId)!;

  assert.equal(calls, 1);
  assert.equal(grant.allowance.maxCalls, 3);
  assert.deepEqual(centralLearningSpent(grant), { tokens: 100, calls: 1, steps: 1 });
  await funding.release();
});

test("the root blocks an ordinary unbound worker and a stale managed revision before paid work", async t => {
  const f = await fixture(t), before = await f.load();

  assert.equal(await f.create().allowance(f.plan), undefined);
  const issue = before.learningIssues!.find(item => item.issueId === f.binding.issueId)!;

  await f.act({ kind: "report", issueId: issue.issueId, scope: centralScope, problemKey: issue.problemKey,
    report: { reportId: "tool-source:new-facts", source: { subsystem: "tool", taskId: f.plan.trigger.runId, versionId: toolLearningJobId(f.plan) },
    facts: ["new source evidence"], evidenceRefs: ["task:new-facts"] } });
  assert.equal(await f.create(f.binding).allowance(f.plan), undefined);
  const after = await f.load(), grant = after.centralLearningGrants!.find(item => item.grantId === f.binding.grantId)!;

  assert.equal(grant.claim, undefined);
  assert.equal(grant.reservations.length, 0);
  assert.equal(after.centralLearningGrants!.length, 1);
});
