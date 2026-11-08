import assert from "node:assert/strict";
import test from "node:test";
import { contentHashOf } from "../../../../control/hash.js";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { npmInstallId } from "../../../../../tooling/contract/npm-install.js";
import type { NpmAdaptationInput } from "./npm-adaptation-types.js";
import type { ToolEvolutionRequest } from "../domain/evolution/contracts.js";
import { npmLearningFixture, npmLearningAdapter, npmLearningTime } from "../testing/npm-learning-fixture.js";
import { createToolEvolutionArchive } from "./evolution-archive.js";
import { npmLearningSource } from "../adapters/acquisition/npm-learning-source.js";
import { prepareNpmLearningContract } from "./npm-adaptation-contract.js";
import { npmImplementationPrompt } from "../domain/evolution/npm-learning-prompt.js";
import { npmFrozenBasis, npmFrozenContractId } from "./npm-contract-freeze.js";
import { npmContractBasis, npmContractGrounding } from "./npm-contract-grounding.js";
import { saveNpmLearningArtifact } from "./npm-adaptation-artifacts.js";
import { createNpmToolProductionPlan, decodeNpmToolInterface } from "../domain/evolution/npm-production-plan.js";
import { saveToolProductionPlan, readToolProductionPlan } from "./production-assets.js";
import { validNpmLearningOrigin } from "./npm-learning-origin.js";

async function predecessor(fx: Awaited<ReturnType<typeof npmLearningFixture>>, request: ToolEvolutionRequest) {
  const candidate = { ...fx.candidate(npmLearningAdapter).interface.descriptor, source: "module.exports=input=>input;" };
  const artifact = { schemaVersion: 1 as const, request, candidate, generatedAt: npmLearningTime,
    verification: { verdict: "pass" as const, candidateHash: contentHashOf(candidate), samplesHash: contentHashOf(request.evidence),
      checks: request.evidence.map(sample => ({ sampleId: sample.sampleId, role: sample.role, outcome: "passed" as const, detail: "TEST ONLY parent contract fixture" })) } };
  const archived = await createToolEvolutionArchive(fx.boardRoot).save(artifact);
  assert.ok(archived.ok);
  const { source, ...parentDescriptor } = candidate;

  return { versionId: archived.versionId, contentHash: contentHashOf({ type: "tool_evolution_candidate", ...artifact }), scope: fx.scope,
    capability: request.capability, descriptor: parentDescriptor, checks: request, source, feedback: "TEST ONLY disclosed parent regressions" };
}

const allowance = async () => ({ grantId: "TEST ONLY", maxCalls: 2, callsRemaining: 2, maxTokens: 32000, tokensRemaining: 32000, maxPromptChars: 24000 });

test("a parent adaptation freezes a new disjoint pair before source while retaining every old regression", async t => {
  const fx = await npmLearningFixture(t), parent = await predecessor(fx, fx.checks);
  let calls = 0;
  const fresh = [{ sampleId: "fresh-current-v", role: "variation" as const, input: { value: "CURRENT_FRESH_SENTINEL" }, expected: { kind: "value" as const, value: "current_fresh_sentinel" } },
    { sampleId: "fresh-current-c", role: "counterexample" as const, input: { value: false }, expected: { kind: "error" as const, code: "invalid_input" } }];
  const input: NpmAdaptationInput = { ...fx, predecessor: parent, workspaceId: "workspace-test", installation: fx.data.plan, adaptation: "Use the reviewed API and preserve the old contract",
    services: { allowance, complete: async () => { calls++;
    return { checks: { ...fx.checks, evidence: [...fx.checks.evidence, ...fresh] }, origins: [
      ...fx.checks.evidence.map(sample => ({ sampleId: sample.sampleId, kind: "contract", ref: `${parent.versionId}:${sample.sampleId}` })),
      ...fresh.map(sample => ({ sampleId: sample.sampleId, kind: "synthesized", ref: "requirement:normalize" }))] }; } } };
  const source = npmLearningSource([], "node_modules/test-cli"), frozen = await prepareNpmLearningContract(input, source, () => source);
  assert.ok(frozen.ok, JSON.stringify(frozen));
  assert.equal(calls, 1);
  assert.deepEqual(frozen.contract.checks.evidence.slice(0, 4), fx.checks.evidence);
  assert.equal(frozen.contract.freshCases?.variationSampleId, fresh[0]?.sampleId);
  const prompt = npmImplementationPrompt({ contract: frozen.contract, adaptation: input.adaptation, source: {}, allowance: {} });

  assert.equal(prompt.includes("CURRENT_FRESH_SENTINEL"), false);
  assert.equal(prompt.includes("current_fresh_sentinel"), false);
  assert.equal(prompt.includes('"currentHoldoutCases":2'), true);
  assert.equal(prompt.includes('"freshCases"'), false);
  assert.equal(prompt.includes('"frozenBasis"'), false);
  const planInterface = decodeNpmToolInterface(fx.candidate(npmLearningAdapter).interface);
  assert.ok(planInterface);
  const production = createNpmToolProductionPlan({ workspaceId: input.workspaceId, installation: input.installation, ...planInterface,
    checks: frozen.contract.checks, learning: { ...input.admission, contractId: frozen.versionId }, evolution: {
      parentVersionId: parent.versionId, parentContentHash: parent.contentHash, requestId: `${input.admission.jobId}:1`, adaptation: input.adaptation } });
  assert.ok(production);
  const loaded = await createBoardReader(fx.boardRoot).load();
  assert.ok(loaded.ok);
  assert.equal(validNpmLearningOrigin(loaded.state, production), true);
  assert.equal(validNpmLearningOrigin(loaded.state, { ...production, evolution: { ...production.evolution!, parentContentHash: "f".repeat(64) } }), false);
});

