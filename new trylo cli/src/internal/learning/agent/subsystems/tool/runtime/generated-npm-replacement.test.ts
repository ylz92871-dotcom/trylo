import assert from "node:assert/strict";
import type { BoardState } from "../../../../control/state.js";
import test from "node:test";
import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { npmLearningFixture, npmLearningAdapter, npmLearningTime } from "../testing/npm-learning-fixture.js";
import type { ToolEvolutionArtifact } from "../domain/evolution/artifact.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { resultVersionId } from "../domain/evolution/pipeline.js";
import { toolLearningDecisionVersionId } from "../domain/evolution/decision-identity.js";
import { toolAcquisitionInstalledVersion } from "../domain/evolution/acquisition-identity.js";
import { createToolProductionPlan, toolProductionScope } from "../domain/evolution/production-plan.js";
import { createNpmToolProductionPlan } from "../domain/evolution/npm-production-plan.js";
import { createToolEvolutionArchive } from "./evolution-archive.js";
import { enqueueToolLearningPlan } from "./pipeline-queue.js";
import { savePipelineAsset } from "./pipeline-assets.js";
import { saveToolAcquisitionPlan, recordToolAcquisitionInstalled } from "./acquisition-continuation.js";
import { claimAcquisitionAdaptation, runAcquisitionAdaptation } from "./acquisition-adaptation-jobs.js";
import { productionFromBoard, saveToolProductionPlan } from "./production-assets.js";
import { generatedPredecessorFromBoard } from "./generated-predecessor.js";
import { validNpmProductionLineage } from "./npm-production-lineage.js";
import { hasImmutablePureProductionSourceProof } from "./immutable-production-source.js";
import { exactPureProductionLearningParents } from "./pure-production-regression.js";
import { claimToolProductionCheck, finishToolProductionCheck } from "./production-jobs.js";
import { toolLearningProductionFailures } from "./production-check-reader.js";
import { VALIDATION_STAGE_ORDER, type ValidationRecord } from "../../../../../tooling/contract/types.js";

/** TEST ONLY source/approval ledger shapes; execution below is the real local Node
 * child contract. This does not assert a real provider, registry or OS isolation. */
async function frozenAcquisition(fx: Awaited<ReturnType<typeof npmLearningFixture>>, targetVersionId: string, evidenceRefs: readonly string[] = []) {
  const plan: ToolLearningPlan = { ...fx.plan, targetVersionId, trigger: { ...fx.plan.trigger, proposalKey: `replacement:${targetVersionId}`, evidenceRefs } };
  const enqueued = await enqueueToolLearningPlan(fx.boardRoot, plan);
  assert.ok(enqueued.ok);
  const jobId = enqueued.jobId, root = fx.data.plan.tree.root;
  const decision = { action: "acquire" as const, candidate: { platform: "npm", id: root.name, version: root.version }, adaptation: "Replace the generated implementation with the existing package API",
    rationale: "TEST ONLY", existingInsufficiency: "TEST ONLY generated implementation is incomplete", expectedBenefit: "TEST ONLY hypothesis", constructionCost: "TEST ONLY", alternatives: [] };
  const approvalId = toolLearningDecisionVersionId({ jobId, attempt: 1, step: 1, decision });

  await withBoardWriter(fx.boardRoot, async store => {
    assert.ok((await store.apply({ type: "start_job", jobId, commandId: `${jobId}:test-start`, issuedAt: npmLearningTime })).ok);
    assert.ok((await savePipelineAsset(store, { kind: "workflow", versionId: approvalId, scope: fx.scope, source: "inferred", issuedAt: npmLearningTime,
      content: { type: "tool_learning_decision", schemaVersion: 1, jobId, attempt: 1, step: 1, decision } })).ok);
    assert.ok((await savePipelineAsset(store, { kind: "workflow", versionId: resultVersionId(jobId, 1), scope: fx.scope, source: "inferred", issuedAt: npmLearningTime,
      content: { type: "tool_learning_result", schemaVersion: 1, jobId, attempt: 1, outcome: "waiting_approval", code: "acquisition_approval_required", occurredAt: npmLearningTime,
        decision, decisionVersionId: approvalId, search: { status: "complete", failures: [], candidates: [{ ...decision.candidate,
          licenseSpdx: "MIT", sourceUrl: `https://www.npmjs.com/package/${root.name}` }] } } })).ok);
    assert.ok((await store.apply({ type: "complete_job", jobId, next: "waiting_approval", commandId: `${jobId}:test-finish`, issuedAt: npmLearningTime })).ok);
  });
  assert.ok((await saveToolAcquisitionPlan({ boardRoot: fx.boardRoot, jobId, scope: fx.scope, approvalId, plan: fx.data.plan, issuedAt: npmLearningTime })).ok);
  assert.ok((await recordToolAcquisitionInstalled({ boardRoot: fx.boardRoot, jobId, scope: fx.scope, approvalId, plan: fx.data.plan,
    grantId: "TEST_ONLY_acquisition_receipt_for_already_installed_fixture", issuedAt: npmLearningTime })).ok);

  return { plan, jobId, approvalId };
}

