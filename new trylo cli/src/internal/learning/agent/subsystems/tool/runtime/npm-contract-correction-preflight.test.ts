import assert from "node:assert/strict";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createFilePermissionStore } from "../../../../../adapters/permission-store/file-ledger.js";
import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { npmLearningFixture, npmLearningTime } from "../testing/npm-learning-fixture.js";
import type { ToolEvolutionSample } from "../domain/evolution/contracts.js";
import { npmLearningSource } from "../adapters/acquisition/npm-learning-source.js";
import { createToolEvolutionArchive } from "./evolution-archive.js";
import { prepareNpmLearningContract } from "./npm-adaptation-contract.js";
import { approveToolContractRevision, proposeToolContractRevision, reviewToolContractRevision } from "./contract-revisions.js";
import type { NpmAdaptationInput } from "./npm-adaptation-types.js";

/** Controlled model output, real Board/Permission lifecycle; no paid calls or execution. */
async function fixture(t: TestContext) {
  const fx = await npmLearningFixture(t), request = fx.checks;
  const candidate = { ...fx.candidate("module.exports=input=>input.value;").interface.descriptor, source: "module.exports=input=>input.value;" };
  const artifact = { schemaVersion: 1 as const, request, candidate, generatedAt: npmLearningTime,
    verification: { verdict: "pass" as const, candidateHash: contentHashOf(candidate), samplesHash: contentHashOf(request.evidence),
      checks: request.evidence.map(sample => ({ sampleId: sample.sampleId, role: sample.role, outcome: "passed" as const, detail: "TEST ONLY parent shape" })) } };
  const saved = await createToolEvolutionArchive(fx.boardRoot).save(artifact);
  assert.ok(saved.ok);
  const { source: parentSource, ...descriptor } = candidate;
  const fresh: readonly ToolEvolutionSample[] = [
    { sampleId: "current-v", role: "variation", input: { value: " STILL_FROZEN " }, expected: { kind: "value", value: "still_frozen" } },
    { sampleId: "current-c", role: "counterexample", input: { value: false }, expected: { kind: "error", code: "invalid_input" } },
  ];
  const input: NpmAdaptationInput = { ...fx, workspaceId: "workspace-test", installation: fx.data.plan, adaptation: "Preserve and explicitly correct this task contract",
    predecessor: { versionId: saved.versionId, contentHash: contentHashOf({ type: "tool_evolution_candidate", ...artifact }), scope: fx.scope,
      capability: request.capability, descriptor, source: parentSource, checks: request, feedback: "TEST ONLY" },
    services: { allowance: async () => ({ grantId: "TEST ONLY", maxCalls: 2, callsRemaining: 2, maxTokens: 32000, tokensRemaining: 32000, maxPromptChars: 24000 }),
      complete: async () => { assert.fail("test must explicitly choose its controlled contract response"); } } };
  const response = (revisionId?: string, expected?: ToolEvolutionSample["expected"]) => ({ checks: { ...request,
    ...(revisionId === undefined ? {} : { contractRevisionRefs: [revisionId] }), evidence: [
      ...request.evidence.map((sample, index) => index === 0 && expected !== undefined ? { ...sample, expected } : sample), ...fresh] },
    origins: [...request.evidence.map((sample, index) => ({ sampleId: sample.sampleId, kind: "contract", ref: index === 0 && revisionId !== undefined ? revisionId : `${saved.versionId}:${sample.sampleId}` })),
      ...fresh.map(sample => ({ sampleId: sample.sampleId, kind: "synthesized", ref: `contract:${saved.versionId}` }))] });
  const expected = { kind: "value" as const, value: "user_corrected_expected" }, old = request.evidence[0]!;
  const approve = async () => {
    const proposed = await proposeToolContractRevision(fx.boardRoot, { type: "tool_contract_revision_proposal", schemaVersion: 1,
      parentVersionId: saved.versionId, scope: fx.scope, parentContractHash: contentHashOf(request.evidence), reason: "incorrect_expectation",
      corrections: [{ sampleId: old.sampleId, oldSampleHash: contentHashOf(old), oldExpectedHash: contentHashOf(old.expected), expected,
        evidenceRefs: ["user:exact-correction"] }] }, npmLearningTime);
    assert.ok(proposed.ok);
    const review = await reviewToolContractRevision(fx.boardRoot, proposed.proposalId, fx.scope);
    assert.ok(review.ok);
    const permission = createFilePermissionStore({ path: path.join(fx.root, "contract-permissions.ndjson") });
    const grant = await permission.issue({ action: "modify", candidateId: review.reviewId, packageVersionId: saved.versionId, scope: fx.scope,
      issuedAt: npmLearningTime, expiry: "2026-11-04T00:10:00.000Z" });
    assert.ok(grant.ok);
    const approved = await approveToolContractRevision({ boardRoot: fx.boardRoot, proposalId: proposed.proposalId, scope: fx.scope,
      reviewId: review.reviewId, permission, token: { grantId: grant.grant.grantId }, issuedAt: npmLearningTime });
    assert.ok(approved.ok);

    return approved.revisionId;
  };
  const observed = (selected: NpmAdaptationInput): NpmAdaptationInput => ({ ...selected, plan: { ...selected.plan, opportunity: {
    reportId: "TEST_ONLY_corrected_task", source: "user", executions: [], assessment: { kind: "opportunity", need: selected.plan.capability,
      reason: "TEST ONLY the already approved external correction arrived with task facts", toolCallIds: [], existingCapability: "insufficient" },
    grounding: { source: "observed_io", reference: "user:exact-correction", samples: [{ ...old, sampleId: "external-alias", role: "variation", expected }] } } } });
  const source = npmLearningSource([], "node_modules/test-cli");

  return { fx, input, response, expected, approve, observed, source };
}

