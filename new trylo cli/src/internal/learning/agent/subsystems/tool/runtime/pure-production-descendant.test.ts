import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { createFilePermissionStore } from "../../../../../adapters/permission-store/file-ledger.js";
import { issueAgentMethodReceipt } from "../../../../../integration/testing/authority-fixtures.js";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { seedToolProduction, productionTestTime } from "../testing/production-fixtures.js";
import { readToolEvolutionCandidate } from "./evolution-reader.js";
import { createToolEvolutionArchive } from "./evolution-archive.js";
import { enqueueToolLearningPlan, readToolLearningPipeline, registerToolLearningRecipe } from "./pipeline-queue.js";
import { workToolLearningPipeline } from "./pipeline-worker.js";
import { createToolProductionPlan } from "../domain/evolution/production-plan.js";
import { productionFromBoard, saveToolProductionPlan } from "./production-assets.js";
import { toolProductionScope } from "../domain/evolution/production-plan.js";
import { proposeToolContractRevision, reviewToolContractRevision, approveToolContractRevision } from "./contract-revisions.js";
import { createToolLearningFunding } from "./learning-funding.js";
import { admitToolProductionVerification } from "./production-evidence.js";
import { reviewToolProductionActivation, activateToolProduction } from "./production-activation.js";
import { openWorkspaceProductionTools } from "./production-use.js";
import { pureProductionPlanningParents } from "./pure-production-planning.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import type { ToolEvolutionRequest } from "../domain/evolution/contracts.js";
import { decisionBindingFailure } from "./learning-context.js";
import type { ToolEvolutionExpected } from "../domain/evolution/contracts.js";

function executeSource(source: string, input: unknown): ToolEvolutionExpected {
  try { return { kind: "value", value: runInNewContext(`${source}\nmodule.exports(input)`, { module: { exports: undefined }, input }, { timeout: 100 }) }; }
  catch (error) { return { kind: "error", code: typeof error === "object" && error !== null && "code" in error ? String(error.code) : "execution_error" }; }
}

test("host retains stronger hidden production checks through a pure repair and rejects a weaker manual production plan", async t => {
  // TEST ONLY verifier fixture; proves preservation/admission, not native execution or model quality.
  const fx = await seedToolProduction(t), origin = await readToolEvolutionCandidate(fx.root, fx.origin.versionId);
  assert.ok(origin.ok);
  const request = { ...origin.artifact.request, operation: "improve" as const,
    prior: { versionId: fx.origin.versionId, source: origin.artifact.candidate.source } };

  assert.ok((await registerToolLearningRecipe(fx.root, { type: "tool_learning_recipe", schemaVersion: 1, automation: "after_turn", request }, productionTestTime)).ok);
  const queued = await enqueueToolLearningPlan(fx.root, { type: "tool_learning_plan", schemaVersion: 1, scope: request.scope,
    capability: request.capability, targetVersionId: fx.origin.versionId, createdAt: productionTestTime,
    trigger: { runId: "repair-task", proposalKey: "repair-stronger-production", action: "user_requested", tool: "double", evidenceRefs: [fx.selection.versionId] } });
  assert.ok(queued.ok);
  let calls = 0;
  const worked = await workToolLearningPipeline({ boardRoot: fx.root, scope: request.scope, mode: "after_turn", signal: new AbortController().signal,
    jobIds: [queued.jobId], now: () => Date.parse(productionTestTime), services: { executionAuthorized: true, productionRegression: "preserve",
      search: async () => ({ status: "complete", candidates: [], failures: [] }),
      evolve: async (actual, _signal, _feedback, admission) => {
        calls++;
        assert.deepEqual(actual.evidence, request.evidence, "hidden production checks must stay outside generation");
        assert.equal(JSON.stringify(actual).includes('"input":11'), false);
        const artifact = { ...origin.artifact, request: actual, candidate: { ...origin.artifact.candidate, source: "module.exports = input => 2 * input;" },
          verification: { ...origin.artifact.verification, candidateHash: contentHashOf({ ...origin.artifact.candidate, source: "module.exports = input => 2 * input;" }), samplesHash: contentHashOf(actual.evidence) } };
        const saved = await createToolEvolutionArchive(fx.root, { jobAdmission: admission }).save(artifact);
        assert.ok(saved.ok);
        return { kind: "candidate", ...saved, artifact, attempts: 1 };
      } } });

  assert.ok(worked.ok);
  assert.equal(worked.results[0]?.code, "production_candidate_pending_review");
  assert.equal(calls, 1);
  const queue = await readToolLearningPipeline(fx.root);
  assert.ok(queue.ok);
  const result = queue.jobs.find(row => row.jobId === queued.jobId)?.result;
  assert.ok(result?.candidateVersionId);
  const board = await createBoardReader(fx.root).load();
  assert.ok(board.ok);
  const production = productionFromBoard(board.state, result.candidateVersionId, fx.plan.workspaceId);
  assert.ok(production.ok);
  assert.deepEqual(production.plan.checks, fx.plan.checks);
  assert.equal(production.lifecycle, "evaluating");
  assert.equal(board.state.activations.some(row => row.versionId === result.candidateVersionId), false, "preparing regression does not activate");
  const child = await readToolEvolutionCandidate(fx.root, production.plan.origin.versionId);
  assert.ok(child.ok);
  const weaker = createToolProductionPlan({ artifact: child.artifact, originVersionId: child.versionId, workspaceId: fx.plan.workspaceId, license: "MIT",
    checks: { ...fx.plan.checks, requestId: "weaker-manual-contract", evidence: fx.plan.checks.evidence.map(sample => sample.sampleId === "v" ? { ...sample, input: 12, expected: { kind: "value" as const, value: 24 } } : sample) } });
  assert.ok(weaker.ok);
  const rejected = await saveToolProductionPlan(fx.root, weaker.plan, productionTestTime);
  assert.equal(rejected.ok, false);

  if (!rejected.ok) assert.equal(rejected.code, "invalid_production_origin");
});

