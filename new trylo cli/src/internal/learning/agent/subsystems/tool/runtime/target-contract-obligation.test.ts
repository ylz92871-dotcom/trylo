import assert from "node:assert/strict";
import test from "node:test";
import type { ToolCompositionPlan, ToolEvolutionRequest, ToolEvolutionSample } from "../domain/evolution/contracts.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { seedToolProduction, productionTestTime } from "../testing/production-fixtures.js";
import { readToolEvolutionCandidate } from "./evolution-reader.js";
import { enqueueToolLearningPlan } from "./pipeline-queue.js";
import { workToolLearningPipeline, type ToolPipelineServices } from "./pipeline-worker.js";

test("an exact artifact repair retains its baseline regardless of create or compose, while an independent new task remains independent", async t => {
  // TEST ONLY host routing fixture. Reaching a construction callback below is
  // not a model, source verification, native execution or candidate verdict.
  const fx = await seedToolProduction(t), original = await readToolEvolutionCandidate(fx.root, fx.origin.versionId);
  assert.ok(original.ok);
  const baseline = original.artifact.request.evidence;
  const replacement: ToolEvolutionSample = { sampleId: "new-invalid-case", role: "counterexample", input: false, expected: { kind: "error", code: "invalid_input" } };
  const weakened = [...baseline.filter(sample => sample.role !== "counterexample"), replacement];
  const reasoning = { rationale: "TEST ONLY investigate the specified artifact", existingInsufficiency: "The caller requested an investigation",
    expectedBenefit: "Unverified", constructionCost: "One bounded source proposal", alternatives: ["Keep the old artifact or obtain an explicit contract revision"] };
  const { source: _source, ...descriptor } = original.artifact.candidate;
  const composition: ToolCompositionPlan = { schemaVersion: 1, steps: [{ stepId: "old", versionId: fx.origin.versionId,
    input: { from: "input", path: [] } }, { stepId: "confirm", versionId: fx.origin.versionId,
    input: { from: "input", path: [] } }], output: { from: "step", stepId: "confirm", path: [] } };

  for (const action of ["create", "compose"] as const) for (const preserve of [false, true]) {
    const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope: "test", capability: "double", createdAt: productionTestTime,
      targetVersionId: fx.origin.versionId, trigger: { action: "user_requested", runId: `${action}-${preserve}`, proposalKey: `${action}-${preserve}`,
        evidenceRefs: [fx.origin.versionId, "user:explicit-invalid"] } };
    const queued = await enqueueToolLearningPlan(fx.root, plan);
    assert.ok(queued.ok);
    let constructions = 0;
    const request: ToolEvolutionRequest = { ...original.artifact.request, requestId: `${action}-${preserve}`, evidence: preserve ? baseline : weakened,
      ...(action === "compose" ? { composition } : {}) };
    const reached: ToolPipelineServices["evolve"] = async frozen => {
      constructions++;
      if (preserve) assert.deepEqual(frozen.evidence, baseline);
      return { kind: "failed", code: "test_only_construction_reached", message: "TEST ONLY no generated candidate", attempts: 0 };
    };
    const services: ToolPipelineServices = { executionAuthorized: true,
      allowance: async () => ({ grantId: "TEST ONLY original bounded allowance", maxCalls: 3, callsRemaining: 3, maxTokens: 48000, tokensRemaining: 48000, maxPromptChars: 24000 }),
      context: async () => ({ availableTools: [], requirements: [{ ref: "user:explicit-invalid", kind: "user_requirement", text: "Reject the specified nonnumeric input." }] }),
      search: async () => { assert.fail("the exact artifact requires no discovery"); },
      plan: async context => {
        assert.ok(context.priorVersions.some(prior => prior.versionId === fx.origin.versionId));
        return { ...reasoning, action, request, ...(action === "compose" ? { descriptor } : {}), sampleOrigins: request.evidence.map(sample => ({
          sampleId: sample.sampleId, kind: sample.sampleId === replacement.sampleId ? "synthesized" : "contract",
          ref: sample.sampleId === replacement.sampleId ? "user:explicit-invalid" : `${fx.origin.versionId}:${sample.sampleId}` })) };
      }, evolve: reached, compose: (frozen, _descriptor, cancelled, feedback, admission) => reached(frozen, cancelled, feedback, admission),
    };
    const worked = await workToolLearningPipeline({ boardRoot: fx.root, scope: "test", mode: "manual", jobIds: [queued.jobId], now: () => 0,
      signal: new AbortController().signal, services });
    assert.ok(worked.ok);
    assert.equal(worked.results[0]?.code, preserve ? "test_only_construction_reached" : "prior_contract_weakened");
    assert.equal(constructions, preserve ? 1 : 0, "changing the planner action cannot spend a source call after dropping an old case");
  }

  const independent: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope: "test", capability: "double", createdAt: productionTestTime,
    trigger: { action: "user_requested", runId: "independent", proposalKey: "independent", evidenceRefs: ["user:independent-contract"] } };
  const queued = await enqueueToolLearningPlan(fx.root, independent);
  assert.ok(queued.ok);
  let constructions = 0;
  const worked = await workToolLearningPipeline({ boardRoot: fx.root, scope: "test", mode: "manual", jobIds: [queued.jobId], now: () => 0,
    signal: new AbortController().signal, services: {
      executionAuthorized: true,
      allowance: async () => ({ grantId: "TEST ONLY independent allowance", maxCalls: 3, callsRemaining: 3, maxTokens: 48000, tokensRemaining: 48000, maxPromptChars: 24000 }),
      context: async () => ({ availableTools: [], requirements: [{ ref: "user:independent-contract", kind: "user_requirement", text: "Create an independent function for these explicit inputs." }] }),
      search: async () => { assert.fail("no discovery requested"); },
      plan: async () => ({ ...reasoning, action: "create", request: { ...original.artifact.request, requestId: "independent", evidence: weakened },
        sampleOrigins: weakened.map(sample => ({ sampleId: sample.sampleId, kind: "synthesized", ref: "user:independent-contract" })) }),
      evolve: async frozen => { constructions++;
      assert.deepEqual(frozen.evidence, weakened);
        return { kind: "failed", code: "test_only_construction_reached", message: "TEST ONLY no generated candidate", attempts: 0 }; },
    } });
  assert.ok(worked.ok);
  assert.equal(worked.results[0]?.code, "test_only_construction_reached");
  assert.equal(constructions, 1);
});
