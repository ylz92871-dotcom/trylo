import assert from "node:assert/strict";
import test from "node:test";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { VALIDATION_STAGE_ORDER, type ValidationRecord, type ValidationStageName } from "../../../../../tooling/contract/types.js";
import { seedToolProduction, productionTestTime } from "../testing/production-fixtures.js";
import { toolProductionCheckDiagnosis, toolProductionSampleFailure } from "../domain/evolution/production-check.js";
import type { ToolProductionPlan } from "../domain/evolution/production-plan.js";
import { claimToolProductionCheck, finishToolProductionCheck } from "./production-jobs.js";
import { scheduleToolProductionCheckLearning, resumeToolProductionCheckLearning } from "./production-check-learning.js";
import { toolLearningProductionFailures } from "./production-check-reader.js";
import { planForJob, readToolLearningPipeline } from "./pipeline-queue.js";
import { workToolLearningPipeline, type ToolPipelineServices } from "./pipeline-worker.js";
import { readToolEvolutionCandidate } from "./evolution-reader.js";
import { toolLearningInputFingerprint } from "./pipeline-planning.js";

function failedRecord(versionId: string, stage: ValidationStageName): ValidationRecord {
  const failedIndex = VALIDATION_STAGE_ORDER.indexOf(stage);
  const stages = VALIDATION_STAGE_ORDER.map((name, index) => ({ stage: name, passed: index < failedIndex,
    detail: "TEST ONLY checker detail PRIVATE_HELDOUT_DIAGNOSTIC" }));
  return { validationId: `validation:${versionId}:${contentHashOf(stages)}`, packageVersionId: versionId, actor: "verifier", verdict: "fail", stages };
}

function diagnosis(plan: ToolProductionPlan, record: ValidationRecord, unavailable = false) {
  const hidden = { sampleId: "PRIVATE_HELDOUT_ID", role: "variation" as const, input: "PRIVATE_HELDOUT_INPUT",
    expected: { kind: "value" as const, value: "PRIVATE_HELDOUT_EXPECTED" } };
  return toolProductionCheckDiagnosis(plan, record, toolProductionSampleFailure(hidden, unavailable
    ? { kind: "unavailable", detail: "PRIVATE_ENVIRONMENT_DETAIL" } : { kind: "value", value: "PRIVATE_ACTUAL" }, "heldout"));
}

test("completed exact production mismatches enter one durable learning question, including restart and concurrent handoff", async t => {
  const fx = await seedToolProduction(t), input = { ...fx.selection, issuedAt: productionTestTime };
  const record = failedRecord(input.versionId, "baseline_regression"), sidecar = diagnosis(fx.plan, record);
  assert.ok(sidecar);
  const claim = await claimToolProductionCheck(input);
  assert.ok(claim.ok);
  assert.deepEqual(await scheduleToolProductionCheckLearning({ ...input, jobId: claim.jobId }), { kind: "not_requested", reason: "no_failed_check" });
  assert.equal((await finishToolProductionCheck({ ...input, jobId: claim.jobId, record, outcome: "failed", diagnosis: { ...sidecar, checksHash: "0".repeat(64) } })).ok, false);
  assert.ok((await finishToolProductionCheck({ ...input, jobId: claim.jobId, record, outcome: "failed", diagnosis: sidecar })).ok);
  // Simulate process loss after finish: restart recovery must perform the handoff.
  const resumed = await resumeToolProductionCheckLearning(fx.root, input.workspaceId);
  assert.ok(resumed.ok);
  assert.equal(resumed.jobIds.length, 1);
  const jobId = resumed.jobIds[0]!;
  const firstState = await createBoardReader(fx.root).load();
  assert.ok(firstState.ok);
  const firstPlan = planForJob(firstState.state, jobId);
  assert.ok(firstPlan);
  const firstFingerprint = toolLearningInputFingerprint(firstState.state, firstPlan);
  const concurrent = await Promise.all([scheduleToolProductionCheckLearning({ ...input, jobId: claim.jobId }), scheduleToolProductionCheckLearning({ ...input, jobId: claim.jobId })]);

  assert.ok(concurrent.every(item => item.kind === "queued" && item.jobId === jobId));
  const second = await claimToolProductionCheck(input);
  assert.ok(second.ok);
  assert.ok((await finishToolProductionCheck({ ...input, jobId: second.jobId, record, outcome: "failed", diagnosis: sidecar })).ok);
  const duplicate = await scheduleToolProductionCheckLearning({ ...input, jobId: second.jobId });
  assert.equal(duplicate.kind, "queued");

  if (duplicate.kind === "queued") assert.equal(duplicate.jobId, jobId);

  const loaded = await createBoardReader(fx.root).load();
  assert.ok(loaded.ok);
  const plan = planForJob(loaded.state, jobId);
  assert.ok(plan);
  assert.equal(plan.targetVersionId, fx.origin.versionId);
  assert.equal(loaded.state.jobs.filter(job => job.jobId.startsWith("tool-learning_v1_")).length, 1);
  const safe = toolLearningProductionFailures(loaded.state, plan);
  assert.ok(safe.ok);
  assert.equal(safe.failures.length, 2);
  assert.notEqual(toolLearningInputFingerprint(loaded.state, plan), firstFingerprint,
    "a fresh report is in the production slot scope but must wake its original learning question");
  assert.equal(JSON.stringify({ plan, safe }).includes("PRIVATE_"), false);
  assert.deepEqual(loaded.state.activations, []);
  assert.deepEqual(loaded.state.toolUses ?? [], []);
});

