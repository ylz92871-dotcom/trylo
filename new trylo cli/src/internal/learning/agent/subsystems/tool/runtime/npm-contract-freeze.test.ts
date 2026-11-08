import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createFilePermissionStore } from "../../../../../adapters/permission-store/file-ledger.js";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { npmLearningFixture, npmLearningTime } from "../testing/npm-learning-fixture.js";
import { npmLearningSource } from "../adapters/acquisition/npm-learning-source.js";
import { npmImplementationPrompt } from "../domain/evolution/npm-learning-prompt.js";
import { createToolEvolutionArchive } from "./evolution-archive.js";
import { prepareNpmLearningContract } from "./npm-adaptation-contract.js";
import { approveToolContractRevision, proposeToolContractRevision, reviewToolContractRevision } from "./contract-revisions.js";
import type { NpmAdaptationInput } from "./npm-adaptation-types.js";

test("new feedback requirements on the same npm job cannot silently buy a new frozen oracle", async t => {
  const fx = await npmLearningFixture(t);
  let calls = 0;
  const source = npmLearningSource([], "node_modules/test-cli");
  const input: NpmAdaptationInput = { ...fx, workspaceId: "workspace-test", installation: fx.data.plan, adaptation: "same adapter task",
    services: { allowance: async () => ({ grantId: "TEST ONLY", maxCalls: 2, callsRemaining: 2, maxTokens: 32000, tokensRemaining: 32000, maxPromptChars: 24000 }),
      complete: async () => {
        calls++;
        return fx.contract;
      } } };
  const first = await prepareNpmLearningContract(input, source, () => source);
  assert.ok(first.ok);
  const resumed = await prepareNpmLearningContract({ ...input, requirements: [{ ref: "user:later-correction", text: "A later task fact needs an explicit contract decision" }] }, source, () => source);

  assert.ok(!resumed.ok);
  assert.equal(resumed.code, "npm_contract_revision_required");
  assert.equal(calls, 1);
  const stored = await createBoardReader(fx.boardRoot).load();
  assert.ok(stored.ok);
  assert.deepEqual(stored.state.assets.find(asset => asset.versionId === first.versionId)?.content, first.contract);
  const prompt = npmImplementationPrompt({ contract: first.contract, adaptation: "TEST ONLY", source: {}, allowance: {} });

  assert.ok(!prompt.includes("HELD_OUT_SENTINEL") && !prompt.includes("held_out_sentinel"), "host-only frozen grounding must not leak held-out samples through a metadata spread");
});

