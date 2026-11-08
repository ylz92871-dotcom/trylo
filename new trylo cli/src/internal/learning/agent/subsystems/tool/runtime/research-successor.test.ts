import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { testScratchPath } from "../../../../../testing/scratch.js";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { BoardCommand } from "../../../../control/commands.js";
import { centralLearningSpent, type CoordinationAction } from "../../../../control/coordination-contract.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { ToolPipelineServices } from "./pipeline-services.js";
import { evolutionPrompt } from "../domain/evolution/prompt.js";
import { TOOL_CONSTRUCTION_NOT_STARTED } from "../domain/evolution/construction-stop.js";
import { toolLearningFundingIdentity } from "../domain/evolution/funding-identity.js";
import { resultVersionId, type ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { appendToolResearchSuccessor } from "./research-successor.js";
import { enqueueToolLearningPlan } from "./pipeline-queue.js";
import { createToolLearningFunding, nominateToolLearningSource } from "./learning-funding.js";
import { workToolLearningPipeline } from "./pipeline-worker.js";
import { selectToolFocusedSource, toolCentralPolicyRef, toolCentralSourceBinding } from "./central-source.js";
import { observeToolCentralStage } from "./central-observation.js";
import { prepareToolPlanningContext } from "./pipeline-planning-context.js";
import { createToolCentralLearning } from "./central-learning.js";
import type { ToolLearningContext } from "../domain/evolution/learning-plan.js";

const at = "2026-11-08T01:00:00.000Z", scope = "TEST:tool-successor", centralScope = "TEST:tool-successor-root";
const signal = new AbortController().signal, now = () => Date.parse(at);
const allowance = { schemaVersion: 2 as const, unit: "total_model_tokens" as const, maxTokens: 96000, maxCalls: 8, maxSteps: 8, maxPromptChars: 24000 };
const reasoning = { rationale: "TEST ONLY original unresolved capability", existingInsufficiency: "TEST ONLY missing contract",
  expectedBenefit: "Unverified", constructionCost: "One scripted call", alternatives: [] };

async function fixture(t: TestContext, unknown = false, originalAttempts = 1) {
  const parent = testScratchPath("tool-research-successor");
  await mkdir(parent, { recursive: true });
  const boardRoot = await mkdtemp(path.join(parent, "case-"));

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(boardRoot)), parent);
    await rm(boardRoot, { recursive: true, force: true });
  });
  const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope, capability: "TEST ONLY duration normalization",
    createdAt: at, trigger: { runId: "TEST:original-task", proposalKey: "TEST:original", action: "user_requested", evidenceRefs: [] } };
  const queued = await enqueueToolLearningPlan(boardRoot, plan);
  assert.ok(queued.ok, JSON.stringify(queued));
  const identity = toolLearningFundingIdentity(plan);
  let serial = 0;
  const command = async (value: BoardCommand) => {
    const result = await withBoardWriter(boardRoot, store => store.apply(value));
    assert.ok(result.ok, JSON.stringify(result));
    return result.state;
  };
  const act = (action: CoordinationAction) => command({ type: "coordinate_learning", commandId: `successor-test:${++serial}`, issuedAt: at, action });
  const load = async () => {
    const result = await createBoardReader(boardRoot).load();
    assert.ok(result.ok);
    return result.state;
  };

  assert.ok((await nominateToolLearningSource({ boardRoot, scope, centralScope, now }, plan, signal)).ok);
  await act({ kind: "decide", issueId: identity.issueId, expectedRevision: 1, decision: "focused_learning", reason: "TEST ONLY focus", sourceRefs: [] });
  await act({ kind: "open_budget", expectedSequence: (await load()).sequence, budget: { schemaVersion: 1, budgetId: "TEST:original-root",
    scope: centralScope, unit: "total_model_tokens", limits: { tokens: 96000, calls: 8, steps: 8 }, authorizationRef: "TEST:owner" } });
  await act({ kind: "fund", issueId: identity.issueId, expectedRevision: 2, grantId: identity.grantId, domain: "tool", allowance,
    budgetId: "TEST:original-root", expectedSequence: (await load()).sequence, authorizationRef: "TEST:owner", planRef: "TEST:original-plan" });
  let planningCalls = 0;
  const failureViews: Array<ToolLearningContext["planningFailure"]> = [];
  const owner = createToolCentralLearning({ boardRoot, scope, centralScope, now, authorized: () => true, modelRef: "TEST:model", mode: "manual",
    run: async (jobId, binding, abort) => {
  const funding = createToolLearningFunding({ boardRoot, scope, centralScope, now, managedBinding: binding });
  return workToolLearningPipeline({ boardRoot, scope, now, mode: "manual", signal: abort, jobIds: [jobId], managedBinding: binding,
    services: { executionAuthorized: true, allowance: value => funding.allowance(value), releaseAllowance: () => funding.release(),
      context: async () => ({ availableTools: [{ toolId: "runtime:search_text", description: "TEST ONLY search" }], requirements: [] }),
      search: async () => { assert.fail("no research replay"); },
      plan: async context => {
        failureViews.push(context.planningFailure);
        const reservationId = `TEST:old-call:${++planningCalls}`;

        assert.ok((await funding.reserve(reservationId, 100)).ok);
        assert.ok((await funding.settle(reservationId, unknown ? { kind: "unknown", reason: "TEST:transport" }
          : { kind: "reported", totalTokens: 10, model: "TEST:scripted" })).ok);

        if (planningCalls < originalAttempts) return {};

        return { ...reasoning, action: "reuse", toolId: "runtime:search_text", usage: "TEST ONLY future contract search, not the target capability" };
      }, evolve: async () => { assert.fail("no source generation"); } } });
    } });

  for (let index = 0; index < originalAttempts; index++) {
    const stage = await owner.prepare({ issueId: identity.issueId, authorizedAllowance: allowance }, signal);

    assert.equal(stage.status, "ready", JSON.stringify(stage));
    if (stage.status !== "ready") throw new Error("TEST ONLY original stage unavailable");

    const current = await load();
    const worked = await owner.dispatch({ issueId: identity.issueId, grantId: identity.grantId,
      expectedIssueRevision: current.learningIssues![0]!.revision, stageRef: stage.stageRef, policyRef: stage.policyRef,
      sourceBindingRef: stage.source.sourceBindingRef, offer: stage.offer }, signal);

    assert.ok(worked.ok, JSON.stringify(worked));

    if (index > 0) {
      const failure = failureViews.at(-1);
      assert.equal(failure?.code, "invalid_learning_decision", "The original worker must receive its previous rejection");
      assert.equal(failure?.response.state, "retained");
      if (failure?.response.state === "retained") assert.deepEqual(failure.response.value, {});
    }
  }

  assert.equal((await load()).jobs.find(row => row.jobId === queued.jobId)?.state, "succeeded");
  const options = { boardRoot, scope, centralScope, now, authorized: () => true };
  const text = "TEST ONLY controlled external contract: preserve value_unit, convert numeric_seconds. Not user wording or observed I/O.";
  const supplement = { type: "tool_research_supplement", schemaVersion: 1, scope, previousJobId: queued.jobId,
    previousResultRef: resultVersionId(queued.jobId, originalAttempts), createdAt: at, reason: "TEST ONLY target remains unmet",
    materials: [{ ref: "TEST:new-contract", contentHash: contentHashOf(text), text }] };

  return { options, supplement, load, plan, identity, originalJobId: queued.jobId, originalAttempts };
}