test("preapproved corrections are applied before already corrected observed facts reach the first npm contract", async t => {
  const f = await fixture(t), revisionId = await f.approve();
  let calls = 0;
  const input = f.observed({ ...f.input, services: { ...f.input.services, complete: async prompt => {
    calls++;
    assert.ok(prompt.includes(revisionId) && prompt.includes("user_corrected_expected"));
    return f.response(revisionId, f.expected);
  } } });
  const frozen = await prepareNpmLearningContract(input, f.source, () => f.source);
  assert.ok(frozen.ok, JSON.stringify(frozen));
  assert.equal(calls, 1);
  assert.deepEqual(frozen.contract.checks.contractRevisionRefs, [revisionId]);
  assert.deepEqual(frozen.contract.checks.evidence[0]?.expected, f.expected);
  assert.deepEqual(frozen.contract.frozenBasis?.grounding.samples[0]?.aliases, ["user:exact-correction"]);
});

test("a committed oracle derives its approved correction before checking new observed facts without regenerating hidden checks", async t => {
  const f = await fixture(t);
  let calls = 0;
  const initial = { ...f.input, services: { ...f.input.services, complete: async () => {
    calls++;
    return f.response();
  } } };
  const first = await prepareNpmLearningContract(initial, f.source, () => f.source);
  assert.ok(first.ok);
  const revisionId = await f.approve();
  const input = f.observed({ ...initial, services: { ...initial.services, complete: async () => { assert.fail("approved derivation cannot buy a new oracle"); } } });
  const next = await prepareNpmLearningContract(input, f.source, () => f.source);
  assert.ok(next.ok, JSON.stringify(next));
  assert.notEqual(next.versionId, first.versionId);
  assert.deepEqual(next.contract.checks.contractRevisionRefs, [revisionId]);
  assert.deepEqual(next.contract.checks.evidence, first.contract.checks.evidence.map((sample, index) => index === 0 ? { ...sample, expected: f.expected } : sample));
  assert.deepEqual(next.contract.freshCases, first.contract.freshCases);
  assert.equal(calls, 1);
  const unrelated = await prepareNpmLearningContract({ ...input, requirements: [{ ref: "user:unrelated", text: "A new independent requirement not covered by this oracle" }] }, f.source, () => f.source);

  assert.ok(!unrelated.ok);
  assert.equal(unrelated.code, "npm_contract_revision_required");
  const loaded = await createBoardReader(f.fx.boardRoot).load();
  assert.ok(loaded.ok);
  assert.deepEqual(loaded.state.assets.find(row => row.versionId === first.versionId)?.content, first.contract);
  assert.equal(loaded.state.activations.length, 0);
});