test("an approved expected correction derives from the committed npm oracle without resynthesizing any other case", async t => {
  const fx = await npmLearningFixture(t), request = fx.checks;
  const candidate = { identity: "normalize", description: "TEST ONLY", source: "module.exports=input=>input;", inputSchema: {},
    mastery: { whenToUse: ["TEST ONLY frozen contract"], preconditions: [], pitfalls: [] } };
  const artifact = { schemaVersion: 1 as const, request, candidate, generatedAt: npmLearningTime,
    verification: { verdict: "pass" as const, candidateHash: contentHashOf(candidate), samplesHash: contentHashOf(request.evidence),
      checks: request.evidence.map(sample => ({ sampleId: sample.sampleId, role: sample.role, outcome: "passed" as const, detail: "TEST ONLY" })) } };
  const archived = await createToolEvolutionArchive(fx.boardRoot).save(artifact);
  assert.ok(archived.ok);
  const source = npmLearningSource([], "node_modules/test-cli");
  let calls = 0;
  const extra = { sampleId: "synthetic-extra", role: "variation" as const, input: { value: "UNCHANGED_SYNTHETIC" }, expected: { kind: "value" as const, value: "unchanged_synthetic" } };
  const negative = { sampleId: "current-negative", role: "counterexample" as const, input: { value: false }, expected: { kind: "error" as const, code: "invalid_input" } };
  const input: NpmAdaptationInput = { ...fx, workspaceId: "workspace-test", installation: fx.data.plan, adaptation: "preserve task ABI",
    predecessor: { versionId: archived.versionId, contentHash: contentHashOf(artifact), scope: fx.scope, capability: request.capability,
      checks: request, source: candidate.source, descriptor: { identity: candidate.identity, description: candidate.description, inputSchema: {}, mastery: candidate.mastery }, feedback: "TEST ONLY" },
    services: { allowance: async () => ({ grantId: "TEST ONLY", maxCalls: 2, callsRemaining: 2, maxTokens: 32000, tokensRemaining: 32000, maxPromptChars: 24000 }),
      complete: async () => { calls++;
      return { checks: { ...request, evidence: [...request.evidence, negative, extra] }, origins: [
        ...request.evidence.map(sample => ({ sampleId: sample.sampleId, kind: "contract", ref: `${archived.versionId}:${sample.sampleId}` })),
        { sampleId: negative.sampleId, kind: "synthesized", ref: "requirement:normalize" },
        { sampleId: extra.sampleId, kind: "synthesized", ref: "requirement:normalize" }] }; } } };
  const first = await prepareNpmLearningContract(input, source, () => source);
  assert.ok(first.ok);
  const old = request.evidence[0]!, expected = { kind: "value", value: "corrected_external_expected" };
  const proposed = await proposeToolContractRevision(fx.boardRoot, { type: "tool_contract_revision_proposal", schemaVersion: 1,
    parentVersionId: archived.versionId, scope: fx.scope, parentContractHash: contentHashOf(request.evidence), reason: "incorrect_expectation",
    corrections: [{ sampleId: old.sampleId, oldSampleHash: contentHashOf(old), oldExpectedHash: contentHashOf(old.expected), expected, evidenceRefs: ["user:exact-correction"] }] }, npmLearningTime);
  assert.ok(proposed.ok);
  const unapproved = await prepareNpmLearningContract(input, source, () => source);
  assert.ok(unapproved.ok);
  assert.equal(unapproved.versionId, first.versionId);
  const review = await reviewToolContractRevision(fx.boardRoot, proposed.proposalId, fx.scope);
  assert.ok(review.ok);
  const permission = createFilePermissionStore({ path: path.join(fx.root, "contract-permissions.ndjson") });
  const grant = await permission.issue({ action: "modify", candidateId: review.reviewId, packageVersionId: archived.versionId, scope: fx.scope,
    issuedAt: npmLearningTime, expiry: "2026-11-04T00:10:00.000Z" });
  assert.ok(grant.ok);
  const approved = await approveToolContractRevision({ boardRoot: fx.boardRoot, proposalId: proposed.proposalId, scope: fx.scope,
    reviewId: review.reviewId, permission, token: { grantId: grant.grant.grantId }, issuedAt: npmLearningTime });
  assert.ok(approved.ok);
  const revised = await prepareNpmLearningContract(input, source, () => source);
  assert.ok(revised.ok);
  assert.equal(calls, 1);
  assert.notEqual(revised.versionId, first.versionId);
  assert.deepEqual(revised.contract.checks.contractRevisionRefs, [approved.revisionId]);
  assert.deepEqual(revised.contract.checks.evidence, first.contract.checks.evidence.map(sample => sample.sampleId === old.sampleId ? { ...sample, expected } : sample));
  assert.deepEqual(revised.contract.checks.evidence.at(-1), extra);
  const loaded = await createBoardReader(fx.boardRoot).load();
  assert.ok(loaded.ok);
  assert.deepEqual(loaded.state.assets.find(asset => asset.versionId === first.versionId)?.content, first.contract, "the original oracle remains immutable");
  const restarted = await prepareNpmLearningContract(input, source, () => source);
  assert.ok(restarted.ok);
  assert.equal(restarted.versionId, revised.versionId);
  assert.equal(calls, 1);
});
