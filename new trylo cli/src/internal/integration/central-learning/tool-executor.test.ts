import { testScratchPath } from "../../testing/scratch.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import { createArtifactWorker } from "../../adapters/tool-evolution/artifact-worker.js";
import { SubagentRuntime } from "../../subagent/runtime.js";
import { SubagentToolRunner } from "../../subagent/tool-runner.js";
import { emptyUsage, type ProviderPort } from "../../ports/provider.js";
import type { CentralLearningAllowance, CoordinationAction } from "../../learning/control/coordination-contract.js";
import { centralLearningSpent } from "../../learning/control/coordination-contract.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { ToolLearningPlan } from "../../learning/agent/subsystems/tool/domain/evolution/pipeline.js";
import { enqueueToolLearningPlan } from "../../learning/agent/subsystems/tool/runtime/pipeline-queue.js";
import { createToolLearningFunding } from "../../learning/agent/subsystems/tool/runtime/learning-funding.js";
import { workToolLearningPipeline } from "../../learning/agent/subsystems/tool/runtime/pipeline-worker.js";
import { retireToolLearningWorkers } from "../../learning/agent/subsystems/tool/runtime/session-retirement.js";
import { withToolLearningFunding } from "../../learning/agent/subsystems/tool/adapters/evolution/funded-provider.js";
import { planToolLearning } from "../../learning/agent/subsystems/tool/adapters/evolution/planning-model.js";
import { createLearningAllocationApplication } from "../learning-allocation/application.js";
import { createCentralToolExecutor } from "./tool-executor.js";
import type { CentralFundedStage, CentralStagePreparation } from "./contracts.js";
import type { CentralLearningContextReader } from "../../learning/control/source-context.js";

const at = "2026-11-04T13:10:00.000Z", scope = "workspace:tool-assets", centralScope = "workspace:central-tool";
const authorization: CentralLearningAllowance = { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 48000,
  maxCalls: 4, maxSteps: 4, maxPromptChars: 24000 };
const reasoning = { rationale: "TEST ONLY scripted planning", existingInsufficiency: "TEST ONLY source requirement",
  expectedBenefit: "unverified hypothesis", constructionCost: "bounded by original grant", alternatives: [] };