test("exact approved production corrections unblock the original repair, retain hidden checks and govern the next mounted use", async t => {
  // Actual Board/Permission/lineage/mount paths, controlled source and receipt.
  // This is a hermetic contract test, not native checker or provider acceptance.
  const fx = await seedToolProduction(t), origin = await readToolEvolutionCandidate(fx.root, fx.origin.versionId);
  assert.ok(origin.ok);
  const permission = createFilePermissionStore({ path: path.join(fx.root, "correction-permission.ndjson") });
  const approve = async (parentVersionId: string, samples: typeof origin.artifact.request.evidence) => {
    const sample = samples.find(row => row.sampleId === "s1")!;
    const proposed = await proposeToolContractRevision(fx.root, { type: "tool_contract_revision_proposal", schemaVersion: 1, parentVersionId,
      scope: "test", parentContractHash: contentHashOf(samples), reason: "incorrect_expectation", corrections: [{ sampleId: sample.sampleId,
        oldSampleHash: contentHashOf(sample), oldExpectedHash: contentHashOf(sample.expected), expected: { kind: "value", value: 5 }, evidenceRefs: ["user:correct-source-case"] }] }, productionTestTime);

    assert.ok(proposed.ok);
    const review = await reviewToolContractRevision(fx.root, proposed.proposalId, "test");
    assert.ok(review.ok);
    const grant = await permission.issue({ action: "modify", candidateId: review.reviewId, packageVersionId: parentVersionId, scope: "test",
      issuedAt: productionTestTime, expiry: "2026-10-31T00:01:00.000Z" });
    assert.ok(grant.ok);
    const approved = await approveToolContractRevision({ boardRoot: fx.root, proposalId: proposed.proposalId, scope: "test", reviewId: review.reviewId,
      permission, token: { grantId: grant.grant.grantId }, issuedAt: productionTestTime });
    assert.ok(approved.ok);
    return approved.revisionId;
  };
  const trainingRevision = await approve(origin.versionId, origin.artifact.request.evidence);
  const request = { ...origin.artifact.request, operation: "improve" as const, prior: { versionId: origin.versionId, source: origin.artifact.candidate.source },
    contractRevisionRefs: [trainingRevision], evidence: origin.artifact.request.evidence.map(sample => sample.sampleId === "s1"
      ? { ...sample, expected: { kind: "value" as const, value: 5 } } : sample) };

  assert.ok((await registerToolLearningRecipe(fx.root, { type: "tool_learning_recipe", schemaVersion: 1, automation: "after_turn", request }, productionTestTime)).ok);
  const plan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope: "test", capability: "double", targetVersionId: origin.versionId,
    createdAt: productionTestTime, trigger: { runId: "production-correction", proposalKey: "production-correction", action: "user_requested",
      evidenceRefs: [fx.selection.versionId, "user:correct-source-case"] } };
  const queued = await enqueueToolLearningPlan(fx.root, plan);
  assert.ok(queued.ok);
  const funding = createToolLearningFunding({ boardRoot: fx.root, scope: "test", centralScope: "D:\\workspace\\pure-correction", now: () => Date.parse(productionTestTime) });
  let sourceCalls = 0;
  const input = { boardRoot: fx.root, scope: "test", mode: "after_turn" as const, signal: new AbortController().signal,
    jobIds: [queued.jobId], now: () => Date.parse(productionTestTime), services: { executionAuthorized: true, productionRegression: "preserve" as const,
      allowance: (plan: ToolLearningPlan) => funding.allowance(plan), releaseAllowance: () => funding.release(),
      search: async () => ({ status: "complete" as const, candidates: [], failures: [] }),
      evolve: async (actual: ToolEvolutionRequest, _signal: AbortSignal, _feedback: string | undefined, admission: { jobId: string; attempt: number }) => {
        sourceCalls++;
        assert.equal(actual.evidence.some(sample => sample.input === 11), false);
        const candidate = { ...origin.artifact.candidate, source: "module.exports = input => { if (typeof input !== 'number') throw Object.assign(new Error('numeric'), {code:'invalid_input'}); return input === 2 ? 5 : 2 * input; };" };
        const checks = actual.evidence.map(sample => {
          assert.deepEqual(executeSource(candidate.source, sample.input), sample.expected);
          return { sampleId: sample.sampleId, role: sample.role, outcome: "passed" as const, detail: "Actual hermetic VM result; no native-isolation claim" };
        });
        const artifact = { ...origin.artifact, request: actual, candidate, verification: { verdict: "pass" as const, checks,
          candidateHash: contentHashOf(candidate), samplesHash: contentHashOf(actual.evidence) } };
        const saved = await createToolEvolutionArchive(fx.root, { jobAdmission: admission }).save(artifact);
        assert.ok(saved.ok);

        return { kind: "candidate" as const, ...saved, artifact, attempts: 1 };
      } } };
  const blocked = await workToolLearningPipeline(input);
  assert.ok(blocked.ok);
  assert.equal(blocked.results[0]?.code, "pure_production_contract_revision_required");
  assert.equal(sourceCalls, 0);
  const productionRevision = await approve(fx.selection.versionId, fx.plan.checks.evidence);
  const before = await createBoardReader(fx.root).load();
  assert.ok(before.ok);
  const context = pureProductionPlanningParents(before.state, plan);
  assert.ok(context.ok);
  assert.equal(context.parents[0]?.versionId, fx.selection.versionId);
  assert.equal(JSON.stringify(context).includes('"input":11'), false);
  assert.equal(JSON.stringify(context).includes('"input":"invalid"'), false);
  assert.ok(context.parents[0]?.approvedSourceCorrections.some(row => row.revisionId === productionRevision && row.expected.kind === "value" && row.expected.value === 5));
  assert.equal(decisionBindingFailure({ action: "revise_contract", rationale: "TEST", existingInsufficiency: "TEST", expectedBenefit: "TEST", constructionCost: "TEST", alternatives: [],
    proposal: { type: "tool_contract_revision_proposal", schemaVersion: 1, parentVersionId: fx.selection.versionId, scope: "test", reason: "incorrect_expectation",
      parentContractHash: context.parents[0]!.parentContractHash, corrections: [{ sampleId: "s1", oldSampleHash: contentHashOf(fx.plan.checks.evidence[0]),
        oldExpectedHash: contentHashOf(fx.plan.checks.evidence[0]!.expected), expected: { kind: "value", value: 5 }, evidenceRefs: ["user:correct-source-case"] }] } },
    { plan, allowance: { grantId: "TEST", maxCalls: 8, callsRemaining: 8, maxTokens: 96000, tokensRemaining: 96000, maxPromptChars: 24000 }, search: { status: "complete", candidates: [], failures: [] }, availableTools: [], priorVersions: [], groundedSamples: [],
      requirements: [{ ref: "user:correct-source-case", kind: "user_requirement", text: "Correct this exact source case" }], pureProductionParents: context.parents }), undefined);
  const worked = await workToolLearningPipeline(input);
  assert.ok(worked.ok);
  assert.equal(worked.results[0]?.code, "production_candidate_pending_review");
  assert.equal(sourceCalls, 1);
  const queue = await readToolLearningPipeline(fx.root);
  assert.ok(queue.ok);
  const versionId = queue.jobs.find(row => row.jobId === queued.jobId)?.result?.candidateVersionId;
  assert.ok(versionId);
  const loaded = await createBoardReader(fx.root).load();
  assert.ok(loaded.ok);
  assert.equal(loaded.state.centralLearningGrants!.length, 1);
  const selected = productionFromBoard(loaded.state, versionId, fx.plan.workspaceId);
  assert.ok(selected.ok);
  assert.deepEqual(selected.plan.checks.evidence.filter(sample => sample.role !== "source"), fx.plan.checks.evidence.filter(sample => sample.role !== "source"));
  assert.deepEqual(selected.plan.checks.evidence[0]?.expected, { kind: "value", value: 5 });
  assert.ok("source" in selected.plan.candidate);

  for (const sample of selected.plan.checks.evidence) assert.deepEqual(executeSource(selected.plan.candidate.source, sample.input), sample.expected);

  const receipt = await issueAgentMethodReceipt(fx.harness, { ...fx.record, packageVersionId: versionId }, { scope: toolProductionScope(selected.plan),
    generatorId: "tool-evolution", verifierId: "tool-production-checker-v1" });
  const selection = { ...fx.selection, versionId };

  assert.ok((await admitToolProductionVerification({ ...selection, receiptId: receipt.receiptId, issuedAt: productionTestTime })).ok);
  const review = await reviewToolProductionActivation(selection);
  assert.ok(review.ok);
  const grant = await permission.issue({ action: "activate", candidateId: review.reviewId, packageVersionId: versionId, scope: toolProductionScope(selected.plan),
    issuedAt: productionTestTime, expiry: "2026-10-31T00:01:00.000Z" });
  assert.ok(grant.ok);
  assert.ok((await activateToolProduction({ ...selection, reviewId: review.reviewId, permission, token: { grantId: grant.grant.grantId }, issuedAt: productionTestTime })).ok);
  const mount = await openWorkspaceProductionTools({ ...selection, sessionId: "next-normal-task", now: () => Date.parse(productionTestTime), newId: () => "corrected-production-use", warn: message => assert.fail(message),
    executor: { execute: async (candidate: typeof origin.artifact.candidate, input: unknown) => ({ kind: "value" as const,
      value: runInNewContext(`${candidate.source}\nmodule.exports(input)`, { module: { exports: undefined }, input }, { timeout: 100 }) }) } });
  assert.ok(mount.ok);
  t.after(mount.close);
  const binding = mount.tools.snapshot()[0]!;
  assert.equal(binding.versionId, versionId);
  const result = await mount.tools.execute({ toolCallId: "corrected-call", name: binding.name, arguments: { input: 2 } }, new AbortController().signal);

  assert.equal(result.outcome, "result");
  if (result.outcome === "result") assert.equal(result.value.result, 5);

  const revoked = { ...loaded.state, assets: loaded.state.assets.filter(row => row.versionId !== productionRevision) };

  assert.equal(productionFromBoard(revoked, versionId, fx.plan.workspaceId).ok, false, "removing the real approval invalidates descendant lineage");
});
