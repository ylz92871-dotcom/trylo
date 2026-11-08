import assert from "node:assert/strict";
import test from "node:test";
import { contentHashOf } from "../../../../control/hash.js";
import { emptyBoardState, type BoardState } from "../../../../control/state.js";
import type { LearningAssetVersion, LearningProposal } from "../../../../control/contracts.js";
import type { NpmInstallPlan } from "../../../../../tooling/contract/npm-install.js";
import { npmInstallId } from "../../../../../tooling/contract/npm-install.js";
import { npmTreeTestData } from "../adapters/acquisition/npm-install-test-support.js";
import { createNpmToolProductionPlan, NPM_CLI_INPUT_SCHEMA, type NpmToolProductionPlan } from "../domain/evolution/npm-production-plan.js";
import type { ToolEvolutionRequest } from "../domain/evolution/contracts.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { planVersionId, resultVersionId, toolLearningJobId } from "../domain/evolution/pipeline.js";
import type { ToolLearningDecision } from "../domain/evolution/learning-plan.js";
import { toolLearningDecisionVersionId } from "../domain/evolution/decision-identity.js";
import { toolAcquisitionInstalledVersion, toolAcquisitionPlanVersion } from "../domain/evolution/acquisition-identity.js";
import { toolProductionScope, toolProductionVersion } from "../domain/evolution/production-plan.js";
import { validNpmProductionLineage } from "./npm-production-lineage.js";
import { contractRevisionReviewId, decodeApprovedToolContractRevision, toolContractProposalId, toolContractRevisionId,
  type ToolContractRevisionProposal } from "../domain/evolution/contract-revision.js";

const AT = "2026-11-04T00:00:00.000Z";

/** TEST ONLY Board shapes; this suite never claims archive, acquisition or execution acceptance. */
function addAsset(state: BoardState, versionId: string, content: unknown, scope: string, kind: LearningAssetVersion["kind"] = "workflow",
  source: LearningAssetVersion["source"] = "inferred", lifecycle: LearningProposal["lifecycle"] = "evaluating"): BoardState {
  const proposalId = `test:${versionId}`;
  return { ...state, assets: [...state.assets, { versionId, content, contentHash: contentHashOf(content), scope, kind, source,
    schemaVersion: 1, createdAt: AT, createdFromProposalId: proposalId }], proposals: [...state.proposals, {
    proposalId, domain: "tool", scope, assetKind: kind, candidateRef: versionId, hypothesis: "TEST ONLY lineage",
    observationRefs: [], risk: "low", requiredVerifiers: [], requestedAuthorities: [], source, lifecycle,
  }] };
}

function parentPlan(): NpmToolProductionPlan {
  const data = npmTreeTestData();
  const checks: ToolEvolutionRequest = { schemaVersion: 1, requestId: "test-contract", scope: data.plan.tree.scope, capability: "test CLI", operation: "create", evidence: [
    { sampleId: "a", role: "source", input: { value: 1 }, expected: { kind: "value", value: 1 } },
    { sampleId: "b", role: "source", input: { value: 2 }, expected: { kind: "value", value: 2 } },
    { sampleId: "v", role: "variation", input: { value: 3 }, expected: { kind: "value", value: 3 } },
    { sampleId: "c", role: "counterexample", input: { value: null }, expected: { kind: "error", code: "bad" } },
  ] };
  const plan = createNpmToolProductionPlan({ workspaceId: "test-workspace", installation: data.plan, checks,
    descriptor: { identity: "stable-trylo-identity", description: "TEST ONLY", inputSchema: NPM_CLI_INPUT_SCHEMA,
      mastery: { whenToUse: ["TEST ONLY · inspect the recorded CLI interface"], preconditions: [], pitfalls: [] } }, runtime: { profile: "confined_npm_cli_v1", bin: "test-cli", entrypoint: "cli.cjs" } });

  assert.ok(plan);
  return plan;
}

function newInstallation(prior: NpmInstallPlan, name: string): NpmInstallPlan {
  const old = prior.tree.root.location, location = `node_modules/${name}`, version = "2.0.0";
  return { ...prior, lock: { ...prior.lock, testOnlyDifferentArtifact: name }, tree: { ...prior.tree,
    root: { name, version, location }, packages: prior.tree.packages.map(pkg => pkg.location === old
      ? { ...pkg, location, name, version, archiveUrl: `https://registry.npmjs.org/${name}/-/${name}-2.0.0.tgz` } : pkg) },
  packages: prior.packages.map(pkg => pkg.location === old ? { location, review: { ...pkg.review, name, version } } : pkg) };
}