async function fixture(t: TestContext, response: "acquire" | "defer" | "cancel" = "acquire", contextForIssue?: CentralLearningContextReader) {
  const parent = testScratchPath("central-tool-executor-tests");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "case-"));

  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    await rm(root, { recursive: true, force: true });
  });
  const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope,
    capability: "TEST ONLY original durable capability requirement", createdAt: at,
    trigger: { runId: "actual-source-task", proposalKey: "central-tool-contract", action: "user_requested", evidenceRefs: ["task:actual-requirement"] } };
  const queued = await enqueueToolLearningPlan(root, plan);
  assert.ok(queued.ok);
  let serial = 0, calls = 0, reservation = 0;
  const prompts: string[] = [];
  const load = async () => {
    const result = await createBoardReader(root).load();
    assert.ok(result.ok);
    return result.state;
  };
  const act = async (action: CoordinationAction) => {
    const result = await withBoardWriter(root, board => board.apply({ type: "coordinate_learning", commandId: `tool-test:${++serial}`, issuedAt: at, action }));
    assert.ok(result.ok);
    return result.state;
  };

  await act({ kind: "open_budget", expectedSequence: (await load()).sequence, budget: { schemaVersion: 1, budgetId: "root:tool", scope: centralScope,
    unit: "total_model_tokens", limits: { tokens: 100000, calls: 8, steps: 8 }, authorizationRef: "test:independent-tool-root" } });
  const controller = new AbortController();
  const options = { boardRoot: root, scope, centralScope, now: () => Date.parse(at), modelRef: "scripted-tool-model", mode: "after_turn" as const,
    authorized: () => true, ...(contextForIssue === undefined ? {} : { contextForIssue }),
    contextServices: { context: async () => ({ availableTools: [], requirements: [] }) },

    run: async (jobId: string, binding: Parameters<typeof createToolLearningFunding>[0]["managedBinding"], signal: AbortSignal) => {
      assert.ok(binding);
      assert.equal(jobId, queued.jobId);
      const funding = createToolLearningFunding({ boardRoot: root, scope, centralScope, now: () => Date.parse(at), managedBinding: binding });
      const child: ProviderPort = { async *stream(request) {
        calls += 1;
        prompts.push(request.messages.map(item => item.content).join("\n"));
        yield { type: "stream_start", providerId: "scripted-contract", model: request.model, warnings: [] };

        if (response === "cancel") {
          controller.abort();
          yield { type: "cancel_ack" };
          return;
        }

        const decision = response === "defer" ? { ...reasoning, action: "defer", reason: "not_worthwhile", neededEvidence: [] }
          : calls === 1 ? { ...reasoning, action: "research", query: "TEST ONLY inspect a package option" }
            : { ...reasoning, action: "acquire", candidate: { platform: "npm", id: "TEST_ONLY-package", version: "1.0.0" },
              adaptation: "TEST ONLY reviewed installation remains subject to original approval" };

        yield { type: "text_delta", blockId: "plan", text: JSON.stringify(decision) };
        yield { type: "usage", usage: { ...emptyUsage(), inputTokens: 120, outputTokens: 30, totalTokens: 150 } };
        yield { type: "finish", reason: "stop", rawReason: "stop", requiresFollowUp: false };
      } };
      const base: ProviderPort = { stream: child.stream, fork: () => child };
      const provider = withToolLearningFunding(base, { funding, newId: () => `central-tool-reservation:${++reservation}` });
      const runtime = new SubagentRuntime({ tools: { snapshot: () => [], execute: async () => ({ outcome: "error", code: "unknown_tool",
        message: "The artifact worker has no production tool authority" }), cancel: async () => {} } });
      const runner = new SubagentToolRunner(runtime, createArtifactWorker({ provider, model: "scripted-tool-model",
        instruction: "TEST ONLY return the bounded domain planning JSON", requestPrefix: "tool-planning", maxOutputTokens: 4096 }));

      try {
        return await workToolLearningPipeline({ boardRoot: root, scope, now: () => Date.parse(at), mode: "after_turn", signal, jobIds: [jobId], maxJobs: 1,
          services: { ...(binding.centralSourceContext === undefined ? {} : { centralSourceContext: binding.centralSourceContext }),
            allowance: value => funding.allowance(value), releaseAllowance: async () => {
            try { await retireToolLearningWorkers(runtime); } finally { await funding.release(); }
          }, context: async () => ({ availableTools: [], requirements: [] }),
          search: async () => ({ status: "complete", candidates: [{ platform: "npm", id: "TEST_ONLY-package", version: "1.0.0",
            sourceUrl: "https://www.npmjs.com/package/TEST_ONLY-package", licenseSpdx: "MIT" }], failures: [] }),
          plan: (value, sourceSignal) => planToolLearning(runner, value, { taskId: `actual-planning-worker:${calls + 1}`, signal: sourceSignal, timeoutMs: 5000 }),
          evolve: async () => { assert.fail("the scripted acquisition proposal must never construct or activate a tool"); } } });
      } finally { await retireToolLearningWorkers(runtime); }
    } };
  const executor = createCentralToolExecutor(options);
  const nominateAndFocus = async () => {
    const ids = await executor.nominate!(controller.signal);
    assert.equal(ids.length, 1);
    const state = await load(), issue = state.learningIssues!.find(item => item.issueId === ids[0])!;

    assert.equal(issue.decision.kind, "unreviewed");
    assert.equal(state.centralLearningGrants?.length ?? 0, 0);
    assert.equal(calls, 0);
    await act({ kind: "decide", issueId: issue.issueId, expectedRevision: issue.revision, decision: "focused_learning",
      reason: "TEST PA focuses the original queued capability", sourceRefs: issue.reports[0]!.evidenceRefs });
    const prepared = await executor.prepare({ issueId: issue.issueId, authorizedAllowance: authorization }, controller.signal);

    assert.ok(prepared.status === "ready", JSON.stringify(prepared));
    assert.deepEqual(prepared.policyFamily, { ref: prepared.policyRef, sourceRef: prepared.policyRef, response: "shared_or_exact_treatment" });

    return prepared;
  };
  const fund = async (prepared: Extract<CentralStagePreparation, { status: "ready" }>): Promise<CentralFundedStage> => {
    const state = await load(), issue = state.learningIssues!.find(item => item.issueId === prepared.source.issueId)!;
    const app = createLearningAllocationApplication({ boardRoot: root, now: () => at, enabled: () => true });
    const result = await app.commit({ kind: "portfolio", authorizationRef: "test:independent-tool-stage",
      proposalJson: JSON.stringify({ schemaVersion: 1, basis: { scope: centralScope, boardSequence: state.sequence, budgetId: "root:tool",
        utilityUnit: "test-only-proposal-delivery", valuationRef: "test-only-fixed-selection" }, unit: "total_model_tokens", domainRelation: "separable",
        budget: { tokens: 100000, calls: 8, steps: 8 }, groups: [{ owner: prepared.offer.owner, tiers: [{ quota: 1, netValue: .1, offer: prepared.offer }] }] }),
      bindingsJson: JSON.stringify([{ offerId: prepared.offer.offerId, offerHash: contentHashOf(prepared.offer), policyRef: prepared.policyRef,
        sourceBindingRef: prepared.source.sourceBindingRef, authorizedAllowance: authorization, issueId: issue.issueId, expectedIssueRevision: issue.revision,
        grantId: prepared.source.grantId, mode: "fund", chargedAtBasis: { tokens: 0, calls: 0, steps: 0 } }]) });

    assert.equal(result.status, "committed");
    const current = await load();

    return { issueId: issue.issueId, grantId: prepared.source.grantId, expectedIssueRevision: current.learningIssues!.find(item => item.issueId === issue.issueId)!.revision,
      stageRef: prepared.stageRef, policyRef: prepared.policyRef, sourceBindingRef: prepared.source.sourceBindingRef, offer: prepared.offer };
  };

  return { root, executor, load, act, fund, nominateAndFocus, controller, prompts, calls: () => calls };
}

