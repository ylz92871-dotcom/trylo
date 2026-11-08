import assert from "node:assert/strict";
import test from "node:test";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { seedToolProduction, productionTestTime } from "../testing/production-fixtures.js";
import { enqueueToolLearningPlan, readToolLearningPipeline, registerToolLearningRecipe } from "./pipeline-queue.js";
import { workToolLearningPipeline, type ToolPipelineServices } from "./pipeline-worker.js";
import { createToolEvolutionArchive } from "./evolution-archive.js";
import { readToolEvolutionCandidate } from "./evolution-reader.js";
import { openToolCandidateUse } from "./evolution-use.js";
import type { ToolEvolutionRequest } from "../domain/evolution/contracts.js";
import { frozenToolRecipeForResult } from "./frozen-recipe.js";
import { toolConstructionNeedsEvidence } from "../domain/evolution/construction-stop.js";

test("construction waits preserve the exact frozen recipe across new facts and a competing same-capability recipe, without replanning or automatic retry", async t => {
  const fx = await seedToolProduction(t), parent = await readToolEvolutionCandidate(fx.root, fx.origin.versionId);
  assert.ok(parent.ok);
  const baseline = parent.artifact.request.evidence;
  const extraRequestedCases = fx.plan.checks.evidence.filter(sample => !baseline.some(prior => contentHashOf(prior) === contentHashOf(sample)))
    .map(sample => ({ ...sample, sampleId: `requested-${sample.sampleId}` }));
  const original: ToolEvolutionRequest = { ...fx.plan.checks, requestId: "first-frozen-decision", operation: "create", evidence: [...baseline, ...extraRequestedCases] };

  for (const requested of fx.plan.checks.evidence) assert.ok(original.evidence.some(sample =>
    contentHashOf({ role: sample.role, input: sample.input, expected: sample.expected })
      === contentHashOf({ role: requested.role, input: requested.input, expected: requested.expected })), "workspace binding must not discard an originally requested check");

  const signal = new AbortController().signal;
  let realUses = 0;
  const mount = await openToolCandidateUse({ boardRoot: fx.root, versionId: fx.origin.versionId, sessionId: "later-real-task", workspaceId: "workspace-test",
    now: () => 0, newId: () => `new-task-use-${++realUses}`, warn: message => assert.fail(message), executor: { execute: async (_candidate, input) => ({ kind: "value", value: Number(input) * 2 }) } });

  assert.ok(mount.ok);
  t.after(mount.mount.close);
  await mount.mount.tools.execute({ toolCallId: "initial-source-call", name: mount.mount.binding.name, arguments: { input: 1 } }, signal);
  const plan = { type: "tool_learning_plan", schemaVersion: 1, scope: "test", capability: "double", createdAt: productionTestTime,
    targetVersionId: fx.origin.versionId,
    trigger: { action: "user_requested", runId: "freeze-task", proposalKey: "freeze-resume", evidenceRefs: ["user:contract", fx.origin.versionId, "new-task-use-1"] } };
  const queued = await enqueueToolLearningPlan(fx.root, plan);
  assert.ok(queued.ok);
  let plans = 0, generations = 0, searches = 0;
  const services: ToolPipelineServices = { executionAuthorized: true,
    allowance: async () => ({ grantId: "TEST ONLY original grant", maxCalls: 4, callsRemaining: 4, maxTokens: 32000, tokensRemaining: 32000, maxPromptChars: 24000 }),
    context: async () => ({ availableTools: [], requirements: [{ ref: "user:contract", kind: "user_requirement", text: "Double every finite numeric input." }] }),
    plan: async () => { plans++;
    assert.equal(plans, 1);
    return { action: "create", request: original,
      sampleOrigins: original.evidence.map(sample => ({ sampleId: sample.sampleId, kind: "synthesized", ref: "user:contract" })),
      rationale: "TEST ONLY frozen construction", existingInsufficiency: "TEST ONLY missing ABI", expectedBenefit: "Unverified", constructionCost: "Original allowance", alternatives: ["Reuse was considered"] }; },
    search: async () => {
      searches++;
      return { status: "complete", candidates: [], failures: [] };
    },
    evolve: async (request, _signal, _feedback, admission) => {
      generations++;
      assert.deepEqual(request.evidence, original.evidence, "a new task fact must not regenerate or replace the oracle");

      if (generations < 3) return { kind: "failed", code: generations === 1 ? "parent_source_evidence_required" : "learning_budget_exhausted",
        message: "TEST ONLY original source/allowance boundary", attempts: 1 };

      const candidate = { identity: "frozen-double", description: "TEST ONLY", source: "module.exports=input=>input*2;", inputSchema: { type: "number" }, mastery: { whenToUse: ["TEST ONLY · double numeric input"], preconditions: [], pitfalls: [] } };
      const artifact = { schemaVersion: 1 as const, request, candidate, generatedAt: productionTestTime,
        verification: { verdict: "pass" as const, candidateHash: contentHashOf(candidate), samplesHash: contentHashOf(request.evidence),
          checks: request.evidence.map(sample => ({ sampleId: sample.sampleId, role: sample.role, outcome: "passed" as const, detail: "TEST ONLY contract fixture" })) } };
      const saved = await createToolEvolutionArchive(fx.root, { jobAdmission: admission }).save(artifact);
      assert.ok(saved.ok);

      return { kind: "candidate", ...saved, artifact, attempts: 1 };
    } };
  const input = { boardRoot: fx.root, scope: "test", mode: "after_turn" as const, now: () => 0, services, jobIds: [queued.jobId], signal: new AbortController().signal };

  await workToolLearningPipeline(input);
  const first = await readToolLearningPipeline(fx.root);
  assert.ok(first.ok);
  const frozen = first.jobs.find(job => job.jobId === queued.jobId)?.result;
  assert.ok(frozen);
  assert.equal(frozen.outcome, "waiting_evidence");
  assert.ok(frozen.recipeVersionId && frozen.decisionVersionId);
  assert.ok((await registerToolLearningRecipe(fx.root, { type: "tool_learning_recipe", schemaVersion: 1, automation: "after_turn",
    request: { ...original, evidence: original.evidence.map((sample, index) => index === 0 ? { ...sample, expected: { kind: "value", value: 999 } } : sample) } }, productionTestTime)).ok);
  await workToolLearningPipeline(input);
  assert.equal(plans, 1);
  assert.equal(generations, 1, "unchanged task facts never refire construction");
  await mount.mount.tools.execute({ toolCallId: "later-call", name: mount.mount.binding.name, arguments: { input: 2 } }, input.signal);
  const stopped = await workToolLearningPipeline(input);
  assert.ok(stopped.ok);
  assert.equal(stopped.results[0]?.code, "learning_budget_exhausted");
  await workToolLearningPipeline(input);
  assert.equal(generations, 2, "a second stop records the current facts fingerprint instead of repeatedly waking from the first one");
  await mount.mount.tools.execute({ toolCallId: "later-second-call", name: mount.mount.binding.name, arguments: { input: 3 } }, input.signal);
  const resumed = await workToolLearningPipeline(input);
  assert.ok(resumed.ok);
  assert.equal(resumed.results[0]?.code, "candidate_pending_review");
  const after = await readToolLearningPipeline(fx.root);
  assert.ok(after.ok);
  const result = after.jobs.find(job => job.jobId === queued.jobId)?.result;
  assert.ok(result);
  assert.equal(result.recipeVersionId, frozen.recipeVersionId);
  assert.equal(result.decisionVersionId, frozen.decisionVersionId);
  assert.deepEqual({ plans, generations, searches }, { plans: 1, generations: 3, searches: 0 });
  const loaded = await createBoardReader(fx.root).load();
  assert.ok(loaded.ok);
  const job = loaded.state.jobs.find(row => row.jobId === queued.jobId)!;
  const badState = { ...loaded.state, assets: loaded.state.assets.map(asset => asset.versionId === frozen.recipeVersionId
    ? { ...asset, content: { type: "tool_learning_recipe", schemaVersion: 1, automation: "after_turn", request: { ...original, capability: "forged" } },
      contentHash: contentHashOf({ type: "tool_learning_recipe", schemaVersion: 1, automation: "after_turn", request: { ...original, capability: "forged" } }) } : asset) };

  assert.equal(frozenToolRecipeForResult(badState, { ...job, attempt: frozen.attempt }, { ...plan, type: "tool_learning_plan", schemaVersion: 1 }, frozen).ok, false, "a rehashed but differently bound internal recipe cannot resume");
  assert.equal(toolConstructionNeedsEvidence("generation_context_exceeds_allowance"), true);
  assert.equal(toolConstructionNeedsEvidence("provider_error"), false, "provider failures are not automatically retried as missing source facts");
});