test("new material appends one same-purse research episode without reopening the original success", async t => {
  const fx = await fixture(t, false, 4), before = await fx.load();
  const received = await appendToolResearchSuccessor(fx.options, fx.supplement, signal);
  assert.ok(received.ok, JSON.stringify(received));
  const after = await fx.load();

  assert.deepEqual(after.jobs.find(row => row.jobId === fx.originalJobId), before.jobs.find(row => row.jobId === fx.originalJobId));
  assert.deepEqual(after.assets.find(row => row.versionId === fx.supplement.previousResultRef), before.assets.find(row => row.versionId === fx.supplement.previousResultRef));
  assert.equal(after.centralLearningGrants!.length, 1);
  assert.deepEqual(after.centralLearningGrants, before.centralLearningGrants);
  assert.deepEqual(toolLearningFundingIdentity(received.plan), fx.identity);
  const selected = selectToolFocusedSource(after, after.learningIssues![0], scope, centralScope);

  assert.ok(selected.ok, JSON.stringify(selected));
  assert.equal(selected.jobId, received.jobId);
  const oldStageRef = `tool-stage:${fx.originalJobId}:${fx.originalAttempts}:${contentHashOf("TEST:old-stage")}`;
  const oldPolicyRef = toolCentralPolicyRef("manual", "TEST:model");
  const oldObservation = await observeToolCentralStage({ boardRoot: fx.options.boardRoot, scope, centralScope, mode: "manual", modelRef: "TEST:model" }, {
    issueId: fx.identity.issueId, grantId: fx.identity.grantId, expectedIssueRevision: after.learningIssues![0]!.revision,
    stageRef: oldStageRef, policyRef: oldPolicyRef, sourceBindingRef: toolCentralSourceBinding(fx.originalJobId, oldStageRef, oldPolicyRef),
    offer: { offerId: "TEST:old-offer", owner: { plane: "agent", domain: "tool" }, policyRef: oldPolicyRef,
      reserve: { tokens: 100, calls: 1, steps: 1 }, maxPromptChars: 24000 } }, signal);

  assert.equal(oldObservation.outcome, "closed_no_result", "a new episode must not hide the original exact negative observation");
  const forged = await enqueueToolLearningPlan(fx.options.boardRoot, { ...received.plan,
    researchOrigin: { ...received.plan.researchOrigin!, rootPlanHash: "0".repeat(64) } });

  assert.ok(!forged.ok);
  assert.equal(forged.code, "invalid_tool_funding_origin");
  const competing = await appendToolResearchSuccessor(fx.options, { ...fx.supplement, reason: "TEST ONLY different successor",
    materials: [{ ref: "TEST:other", text: "TEST ONLY different material", contentHash: contentHashOf("TEST ONLY different material") }] }, signal);

  assert.ok(!competing.ok);
  assert.equal(competing.code, "research_successor_conflict");
  assert.equal((await fx.load()).sequence, after.sequence);
  const prepared = await prepareToolPlanningContext({ boardRoot: fx.options.boardRoot, plan: received.plan, jobId: received.jobId, attempt: 1,
    search: { status: "complete", candidates: [], failures: [] }, services: {}, signal }, { grantId: fx.identity.grantId,
    maxCalls: 8, maxTokens: 96000, callsRemaining: 7, tokensRemaining: 95990, maxPromptChars: 24000 });

  assert.ok(prepared.ok, JSON.stringify(prepared));
  assert.ok(prepared.context.requirements.some(row => row.ref === "TEST:new-contract" && row.kind === "external_contract"));
  assert.ok(prepared.context.history!.some(row => row.action === "reuse" && row.code === "existing_capability_reused"));
  const owner = createToolCentralLearning({ ...fx.options, modelRef: "TEST:model", mode: "manual", run: async () => { assert.fail("prepare is read-only"); } });
  const stage = await owner.prepare({ issueId: fx.identity.issueId, authorizedAllowance: allowance }, signal);

  assert.equal(stage.status, "ready", JSON.stringify(stage));
  const repeated = await appendToolResearchSuccessor(fx.options, fx.supplement, signal);
  assert.ok(repeated.ok);
  assert.equal(repeated.jobId, received.jobId);
  const binding = { issueId: fx.identity.issueId, grantId: fx.identity.grantId, budgetId: "TEST:original-root",
    expectedIssueRevision: after.learningIssues![0]!.revision };
  const funding = createToolLearningFunding({ ...fx.options, managedBinding: binding });
  const worked = await workToolLearningPipeline({ ...fx.options, now, mode: "manual", signal, jobIds: [received.jobId], managedBinding: binding,
    services: { executionAuthorized: true, allowance: value => funding.allowance(value), releaseAllowance: () => funding.release(),
      context: async () => ({ availableTools: [], requirements: [] }), search: async () => { assert.fail("no old research replay"); },
      plan: async () => { assert.ok((await funding.reserve("TEST:new-call", 100)).ok);
        assert.ok((await funding.settle("TEST:new-call", { kind: "reported", totalTokens: 11, model: "TEST:scripted" })).ok);
        return { ...reasoning, action: "defer", reason: "more_evidence", neededEvidence: ["TEST ONLY stop after one new funded episode"] }; },
      evolve: async () => { assert.fail("no source generation"); } } });

  assert.ok(worked.ok);
  assert.equal(worked.results[0]?.code, "more_evidence");
  const final = await fx.load();
  assert.deepEqual(centralLearningSpent(final.centralLearningGrants![0]!), { tokens: 51, calls: 5, steps: 5 });
  assert.equal(final.jobs.find(row => row.jobId === fx.originalJobId)?.state, "succeeded");
});