function oldArtifact(fx: Awaited<ReturnType<typeof npmLearningFixture>>): ToolEvolutionArtifact {
  const candidate = { ...fx.candidate("module.exports=input=>input.value;").interface.descriptor, source: "module.exports=input=>input.value;" };
  return { schemaVersion: 1, request: fx.checks, candidate, generatedAt: npmLearningTime,
    verification: { verdict: "pass", candidateHash: contentHashOf(candidate), samplesHash: contentHashOf(fx.checks.evidence),
      checks: fx.checks.evidence.map(sample => ({ sampleId: sample.sampleId, role: sample.role, outcome: "passed", detail: "TEST ONLY historical shape" })) } };
}

test("a generated tool can become an acquired callable npm adapter while retaining its exact task contract and slot", async t => {
  const fx = await npmLearningFixture(t), artifact = oldArtifact(fx);
  const archived = await createToolEvolutionArchive(fx.boardRoot).save(artifact);
  assert.ok(archived.ok);
  const acquisition = await frozenAcquisition(fx, archived.versionId);
  let calls = 0;
  const fresh = [{ sampleId: "current-variation", role: "variation" as const, input: { value: " NEW_CONTRACT_ONLY " }, expected: { kind: "value" as const, value: "new_contract_only" } },
    { sampleId: "current-counterexample", role: "counterexample" as const, input: { value: false }, expected: { kind: "error" as const, code: "invalid_input" } }];
  const result = await runAcquisitionAdaptation({ ...fx, ...acquisition, workspaceId: "workspace-test", services: async () => ({
    allowance: async () => ({ grantId: "TEST ONLY controlled calls", maxCalls: 2, maxTokens: 32000, callsRemaining: 2 - calls, tokensRemaining: 32000, maxPromptChars: 24000 }),
    complete: async (prompt, _signal, phase) => { calls++;
      if (phase === "contract") return { checks: { ...fx.checks, evidence: [...fx.checks.evidence, ...fresh] }, origins: [
        ...fx.checks.evidence.map(sample => ({ sampleId: sample.sampleId, kind: "contract", ref: `${archived.versionId}:${sample.sampleId}` })),
        ...fresh.map(sample => ({ sampleId: sample.sampleId, kind: "synthesized", ref: `contract:${archived.versionId}` }))] };
      assert.ok(!prompt.includes("HELD_OUT_SENTINEL"));
    assert.ok(prompt.includes('"identity":"normalize"'));
      assert.ok(!prompt.includes("NEW_CONTRACT_ONLY") && !prompt.includes("new_contract_only"));
      return fx.candidate(npmLearningAdapter); }, execute: fx.execute, release: async () => {},
  }) });

  assert.ok(result.ok && "versionId" in result, JSON.stringify(result));
  assert.equal(calls, 2);
  const loaded = await createBoardReader(fx.boardRoot).load();
  assert.ok(loaded.ok);
  const selected = productionFromBoard(loaded.state, result.versionId, "workspace-test");
  assert.ok(selected.ok);
  assert.equal(selected.plan.type, "npm_tool_production_package");
  assert.equal(loaded.state.activations.length, 0);

  if (selected.plan.type !== "npm_tool_production_package") return;

  assert.deepEqual(selected.plan.checks.evidence, [...fx.checks.evidence, ...fresh]);
  assert.equal(selected.plan.evolution?.parentVersionId, archived.versionId);
  assert.deepEqual(await fx.execute(selected.plan, { value: " A LATER TASK " }, fx.signal), { kind: "value", value: "a later task" });
  const receiptId = toolAcquisitionInstalledVersion(acquisition.approvalId, selected.plan.origin.versionId);

  assert.equal(validNpmProductionLineage({ ...loaded.state, assets: loaded.state.assets.filter(row => row.versionId !== receiptId) }, selected.plan), false);
  assert.equal(validNpmProductionLineage(loaded.state, { ...selected.plan, candidate: { ...selected.plan.candidate, identity: "another-tool-slot" } }), false);
});