function fixture(name = "test-cli", step?: number) {
  const parent = parentPlan(), parentVersionId = toolProductionVersion(parent), scope = parent.origin.scope;
  let state = addAsset(emptyBoardState(), parentVersionId, parent, toolProductionScope(parent), "tool_package", "user_explicit", "suspended");
  const installation = newInstallation(parent.installation, name), installationId = npmInstallId(installation);
  const learningPlan: ToolLearningPlan = { type: "tool_learning_plan", schemaVersion: 1, scope, capability: parent.origin.capability,
    createdAt: AT, targetVersionId: parentVersionId, trigger: { runId: "test-upstream", proposalKey: "test-change", evidenceRefs: [], action: "user_requested" } };
  const jobId = toolLearningJobId(learningPlan), decision: ToolLearningDecision = { action: "acquire", candidate: { platform: "npm", id: name, version: "2.0.0" },
    adaptation: "TEST ONLY upgrade or replace upstream", rationale: "TEST ONLY", existingInsufficiency: "TEST ONLY", expectedBenefit: "TEST ONLY",
    constructionCost: "TEST ONLY", alternatives: ["keep old"] };
  const decisionVersionId = toolLearningDecisionVersionId({ jobId, attempt: 1, decision, ...(step === undefined ? {} : { step }) });

  state = { ...state, jobs: [{ jobId, domain: "tool", scope, state: "waiting_approval", observationId: "test-change", maxAttempts: 3,
    attempt: 1, dedupeKey: "test-change", breakerOpen: false }] };
  state = addAsset(state, planVersionId(jobId), learningPlan, scope);
  state = addAsset(state, decisionVersionId, { type: "tool_learning_decision", schemaVersion: 1, jobId, attempt: 1, decision,
    ...(step === undefined ? {} : { step }) }, scope);
  state = addAsset(state, resultVersionId(jobId, 1), { type: "tool_learning_result", schemaVersion: 1, jobId, attempt: 1,
    outcome: "waiting_approval", code: "acquisition_approval_required", occurredAt: AT, decision, decisionVersionId,
    search: { status: "complete", candidates: [{ platform: "npm", id: name, version: "2.0.0", licenseSpdx: "MIT",
      sourceUrl: `https://www.npmjs.com/package/${name}` }], failures: [] } }, scope);
  state = addAsset(state, toolAcquisitionPlanVersion(decisionVersionId), { type: "tool_acquisition_plan", schemaVersion: 1,
    jobId, decisionVersionId, plan: installation }, scope, "workflow", "user_explicit");
  const receiptId = toolAcquisitionInstalledVersion(decisionVersionId, installationId);

  state = addAsset(state, receiptId, { type: "tool_acquisition_installed", schemaVersion: 1, jobId, scope, decisionVersionId,
    installationId, grantId: "test-consumed-grant", next: "adapt_and_prepare_production", occurredAt: AT }, scope, "workflow", "user_explicit");
  const evolution = { parentVersionId, parentContentHash: contentHashOf(parent), requestId: jobId, adaptation: decision.adaptation,
    acquisition: { jobId, decisionVersionId } };
  const next = createNpmToolProductionPlan({ workspaceId: parent.workspaceId, installation, descriptor: parent.candidate,
    runtime: parent.runtime, checks: parent.checks, evolution });
  assert.ok(next);

  return { state, parent, next, evolution, jobId, scope, receiptId, parentVersionId };
}

test("new upstream versions and replacement packages require the exact selected acquisition evidence", () => {
  for (const name of ["test-cli", "replacement-cli"]) for (const step of [undefined, 2]) {
    const fx = fixture(name, step);
    assert.ok(validNpmProductionLineage(fx.state, fx.next), `${name} step ${step}`);
    const { acquisition: _acquisition, ...unbound } = fx.evolution;

    assert.equal(validNpmProductionLineage(fx.state, { ...fx.next, evolution: unbound }), false);

    for (const removed of [fx.receiptId, toolAcquisitionPlanVersion(fx.evolution.acquisition.decisionVersionId),
      fx.evolution.acquisition.decisionVersionId, planVersionId(fx.jobId), resultVersionId(fx.jobId, 1)]) {
      assert.equal(validNpmProductionLineage({ ...fx.state, assets: fx.state.assets.filter(asset => asset.versionId !== removed) }, fx.next), false, removed);
    }
  }
});

test("same-install adaptation keeps old cases and identity even when its parent has been suspended", () => {
  const fx = fixture(), { acquisition: _acquisition, ...evolution } = fx.evolution;
  const create = (changes: Partial<Parameters<typeof createNpmToolProductionPlan>[0]> = {}) => {
    const next = createNpmToolProductionPlan({ workspaceId: fx.parent.workspaceId, installation: fx.parent.installation,
      descriptor: fx.parent.candidate, runtime: fx.parent.runtime, checks: fx.parent.checks, evolution, ...changes });
    assert.ok(next);
    return next;
  };

  assert.ok(validNpmProductionLineage(fx.state, create()));
  assert.equal(validNpmProductionLineage(fx.state, create({ descriptor: { ...fx.parent.candidate, identity: "another-slot" } })), false);
  const evidence = fx.parent.checks.evidence.map(row => row.sampleId === "v" ? { ...row, expected: { kind: "value" as const, value: 999 } } : row);

  assert.equal(validNpmProductionLineage(fx.state, create({ checks: { ...fx.parent.checks, evidence } })), false);
  assert.equal(validNpmProductionLineage(fx.state, create({ workspaceId: "another-workspace" })), false);
});