test("environment/runtime or legacy failure records never request an implementation repair", async t => {
  const fx = await seedToolProduction(t), input = { ...fx.selection, issuedAt: productionTestTime };
  const record = failedRecord(input.versionId, "baseline_regression"), sidecar = diagnosis(fx.plan, record, true);
  assert.ok(sidecar);
  const claim = await claimToolProductionCheck(input);
  assert.ok(claim.ok);
  assert.ok((await finishToolProductionCheck({ ...input, jobId: claim.jobId, record, outcome: "failed", diagnosis: sidecar })).ok);
  assert.deepEqual(await scheduleToolProductionCheckLearning({ ...input, jobId: claim.jobId }), { kind: "not_requested", reason: "blocked" });
  const second = await claimToolProductionCheck(input);
  assert.ok(second.ok);
  assert.ok((await finishToolProductionCheck({ ...input, jobId: second.jobId, record, outcome: "failed" })).ok);
  assert.deepEqual(await scheduleToolProductionCheckLearning({ ...input, jobId: second.jobId }), { kind: "not_requested", reason: "unclassified" });
  assert.equal((await scheduleToolProductionCheckLearning({ ...input, workspaceId: "foreign-workspace", jobId: claim.jobId })).kind, "unavailable");
  const state = await createBoardReader(fx.root).load();
  assert.ok(state.ok);
  assert.equal(state.state.jobs.filter(job => job.jobId.startsWith("tool-learning_v1_")).length, 0);
});

test("a stronger pure-production failure remains exact and waits before source construction rather than reverting to its training oracle", async t => {
  const fx = await seedToolProduction(t), input = { ...fx.selection, issuedAt: productionTestTime };
  const parent = await readToolEvolutionCandidate(fx.root, fx.origin.versionId);
  assert.ok(parent.ok);
  const claim = await claimToolProductionCheck(input);
  assert.ok(claim.ok);
  const record = failedRecord(input.versionId, "baseline_regression"), sidecar = diagnosis(fx.plan, record);
  assert.ok(sidecar);
  assert.ok((await finishToolProductionCheck({ ...input, jobId: claim.jobId, record, outcome: "failed", diagnosis: sidecar })).ok);
  const scheduled = await scheduleToolProductionCheckLearning({ ...input, jobId: claim.jobId });
  assert.equal(scheduled.kind, "queued");

  if (scheduled.kind !== "queued") return;

  let generated = 0;
  const services: ToolPipelineServices = { executionAuthorized: true,
    allowance: async () => ({ grantId: "TEST-existing-owner", maxCalls: 8, maxTokens: 96000, callsRemaining: 8, tokensRemaining: 96000, maxPromptChars: 50000 }),
    search: async () => { assert.fail("exact implementation investigation needs no automatic web search"); },
    context: async () => ({ availableTools: [], requirements: [] }),
    plan: async context => {
      assert.equal(context.productionFailures?.[0]?.stage, "baseline_regression");
      assert.deepEqual(context.requirements, [], "a checker mismatch cannot become an independent expected-result requirement");
      assert.equal(JSON.stringify(context).includes("PRIVATE_"), false);
      const prior = context.priorVersions[0];
      assert.ok(prior);

      return { action: "improve", rationale: "Investigate generalization of the existing contract", existingInsufficiency: "Independent heldout disagreed",
        expectedBenefit: "A hypothesis to be checked later", constructionCost: "One bounded source proposal", alternatives: ["Defer if the old contract is insufficient"],
        request: { ...parent.artifact.request, operation: "improve", prior: { versionId: prior.versionId }, maxAttempts: 1 },
        sampleOrigins: prior.evidence.map(sample => ({ sampleId: sample.sampleId, kind: "contract", ref: `${prior.versionId}:${sample.sampleId}` })) };
    },
    evolve: async (request, _signal, feedback) => {
      generated++;
      assert.deepEqual(request.evidence, parent.artifact.request.evidence);
      assert.ok(feedback.includes("baseline_regression"));
      assert.ok(feedback.includes("hidden cases remain unavailable"));
      assert.equal(feedback.includes("PRIVATE_"), false);
      return { kind: "failed", code: "TEST_stop_at_generation_boundary", message: "Controlled fixture; no production execution", attempts: 1 };
    } };
  const worked = await workToolLearningPipeline({ boardRoot: fx.root, scope: "test", now: () => Date.parse(productionTestTime),
    mode: "after_turn", signal: new AbortController().signal, services, jobIds: [scheduled.jobId] });

  assert.ok(worked.ok);
  assert.equal(generated, 0);
  assert.equal(worked.results[0]?.code, "pure_production_regression_contract_required");
  const replay = await resumeToolProductionCheckLearning(fx.root, input.workspaceId);
  assert.ok(replay.ok);
  assert.deepEqual(replay.jobIds, [scheduled.jobId]);
  const pipeline = await readToolLearningPipeline(fx.root);
  assert.ok(pipeline.ok);
  assert.equal(pipeline.jobs.length, 1);
  assert.equal(pipeline.jobs[0]?.result?.outcome, "waiting_evidence");
  const blocked = await createBoardReader(fx.root).load();
  assert.ok(blocked.ok);
  const diagnostic = blocked.state.assets.find(asset => typeof asset.content === "object" && asset.content !== null
    && "type" in asset.content && asset.content.type === "tool_pure_production_regression_block");

  assert.ok(diagnostic);
  assert.ok(JSON.stringify(diagnostic.content).includes(input.versionId));
  assert.ok(JSON.stringify(diagnostic.content).includes(contentHashOf(fx.plan.checks)));
  assert.equal(JSON.stringify(diagnostic.content).includes("PRIVATE_"), false);
});