test("central tool execution reaches the real planning worker and returns a source-bound approval proposal", async t => {
  const f = await fixture(t), funded = await f.fund(await f.nominateAndFocus());
  const dispatched = await f.executor.dispatch(funded, f.controller.signal);

  assert.ok(dispatched.ok, JSON.stringify(dispatched));
  assert.equal(dispatched.status, "waiting_dependency");
  assert.equal(f.calls(), 2);
  const state = await f.load(), grant = state.centralLearningGrants!.find(item => item.grantId === funded.grantId)!;

  assert.equal(state.centralLearningGrants!.length, 1);
  assert.equal(grant.budgetId, "root:tool");
  assert.equal(grant.claim, undefined);
  assert.deepEqual(centralLearningSpent(grant), { tokens: 300, calls: 2, steps: 2 });
  assert.equal(state.activations.length, 0, "a funded acquisition proposal is not installation or activation authority");
  const observation = await f.executor.observe(funded, new AbortController().signal);

  assert.equal(observation.outcome, "qualified");
  assert.ok(observation.resultRefs.some(ref => ref.startsWith("tool-decision_v1_")));
  const repeated = await f.executor.dispatch(funded, new AbortController().signal);

  assert.ok(!repeated.ok);
  assert.equal(f.calls(), 2, "the original attempt is never dispatched as fresh money twice");
});

test("real tool defer can close without a proposal; cancellation leaves delivery pending and unknown spend intact", async t => {
  for (const response of ["defer", "cancel"] as const) {
    const f = await fixture(t, response), funded = await f.fund(await f.nominateAndFocus());

    await f.executor.dispatch(funded, f.controller.signal);
    const observation = await f.executor.observe(funded, new AbortController().signal);

    assert.equal(observation.outcome, response === "defer" ? "closed_no_result" : "pending");
    const grant = (await f.load()).centralLearningGrants![0]!;

    assert.equal(grant.grantId, funded.grantId);
    assert.equal(grant.reservations.length, 1);
    assert.equal(grant.reservations[0]!.usage?.kind, response === "defer" ? "reported" : "unknown");
  }
});

test("public issue content enters the funded tool planner and changed content cannot reuse its quote", async t => {
  let content = { ref: "content:tool-public-v1", text: "Preserve the unresolved streaming condition and the documented caller boundary." };
  const f = await fixture(t, "defer", async () => content), funded = await f.fund(await f.nominateAndFocus());
  const completed = await f.executor.dispatch(funded, f.controller.signal);
  assert.ok(completed.ok);
  assert.ok(f.prompts[0]!.includes(content.text));
  assert.ok(f.prompts[0]!.includes(content.ref));
  assert.ok(f.prompts[0]!.includes("unverified"));
  const other = await fixture(t, "defer", async () => content), stale = await other.fund(await other.nominateAndFocus());

  content = { ref: "content:tool-public-v2", text: "A new source analysis changes the caller condition." };
  const rejected = await other.executor.dispatch(stale, other.controller.signal);

  assert.ok(!rejected.ok);
  assert.equal(other.calls(), 0);
  assert.equal((await other.load()).centralLearningGrants![0]!.claim, undefined);
});

test("full tool source content is capacity-checked with the original planner before a grant is issued", async t => {
  const f = await fixture(t, "defer", async () => ({ ref: "content:tool-large", text: "Complete unabridged tool condition. ".repeat(1000) }));
  const ids = await f.executor.nominate!(f.controller.signal), state = await f.load(), issue = state.learningIssues!.find(item => item.issueId === ids[0])!;

  await f.act({ kind: "decide", issueId: issue.issueId, expectedRevision: issue.revision, decision: "focused_learning",
    reason: "TEST PA selected the actual queue source", sourceRefs: issue.reports[0]!.evidenceRefs });
  const prepared = await f.executor.prepare({ issueId: issue.issueId, authorizedAllowance: authorization }, f.controller.signal);

  assert.ok(prepared.status === "unavailable");
  assert.equal(prepared.reason, "planning_context_exceeds_allowance");
  assert.equal(f.calls(), 0);
  assert.equal((await f.load()).centralLearningGrants?.length ?? 0, 0);
});