test("withdrawn acquisition evidence and mutated parent or receipt cannot validate an upgrade", () => {
  const fx = fixture();

  assert.equal(validNpmProductionLineage({ ...fx.state, tombstones: [{ entityId: fx.receiptId, entityType: "asset", boardSequence: 1, reason: "TEST ONLY" }] }, fx.next), false);
  const corrupted = { ...fx.state, assets: fx.state.assets.map(asset => asset.versionId === fx.parentVersionId
    ? { ...asset, content: { ...fx.parent, candidate: { ...fx.parent.candidate, description: "mutated" } } } : asset) };

  assert.equal(validNpmProductionLineage(corrupted, fx.next), false);
  const missingGrant = { ...fx.state, assets: fx.state.assets.map(asset => {
    if (asset.versionId !== fx.receiptId) return asset;
    const content = { type: "tool_acquisition_installed", schemaVersion: 1, jobId: fx.jobId, scope: fx.scope,
      decisionVersionId: fx.evolution.acquisition.decisionVersionId, installationId: npmInstallId(fx.next.installation), grantId: "" };
    return { ...asset, content, contentHash: contentHashOf(content) };
  }) };

  assert.equal(validNpmProductionLineage(missingGrant, fx.next), false);
});

test("npm oracle corrections require an explicit selected revision and its exact consumed modify record", () => {
  const fx = fixture(), sample = fx.parent.checks.evidence.find(row => row.sampleId === "v")!;
  const proposal: ToolContractRevisionProposal = { type: "tool_contract_revision_proposal", schemaVersion: 1, parentVersionId: fx.parentVersionId,
    parentContractHash: contentHashOf(fx.parent.checks.evidence), scope: fx.scope, reason: "incorrect_expectation", corrections: [{
      sampleId: sample.sampleId, oldSampleHash: contentHashOf(sample), oldExpectedHash: contentHashOf(sample.expected),
      expected: { kind: "value", value: 30 }, evidenceRefs: ["user:correct-expected-value"] }] };
  const revisionId = toolContractRevisionId(proposal);
  const approved = decodeApprovedToolContractRevision({ type: "tool_contract_revision_approved", schemaVersion: 1, revisionId, proposal,
    approval: { grantId: "consumed-modify", action: "modify", candidateId: contractRevisionReviewId(proposal),
      packageVersionId: fx.parentVersionId, scope: fx.scope, consumedAt: AT, sequence: 1 } });
  assert.ok(approved);
  let state = addAsset(fx.state, toolContractProposalId(proposal), proposal, fx.scope);

  state = addAsset(state, revisionId, approved, fx.scope, "workflow", "user_explicit");
  const evidence = fx.parent.checks.evidence.map(row => row.sampleId === sample.sampleId ? { ...row, expected: proposal.corrections[0]!.expected } : row);
  const { acquisition: _acquisition, ...evolution } = fx.evolution;
  const create = (refs?: readonly string[]) => {
    const plan = createNpmToolProductionPlan({ workspaceId: fx.parent.workspaceId, installation: fx.parent.installation,
      descriptor: fx.parent.candidate, runtime: fx.parent.runtime, evolution,
      checks: { ...fx.parent.checks, evidence, ...(refs === undefined ? {} : { contractRevisionRefs: refs }) } });
    assert.ok(plan);
    return plan;
  };

  assert.equal(validNpmProductionLineage(state, create()), false, "available revisions are not silently selected");
  const next = create([revisionId]);
  assert.ok(validNpmProductionLineage(state, next));
  assert.equal(validNpmProductionLineage({ ...state, assets: state.assets.filter(asset => asset.versionId !== toolContractProposalId(proposal)) }, next), false);
  assert.equal(validNpmProductionLineage({ ...state, assets: state.assets.map(asset => asset.versionId === revisionId ? { ...asset, source: "inferred" } : asset) }, next), false);
  const nextVersionId = toolProductionVersion(next);

  state = addAsset(state, nextVersionId, next, toolProductionScope(next), "tool_package", "user_explicit");
  const { contractRevisionRefs: _refs, ...inheritedChecks } = next.checks;
  const derived = createNpmToolProductionPlan({ workspaceId: next.workspaceId, installation: next.installation, descriptor: next.candidate,
    runtime: next.runtime, checks: { ...inheritedChecks, requestId: "test-derived-inheritance" },
    evolution: { parentVersionId: nextVersionId, parentContentHash: contentHashOf(next), requestId: "test-derived", adaptation: "TEST ONLY preserve corrected contract" } });
  assert.ok(derived);
  assert.ok(validNpmProductionLineage(state, derived));
  assert.equal(validNpmProductionLineage({ ...state, tombstones: [...state.tombstones,
    { entityId: revisionId, entityType: "asset", boardSequence: 1, reason: "user_withdrew_ancestor_correction" }] }, derived), false,
  "a descendant cannot retain withdrawn ancestor oracle authority through an empty local refs list");
});