test("a full parent contract is refused before any paid design call", async t => {
  const fx = await npmLearningFixture(t);
  const request = { ...fx.checks, evidence: [...fx.checks.evidence, ...Array.from({ length: 27 }, (_, index) => ({ sampleId: `old-${index}`,
    role: "variation" as const, input: { value: `known-${index}` }, expected: { kind: "value" as const, value: `known-${index}` } }))] };
  const parent = await predecessor(fx, request), source = npmLearningSource([], "node_modules/test-cli");
  const result = await prepareNpmLearningContract({ ...fx, predecessor: parent, workspaceId: "workspace-test", installation: fx.data.plan,
    adaptation: "Preserve 31 disclosed cases", services: { allowance: async () => { assert.fail("capacity must be checked before model allowance admission"); },
      complete: async () => { assert.fail("a model cannot solve an over-cap immutable contract"); } } }, source, () => source);

  assert.ok(!result.ok);
  assert.equal(result.code, "npm_fresh_contract_capacity");
});

test("legacy frozen oracles and committed production stay readable but cannot silently become fresh adaptation contracts", async t => {
  const fx = await npmLearningFixture(t), source = npmLearningSource([], "node_modules/test-cli");
  const input: NpmAdaptationInput = { ...fx, workspaceId: "workspace-test", installation: fx.data.plan, adaptation: "Legacy frozen contract",
    services: { allowance, complete: async () => { assert.fail("legacy commitments cannot trigger oracle regeneration"); } } };
  const basis = await npmContractBasis(input);
  assert.ok(basis.ok);
  const selected = npmContractGrounding(input, basis);
  assert.ok(selected.ok);
  const versionId = npmFrozenContractId(input), legacy = { type: "tool_npm_learning_contract", schemaVersion: 1,
    subjectId: fx.admission.jobId, installationId: npmInstallId(fx.data.plan), groundingHash: contentHashOf(selected.grounding),
    checks: fx.checks, origins: fx.contract.origins, frozenBasis: npmFrozenBasis(input, selected.grounding) };

  assert.ok((await saveNpmLearningArtifact({ ...input, scope: fx.scope, versionId, content: legacy, issuedAt: npmLearningTime })).ok);
  const planInterface = decodeNpmToolInterface(fx.candidate(npmLearningAdapter).interface);
  assert.ok(planInterface);
  const production = createNpmToolProductionPlan({ workspaceId: input.workspaceId, installation: fx.data.plan, ...planInterface,
    checks: fx.checks, learning: { ...fx.admission, contractId: versionId } });
  assert.ok(production);
  const committed = await saveToolProductionPlan(fx.boardRoot, production, npmLearningTime);
  assert.ok(committed.ok);
  const resumed = await prepareNpmLearningContract(input, source, () => source);
  assert.ok(!resumed.ok);
  assert.equal(resumed.code, "npm_fresh_contract_required");
  assert.ok((await readToolProductionPlan(fx.boardRoot, committed.versionId, input.workspaceId)).ok);
  const loaded = await createBoardReader(fx.boardRoot).load();
  assert.ok(loaded.ok);
  assert.deepEqual(loaded.state.assets.find(asset => asset.versionId === versionId)?.content, legacy);
});