test("a pure production predecessor retains its stronger fresh checks instead of collapsing to its training candidate", async t => {
  const fx = await npmLearningFixture(t), artifact = oldArtifact(fx), archived = await createToolEvolutionArchive(fx.boardRoot).save(artifact);
  assert.ok(archived.ok);
  const checks = { ...fx.checks, requestId: "TEST_ONLY_fresh_production_checks", evidence: fx.checks.evidence.map(sample => sample.role === "variation"
    ? { ...sample, input: { value: " FRESH_PRODUCTION_ONLY " }, expected: { kind: "value" as const, value: "fresh_production_only" } }
    : sample.role === "counterexample" ? { ...sample, input: [] } : sample) };
  const planned = createToolProductionPlan({ workspaceId: "workspace-test", originVersionId: archived.versionId, artifact, checks, license: "MIT" });
  assert.ok(planned.ok);
  const saved = await saveToolProductionPlan(fx.boardRoot, planned.plan, npmLearningTime);
  assert.ok(saved.ok);
  const loaded = await createBoardReader(fx.boardRoot).load();
  assert.ok(loaded.ok);
  const predecessor = generatedPredecessorFromBoard(loaded.state, saved.versionId, "workspace-test");
  assert.ok(predecessor);
  assert.equal(predecessor.versionId, saved.versionId);
  assert.deepEqual(predecessor.checks, checks);
  assert.equal(generatedPredecessorFromBoard(loaded.state, saved.versionId, "foreign-workspace"), undefined);
  assert.equal(generatedPredecessorFromBoard({ ...loaded.state, assets: loaded.state.assets.filter(row => row.versionId !== archived.versionId) }, saved.versionId, "workspace-test"), undefined);
});

