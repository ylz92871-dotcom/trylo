import { test } from "node:test";
import assert from "node:assert/strict";
import { betaSurvival, posteriorOf, recentPosteriorOf, METHOD_INFERENCE_POLICY } from "./inference.js";
import { evidenceOf, isMethodObservation, type MethodObservation } from "./inference-observations.js";

function observed(index: number, outcome: MethodObservation["outcome"] = "helped"): MethodObservation {
  return { observationId: `o${index}`, taskId: `task${index}`, opportunityId: "main", versionId: "v1",
    scopeId: "base", sequence: index, revision: 0, adoption: "adopted", outcome, source: "self_report",
    features: { format: "json" } };
}

const selection = { versionId: "v1", scopeId: "base" };

test("Beta survival agrees with independent exact integer-binomial rational sums", () => {
  for (let successes = 0; successes <= 40; successes += 1) {
    for (let failures = 0; failures <= 40; failures += 1) {
      const n = successes + failures + 1;
      let choose = 1n;
      let numerator = 0n;

      for (let k = 0; k <= successes; k += 1) {
        if (k > 0) choose = choose * BigInt(n - k + 1) / BigInt(k);
        numerator += choose * 3n ** BigInt(k);
      }

      const expected = Number(numerator) / Number(4n ** BigInt(n));

      assert.ok(Math.abs(betaSurvival(successes + 1, failures + 1, .75) - expected) < 2e-12);
    }
  }
});

test("posterior boundaries, extreme counts, and directional updates", () => {
  assert.equal(betaSurvival(1, 1, 0), 1);
  assert.equal(betaSurvival(1, 1, 1), 0);
  assert.ok(Math.abs(posteriorOf({ successes: 10, failures: 0 }).confidence - (1 - .75 ** 11)) < 1e-14);
  assert.ok(Math.abs(betaSurvival(100001, 100001, .5) - .5) < 2e-12);
  assert.equal(betaSurvival(1, 100001, .75), 0);
  assert.equal(betaSurvival(100001, 1, .75), 1);

  for (let successes = 0; successes < 40; successes += 1) {
    for (let failures = 0; failures < 40; failures += 1) {
      const before = posteriorOf({ successes, failures }).confidence;
      assert.ok(posteriorOf({ successes: successes + 1, failures }).confidence >= before - 2e-12);
      assert.ok(posteriorOf({ successes, failures: failures + 1 }).confidence <= before + 2e-12);
    }
  }

  assert.throws(() => betaSurvival(1.5, 1, .5), RangeError);
  assert.throws(() => posteriorOf({ successes: -1, failures: 0 }), RangeError);
  assert.throws(() => posteriorOf({ successes: 10, failures: 0 }, { priorAlpha: -1 }), RangeError);
});

test("canonical observation guard rejects malformed persistence and oversized feature payloads", () => {
  assert.equal(isMethodObservation(observed(1)), true);
  assert.equal(isMethodObservation({ ...observed(1), revision: -1 }), false);
  assert.equal(isMethodObservation({ ...observed(1), sequence: Infinity }), false);
  assert.equal(isMethodObservation({ ...observed(1), outcome: "success" }), false);
  assert.equal(isMethodObservation({ ...observed(1), features: { format: 3 } }), false);
  assert.equal(isMethodObservation({ ...observed(1), features: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`f${i}`, "v"])) }), false);
});

test("one opportunity and same-origin repeats cannot increase evidence", () => {
  const one = observed(1);
  const repeated = { ...one, observationId: "copy" };
  assert.equal(evidenceOf([one, repeated], selection).successes, 1);
  assert.equal(evidenceOf([one, { ...observed(2), correlationId: "same" },
    { ...observed(3), correlationId: "same" }], selection).successes, 2);
});

test("unknown, merely displayed and external failure stay out of Bernoulli counts", () => {
  const result = evidenceOf([observed(1, "unknown"), observed(2, "external_failure"),
    { ...observed(3), adoption: "displayed" }, { ...observed(4), source: "external" }], selection);

  assert.equal(result.successes + result.failures, 0);
  assert.equal(result.unknown, 1);
  assert.equal(result.externalFailures, 1);
  assert.equal(result.notAdopted, 1);
  assert.equal(evidenceOf([{ ...observed(4), source: "external" }], { ...selection, source: "external" }).successes, 1);
});

test("external outcomes remain separate from self reports for the same task opportunity and model scores add no samples", () => {
  const selfReport = observed(1);
  const external: MethodObservation = { ...selfReport, observationId: "external-o1", source: "external", outcome: "unhelpful" };
  const modelJudgmentMetadata = { ...selfReport, modelScore: 1 };
  const observations = [selfReport, external, modelJudgmentMetadata];
  const reported = evidenceOf(observations, selection);
  const measured = evidenceOf(observations, { ...selection, source: "external" });

  assert.equal(reported.successes, 1);
  assert.equal(reported.failures, 0);
  assert.equal(measured.successes, 0);
  assert.equal(measured.failures, 1);
  assert.equal(posteriorOf(reported).confidence, posteriorOf({ successes: 1, failures: 0 }).confidence);
  assert.equal(reported.observationIds.length, 1, "subjective M metadata cannot create another use trial");
});

test("correction replaces rather than appends a positive observation", () => {
  const original = observed(1);
  const correction = { ...original, observationId: "corrected", revision: 1, outcome: "unhelpful" as const };
  const evidence = evidenceOf([original, correction, correction], selection);

  assert.equal(evidence.successes, 0);
  assert.equal(evidence.failures, 1);
  assert.deepEqual(evidenceOf([correction, original], selection), evidence);
  assert.throws(() => evidenceOf([original, { ...original, outcome: "unhelpful" }], selection));
  assert.throws(() => evidenceOf([original, { ...correction, sequence: 2 }], selection));
});

test("recent exit is bounded, excludes missing reports, and ignores distant success", () => {
  const past = Array.from({ length: 80 }, (_, index) => observed(index + 1));
  const failures = Array.from({ length: 12 }, (_, index) => observed(index + 81, "unhelpful"));
  const recent = recentPosteriorOf([...past, ...failures], selection);

  assert.equal(recent.eligibleCount, METHOD_INFERENCE_POLICY.exitWindow);
  assert.equal(recent.shouldExit, true);
  assert.equal(recentPosteriorOf([observed(1, "unhelpful")], selection).shouldExit, false);
  assert.equal(recentPosteriorOf([...past, ...failures.map(item => ({ ...item, outcome: "unknown" as const }))], selection).shouldExit, false);
  assert.equal(evidenceOf([...past, ...failures], { ...selection, sinceSequence: 92 }).successes, 0);
});