test("an unknown original bill cannot be replayed as a fresh research episode", async t => {
  const fx = await fixture(t, true), before = await fx.load();
  const result = await appendToolResearchSuccessor(fx.options, fx.supplement, signal);
  assert.ok(!result.ok);
  assert.equal(result.code, "research_predecessor_not_qualified");
  assert.equal((await fx.load()).sequence, before.sequence);
});

test("a successor's controlled contract reaches construction and its frozen continuation", async t => {
  const fx = await fixture(t);
  const text = fx.supplement.materials[0]!.text + "\nTEST ONLY public specification notes".repeat(160) + "TEST_CONTRACT_TAIL";
  const supplement = { ...fx.supplement, materials: [{ ref: "TEST:new-contract", text, contentHash: contentHashOf(text) }] };
  const received = await appendToolResearchSuccessor(fx.options, supplement, signal);
  assert.ok(received.ok);
  const state = await fx.load(), binding = { issueId: fx.identity.issueId, grantId: fx.identity.grantId, budgetId: "TEST:original-root",
    expectedIssueRevision: state.learningIssues![0]!.revision };
  const funding = createToolLearningFunding({ ...fx.options, managedBinding: binding });
  const evidence = [
    { sampleId: "one", role: "source", input: 1, expected: { kind: "value", value: 1 } },
    { sampleId: "two", role: "source", input: 2, expected: { kind: "value", value: 2 } },
    { sampleId: "zero", role: "variation", input: 0, expected: { kind: "value", value: 0 } },
    { sampleId: "invalid", role: "counterexample", input: null, expected: { kind: "error", code: "invalid_input" } },
  ];
  let plans = 0, constructions = 0;
  const services: ToolPipelineServices = { executionAuthorized: true, allowance: value => funding.allowance(value), releaseAllowance: () => funding.release(),
    search: async () => { assert.fail("no research replay"); },
    plan: async () => { plans++;
      return { ...reasoning, action: "create", request: { schemaVersion: 1, requestId: "TEST:contract-continuation", scope,
        capability: fx.plan.capability, operation: "create", evidence, maxAttempts: 1 },
        sampleOrigins: evidence.map(sample => ({ sampleId: sample.sampleId, kind: "synthesized", ref: "TEST:new-contract" })) }; },
    evolve: async (request, _signal, feedback, _admission, requirements) => {
      constructions++;
      assert.ok(Array.isArray(requirements), "The construction worker must receive the original public requirements");
      assert.ok(requirements.some(row => row.text.endsWith(text)), "Do not reduce the controlled contract to two positive examples");
      assert.ok(evolutionPrompt(request, feedback, undefined, requirements).includes("TEST_CONTRACT_TAIL"), "Public requirements must survive the separate diagnostic excerpt limit");
      return { kind: "failed" as const, code: TOOL_CONSTRUCTION_NOT_STARTED, message: "TEST ONLY stop before a provider request", attempts: 0 };
    } };

  for (let segment = 0; segment < 2; segment++) {
    const worked = await workToolLearningPipeline({ ...fx.options, now, mode: "manual", signal, jobIds: [received.jobId], managedBinding: binding, services });
    assert.ok(worked.ok);
    assert.equal(worked.results[0]?.code, TOOL_CONSTRUCTION_NOT_STARTED);
  }

  assert.equal(plans, 1);
  assert.equal(constructions, 2);
});