test("acquisition recovers the exact production contract from bound use even when the learning target is its training artifact", async t => {
  const fx = await npmLearningFixture(t), artifact = oldArtifact(fx);
  const archived = await createToolEvolutionArchive(fx.boardRoot).save(artifact);
  assert.ok(archived.ok);
  const checks = { ...fx.checks, requestId: "TEST_ONLY_exact_production_contract", evidence: fx.checks.evidence.map(sample => sample.role === "variation"
    ? { ...sample, input: { value: " PRODUCTION_CONTRACT_ONLY " }, expected: { kind: "value" as const, value: "production_contract_only" } }
    : sample.role === "counterexample" ? { ...sample, input: false } : sample) };
  const produced = createToolProductionPlan({ workspaceId: "workspace-test", originVersionId: archived.versionId, artifact, checks, license: "MIT" });
  assert.ok(produced.ok);
  const saved = await saveToolProductionPlan(fx.boardRoot, produced.plan, npmLearningTime);
  assert.ok(saved.ok);
  // TEST ONLY host-use fact exercises the exact source reader/continuation.
  // It is not a claim that this old fixture tool was natively executed.
  const useId = "TEST_ONLY_exact_production_use";

  await withBoardWriter(fx.boardRoot, async store => { assert.ok((await store.apply({ type: "record_tool_use", commandId: useId, issuedAt: npmLearningTime,
    record: { schemaVersion: 1, useId, versionId: saved.versionId, scope: toolProductionScope(produced.plan), sessionId: "TEST_ONLY_source_session",
      toolCallId: "TEST_ONLY_source_call", workspaceId: "workspace-test", contentHash: contentHashOf(produced.plan), inputHash: contentHashOf({ value: "example" }),
      outputHash: contentHashOf("example"), execution: "returned", quality: "unverified", occurredAt: npmLearningTime } })).ok); });
  const acquisition = await frozenAcquisition(fx, archived.versionId, [useId]);
  const claimed = await claimAcquisitionAdaptation({ ...acquisition, boardRoot: fx.boardRoot, scope: fx.scope, workspaceId: "workspace-test", now: fx.now });

  assert.ok(claimed.ok && !claimed.completed, JSON.stringify(claimed));
  assert.equal(claimed.request.learningPlan.targetVersionId, archived.versionId, "the immutable task/funding identity is retained");
  assert.equal(claimed.predecessor?.versionId, saved.versionId);
  assert.deepEqual(claimed.predecessor?.checks, checks, "the host carries the stronger production contract into npm construction");
  const { source: _source, ...descriptor } = artifact.candidate;
  const replacement = createNpmToolProductionPlan({ workspaceId: "workspace-test", installation: fx.data.plan, descriptor,
    runtime: { profile: "confined_npm_library_v1", source: npmLearningAdapter }, checks,
    evolution: { parentVersionId: saved.versionId, parentContentHash: contentHashOf(produced.plan), requestId: `${claimed.continuationJobId}:1`,
      adaptation: "TEST ONLY replace with the reviewed API", acquisition: { jobId: acquisition.jobId, decisionVersionId: acquisition.approvalId } } });
  assert.ok(replacement);
  const state = await createBoardReader(fx.boardRoot).load();
  assert.ok(state.ok);
  assert.equal(validNpmProductionLineage(state.state, replacement), true, "the stronger parent is tied to the actual original source, rather than a latest alias");
  assert.equal(validNpmProductionLineage({ ...state.state, toolUses: [] }, replacement), false, "the host source binding cannot be removed");
  const committed = await saveToolProductionPlan(fx.boardRoot, replacement, npmLearningTime, claimed.admission);
  assert.ok(committed.ok);
  const checkSelection = { boardRoot: fx.boardRoot, versionId: committed.versionId, workspaceId: "workspace-test", issuedAt: npmLearningTime };
  const check = await claimToolProductionCheck(checkSelection);
  assert.ok(check.ok);
  const stages = VALIDATION_STAGE_ORDER.map(stage => ({ stage, passed: false, detail: "TEST ONLY unexecuted cancellation; no native or checker verdict" }));
  const cancelledRecord: ValidationRecord = { validationId: `validation:${committed.versionId}:${contentHashOf(stages)}`,
    packageVersionId: committed.versionId, actor: "verifier", verdict: "fail", stages };

  assert.ok((await finishToolProductionCheck({ ...checkSelection, jobId: check.jobId, record: cancelledRecord, outcome: "cancelled" })).ok);
  const persisted = await createBoardReader(fx.boardRoot).load();
  assert.ok(persisted.ok);
  assert.doesNotThrow(() => productionFromBoard(persisted.state, committed.versionId, "workspace-test"),
    "a descendant's own check report must not recursively enter its immutable parent proof");
  const parentFailures = toolLearningProductionFailures(persisted.state, acquisition.plan);
  assert.ok(parentFailures.ok);
  assert.deepEqual(parentFailures.failures, [], "a descendant's report cannot become a failure of its pure source parent");
  const descendantReport = persisted.state.assets.find(asset => typeof asset.content === "object" && asset.content !== null
    && "type" in asset.content && asset.content.type === "tool_production_check_report" && "versionId" in asset.content && asset.content.versionId === committed.versionId);

  assert.ok(descendantReport);
  const mismatched = toolLearningProductionFailures(persisted.state, { ...acquisition.plan,
    trigger: { ...acquisition.plan.trigger, evidenceRefs: [...acquisition.plan.trigger.evidenceRefs, descendantReport.versionId] } });

  assert.ok(!mismatched.ok);
  assert.equal(mismatched.code, "production_failure_parent_mismatch");
  const originalProposal = persisted.state.assets.find(asset => asset.versionId === saved.versionId)?.createdFromProposalId;
  assert.ok(originalProposal);

  for (const lifecycle of ["retired", "rejected"] as const) {
    const historical: BoardState = { ...persisted.state, proposals: persisted.state.proposals.map(proposal => proposal.proposalId === originalProposal ? { ...proposal, lifecycle } : proposal) };
    assert.equal(hasImmutablePureProductionSourceProof(historical, acquisition.plan, saved.versionId, "workspace-test"), true);
    assert.equal(validNpmProductionLineage(historical, replacement), true, "historical source availability cannot erase a committed child's contract lineage");
    assert.ok(productionFromBoard(historical, committed.versionId, "workspace-test").ok);
    assert.equal(exactPureProductionLearningParents(historical, acquisition.plan).ok, false, "a new claim or source repair still observes the original availability boundary");
  }

  for (const [entityId, entityType] of [[saved.versionId, "asset"], [originalProposal, "proposal"]] as const) {
    const historical: BoardState = { ...persisted.state, tombstones: [...persisted.state.tombstones,
      { entityId, entityType, boardSequence: persisted.state.sequence, reason: "TEST ONLY historical source availability" }] };
    const before: string = JSON.stringify(historical);

    assert.ok(productionFromBoard(historical, committed.versionId, "workspace-test").ok, "only source history, never old execution authority, survives this tombstone");
    assert.equal(JSON.stringify(historical), before, "the availability-only history view must not mutate Board state");
    assert.equal(exactPureProductionLearningParents(historical, acquisition.plan).ok, false);
    assert.equal(hasImmutablePureProductionSourceProof({ ...historical, toolUses: [] }, acquisition.plan, saved.versionId, "workspace-test"), false);
    const forgedStates: readonly BoardState[] = [
      { ...historical, toolUses: historical.toolUses?.map(use => use.useId === useId ? { ...use, contentHash: "0".repeat(64) } : use) ?? [] },
      { ...historical, toolUses: historical.toolUses?.map(use => use.useId === useId ? { ...use, workspaceId: "foreign-workspace" } : use) ?? [] },
      { ...historical, assets: historical.assets.map(asset => asset.versionId === saved.versionId ? { ...asset, contentHash: "0".repeat(64) } : asset) },
    ];

    for (const forged of forgedStates) assert.equal(hasImmutablePureProductionSourceProof(forged, acquisition.plan, saved.versionId, "workspace-test"), false);
  }

  for (const lifecycle of ["retired", "rejected"] as const) {
    const historical: BoardState = { ...persisted.state, proposals: persisted.state.proposals.map(proposal => proposal.proposalId === archived.proposalId ? { ...proposal, lifecycle } : proposal) };
    assert.ok(productionFromBoard(historical, committed.versionId, "workspace-test").ok, "the canonical C1 source proposal is historical as well as P1");
    assert.equal(exactPureProductionLearningParents(historical, acquisition.plan).ok, false);
  }

  const sourceRemoved: BoardState = { ...persisted.state, tombstones: [...persisted.state.tombstones,
    { entityId: archived.versionId, entityType: "asset" as const, boardSequence: persisted.state.sequence, reason: "TEST ONLY C1 history availability" },
    { entityId: archived.proposalId, entityType: "proposal" as const, boardSequence: persisted.state.sequence, reason: "TEST ONLY C1 history availability" }] };

  assert.ok(productionFromBoard(sourceRemoved, committed.versionId, "workspace-test").ok);
  assert.equal(hasImmutablePureProductionSourceProof({ ...sourceRemoved, assets: sourceRemoved.assets.map(asset => asset.versionId === archived.versionId
    ? { ...asset, contentHash: "0".repeat(64) } : asset) }, acquisition.plan, saved.versionId, "workspace-test"), false);
});
