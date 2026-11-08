import assert from "node:assert/strict";
import test from "node:test";
import { contentHashOf } from "../../../../control/hash.js";
import { decodeNpmLearningContract } from "../domain/evolution/npm-learning.js";
import { npmContractGrounding, npmFrozenGroundingDrift } from "./npm-contract-grounding.js";
import { npmContractDataFixture as fixture, npmObservedFacts as observed, npmFrozenDataFixture as frozen, npmApprovedOracleData } from "../testing/npm-contract-data-fixture.js";


test("a disclosed input alias preserves its parent identity and role while retaining the new fact reference", () => {
  const fx = fixture(), old = fx.evidence[0]!, before = contentHashOf(fx.parent);
  const input = observed(fx.input, [{ ...old, sampleId: "observed_alias", role: "variation" }]);
  const result = npmContractGrounding(input, fx.basis);
  assert.ok(result.ok);
  assert.equal(result.grounding.samples.length, 4);
  const row = result.grounding.samples[0]!;

  assert.deepEqual(row.sample, old);
  assert.equal(row.ref, `${fx.input.parent!.versionId}:${old.sampleId}`);
  assert.deepEqual(row.aliases, ["observed:TEST_ONLY"]);
  assert.equal(contentHashOf(fx.parent), before);
});

test("conflicting expectations or recycled IDs require an explicit correction rather than a model's choice", () => {
  const fx = fixture(), old = fx.evidence[0]!;
  for (const sample of [
    { ...old, sampleId: "contradictory", expected: { kind: "value" as const, value: 999 } },
    { ...old, input: { value: 999 }, expected: { kind: "value" as const, value: 999 } },
  ]) {
    const result = npmContractGrounding(observed(fx.input, [sample]), fx.basis);
    assert.ok(!result.ok);
    assert.equal(result.code, "npm_contract_revision_required");
  }
});

test("approved oracle replacements apply before comparing the new observed fact", () => {
  const fx = fixture(), old = fx.evidence[0]!, { basis, revisionId, expected } = npmApprovedOracleData(fx);
  const input = observed(fx.input, [{ ...old, sampleId: "new_fact", role: "variation", expected }]);
  const absent = npmContractGrounding(input, basis);
  assert.ok(!absent.ok);
  assert.equal(absent.code, "npm_contract_revision_required");
  const result = npmContractGrounding(input, basis, [revisionId]);
  assert.ok(result.ok);
  assert.deepEqual(result.grounding.samples[0]?.sample, { ...old, expected });
  assert.equal(result.grounding.samples[0]?.ref, revisionId);
  assert.deepEqual(result.grounding.samples[0]?.aliases, ["observed:TEST_ONLY"]);
});

test("capacity counts distinct inputs rather than disclosed aliases, and overflow never drops old cases", () => {
  const fx = fixture(32), first = fx.evidence[0]!;
  const aliases = Array.from({ length: 32 }, (_, index) => ({ ...first, sampleId: `alias_${index}`, role: "variation" as const }));
  const merged = npmContractGrounding(observed(fx.input, aliases), fx.basis);
  assert.ok(merged.ok);
  assert.equal(merged.grounding.samples.length, 32);
  assert.deepEqual(merged.grounding.samples[0]?.aliases, ["observed:TEST_ONLY"]);
  const full = npmContractGrounding(observed(fx.input, [{ sampleId: "distinct", role: "source", input: { value: 100 }, expected: { kind: "value", value: 100 } }]), fx.basis);
  assert.ok(!full.ok);
  assert.equal(full.code, "npm_grounding_capacity");
  assert.equal(fx.evidence.length, 32);
});

test("no-parent disclosed cases retain their first identity and cannot hide a later ID collision", () => {
  const fx = fixture(), { parent: _parent, ...input } = fx.input, old = fx.evidence[0]!;
  const result = npmContractGrounding(observed(input, [old, { ...old, sampleId: "later", role: "variation" }]), fx.basis);
  assert.ok(result.ok);
  assert.equal(result.grounding.samples.length, 1);
  assert.deepEqual(result.grounding.samples[0]?.sample, old);
  const collision = npmContractGrounding(observed(input, [old, { ...old, sampleId: "later" }, { ...old, sampleId: "later", input: { value: 99 } }]), fx.basis);
  assert.ok(!collision.ok);
  assert.equal(collision.code, "npm_contract_revision_required");
});

test("new agreeing source refs do not rewrite a committed oracle or its frozen basis", () => {
  const fx = fixture(), original = npmContractGrounding(fx.input, fx.basis);
  assert.ok(original.ok);
  const contract = frozen(fx.input, original.grounding), before = contentHashOf(contract);
  assert.ok(decodeNpmLearningContract(contract));
  const input = observed(fx.input, [{ ...fx.evidence[0]!, sampleId: "new_alias", role: "variation" }]);

  assert.ok(npmFrozenGroundingDrift(input, fx.basis, contract).ok);
  assert.equal(contentHashOf(contract), before);
  assert.ok(decodeNpmLearningContract(contract));
  assert.equal(contract.frozenBasis?.grounding.samples[0]?.aliases, undefined);
  const duplicate = { ref: "observed:legacy", sample: { ...fx.evidence[0]!, sampleId: "legacy_alias", role: "variation" as const } };
  const legacy = frozen(fx.input, { ...original.grounding, samples: [...original.grounding.samples, duplicate] }), oldHash = contentHashOf(legacy);

  assert.ok(decodeNpmLearningContract(legacy));
  const denied = npmFrozenGroundingDrift(input, fx.basis, legacy);
  assert.ok(!denied.ok);
  assert.equal(denied.code, "npm_contract_revision_required");
  assert.equal(contentHashOf(legacy), oldHash);
});
