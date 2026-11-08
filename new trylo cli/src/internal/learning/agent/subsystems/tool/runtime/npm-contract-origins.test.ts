import assert from "node:assert/strict";
import test from "node:test";
import { contentHashOf } from "../../../../control/hash.js";
import type { ToolEvolutionRequest } from "../domain/evolution/contracts.js";
import { decodeNpmLearningContract } from "../domain/evolution/npm-learning.js";
import { npmContractDataFixture, npmObservedFacts, npmFrozenDataFixture, npmApprovedOracleData } from "../testing/npm-contract-data-fixture.js";
import { npmContractGrounding } from "./npm-contract-grounding.js";
import { canonicalNpmContractOrigins } from "./npm-contract-origins.js";

test("host stamping never upgrades an inherited or ancestral synthetic contract into observed evidence", () => {
  const fx = npmContractDataFixture(), grounded = npmContractGrounding(fx.input, fx.basis);
  assert.ok(grounded.ok);
  const legacy = npmFrozenDataFixture(fx.input, grounded.grounding);
  const old = { ...legacy, origins: legacy.origins.map(row => ({ ...row, kind: "observed" as const })) }, before = contentHashOf(old);

  assert.ok(decodeNpmLearningContract(old), "legacy origins retain their existing read compatibility");
  const stamped = canonicalNpmContractOrigins(fx.input, old.checks, grounded.grounding, old.origins);
  assert.ok(stamped.ok);
  assert.ok(stamped.origins.every(row => row.kind === "contract"));
  assert.equal(contentHashOf(old), before);
  assert.deepEqual(stamped.origins.map(row => row.ref), old.origins.map(row => row.ref));
});

test("a real current observed_io alias can be observed while user/tool contract aliases remain contracts", () => {
  const fx = npmContractDataFixture(), original = fx.evidence[0]!;
  const input = npmObservedFacts(fx.input, [{ ...original, sampleId: "current_fact", role: "variation" }]);
  const grounded = npmContractGrounding(input, fx.basis);
  assert.ok(grounded.ok);
  const checks = fx.parent.checks, raw = grounded.grounding.samples.map((row, index) => ({ sampleId: row.sample.sampleId,
    kind: "contract", ref: index === 0 ? "observed:TEST_ONLY" : row.ref }));
  const stamped = canonicalNpmContractOrigins(input, checks, grounded.grounding, raw);
  assert.ok(stamped.ok);
  assert.equal(stamped.origins[0]?.kind, "observed");
  assert.ok(stamped.origins.slice(1).every(row => row.kind === "contract"));

  for (const source of ["user_contract", "tool_contract"] as const) {
    const opportunity = input.plan.opportunity!;
    const other = { ...input, plan: { ...input.plan, opportunity: { ...opportunity, grounding: { ...opportunity.grounding!, source } } } };
    const result = canonicalNpmContractOrigins(other, checks, grounded.grounding, raw);
    assert.ok(result.ok);
    assert.equal(result.origins[0]?.kind, "contract");
  }
});

test("selected approved corrections remain contract provenance even when the model labels them observed", () => {
  const fx = npmContractDataFixture(), correction = npmApprovedOracleData(fx);
  const input = npmObservedFacts(fx.input, [{ ...fx.evidence[0]!, sampleId: "new_fact", expected: correction.expected }]);
  const grounded = npmContractGrounding(input, correction.basis, [correction.revisionId]);
  assert.ok(grounded.ok);
  const checks: ToolEvolutionRequest = { ...fx.parent.checks, contractRevisionRefs: [correction.revisionId], evidence: grounded.grounding.samples.map(row => row.sample) };
  const raw = grounded.grounding.samples.map(row => ({ sampleId: row.sample.sampleId, kind: "observed", ref: row.ref }));
  const stamped = canonicalNpmContractOrigins(input, checks, grounded.grounding, raw);
  assert.ok(stamped.ok);
  assert.equal(stamped.origins[0]?.kind, "contract");
  assert.equal(stamped.origins[0]?.ref, correction.revisionId);
});

test("new answers stay synthetic requirements, and an unrelated observed reference supplies no evidence", () => {
  const fx = npmContractDataFixture(), input = npmObservedFacts(fx.input, [{ ...fx.evidence[0]!, sampleId: "known_alias" }]);
  const grounded = npmContractGrounding(input, fx.basis);
  assert.ok(grounded.ok);
  const fresh = { sampleId: "fresh_case", role: "variation" as const, input: { value: 100 }, expected: { kind: "value" as const, value: 100 } };
  const checks: ToolEvolutionRequest = { ...fx.parent.checks, evidence: [...fx.evidence, fresh] };
  const raw = [...grounded.grounding.samples.map(row => ({ sampleId: row.sample.sampleId, kind: "observed", ref: row.ref })),
    { sampleId: fresh.sampleId, kind: "observed", ref: fx.basis.requirements[0]!.ref }];
  const before = contentHashOf(checks), stamped = canonicalNpmContractOrigins(input, checks, grounded.grounding, raw);
  assert.ok(stamped.ok);
  assert.equal(stamped.origins.at(-1)?.kind, "synthesized");
  assert.equal(contentHashOf(checks), before);
  const rejected = canonicalNpmContractOrigins(input, checks, grounded.grounding, raw.map(row => row.sampleId === fresh.sampleId ? { ...row, ref: "observed:TEST_ONLY" } : row));

  assert.ok(!rejected.ok);
  assert.equal(rejected.code, "npm_contract_origin_unbound");
});

test("host provenance correction does not rewrite oracle values or invent an alias witness", () => {
  const fx = npmContractDataFixture(), grounded = npmContractGrounding(fx.input, fx.basis);
  assert.ok(grounded.ok);
  const raw = grounded.grounding.samples.map(row => ({ sampleId: row.sample.sampleId, kind: "observed", ref: row.ref }));
  const altered: ToolEvolutionRequest = { ...fx.parent.checks, evidence: fx.evidence.map((sample, index) => index === 0 ? { ...sample, expected: { kind: "value", value: 99 } } : sample) };
  const denied = canonicalNpmContractOrigins(fx.input, altered, grounded.grounding, raw);
  assert.ok(!denied.ok);
  assert.equal(denied.code, "npm_contract_origin_mismatch");
  const forged = { ...grounded.grounding, samples: grounded.grounding.samples.map((row, index) => index === 0 ? { ...row, aliases: ["unbound:source"] } : row) };
  const unknown = canonicalNpmContractOrigins(fx.input, fx.parent.checks, forged, raw.map((row, index) => index === 0 ? { ...row, ref: "unbound:source" } : row));

  assert.ok(!unknown.ok);
  assert.equal(unknown.code, "npm_contract_origin_unbound");
});
