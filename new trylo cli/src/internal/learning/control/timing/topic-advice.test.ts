import assert from "node:assert/strict";
import test from "node:test";
import { contentHashOf } from "../hash.js";
import { analyzeTopicLearningTiming } from "./topic-advice.js";
import type { TopicTimingBasis, TopicTimingRequest } from "./topic-advice.js";

function request(): TopicTimingRequest {
  return { schemaVersion: 1, quota: 2, contextRef: "history:current", evaluationRef: "evaluation:common-T",
    bid: { schemaVersion: 1, valuationId: "valuation:one", domain: "prompt", scope: "project:timing",
      basis: { boardSequence: 7, evidenceWindowHash: "evidence:one" },
      utilityUnit: "goal-v1", quotaUnit: "probe-v1", modelKind: "declared_finite_expected_utility",
      curve: [{ quota: 0, netValue: 0 }, { quota: 1, netValue: 0.25 }, { quota: 2, netValue: 0.5 }] },
    model: null };
}

function basisOf(input: TopicTimingRequest): TopicTimingBasis {
  const result = analyzeTopicLearningTiming(JSON.stringify(input));
  assert.equal(result.status, "requires_timing_model");
  if (result.status !== "requires_timing_model") throw new Error("test_basis_unavailable");
  return result.basis;
}

function model(basis: TopicTimingBasis) {
  return { schemaVersion: 1, modelKind: "finite_predictive_expected", sourceScope: basis.scope,
    basisRef: basis.basisRef, evaluationRef: basis.evaluationRef, utilityUnit: basis.utilityUnit,
    root: "root", coverage: "complete-declared-family", reference: null,
    contexts: [{ id: "root", actionCoverage: "complete", noMoreAction: "none", actions: [
      { kind: "closed", id: "start", firstControl: "start_now", programRef: "program:start", value: [0.5, 0.5] },
      { kind: "closed", id: "none", firstControl: "no_more_processing", programRef: "program:none", value: [0, 0] },
    ] }] };
}

test("current canonical bid forms a request basis without guessing future timing", () => {
  const input = request(), basis = basisOf(input);

  assert.equal(basis.bidHash, contentHashOf(input.bid));
  assert.equal(basis.quota, 2);
  assert.equal(basis.quotedNetValue, 0.5);
  assert.equal(basis.domain, "prompt");
  assert.deepEqual(basis.sourceBasis, input.bid.basis);
  assert.equal(basisOf(input).basisRef, basis.basisRef);
  const zero = basisOf({ ...input, quota: 0 });

  assert.equal(zero.quotedNetValue, 0);
  assert.notEqual(zero.basisRef, basis.basisRef);
});

test("matching conditional declaration is analyzed and preserves both identities", () => {
  const input = request(), basis = basisOf(input);
  const result = analyzeTopicLearningTiming(JSON.stringify({ ...input, model: model(basis) }));
  assert.equal(result.status, "analyzed_topic_timing");
  if (result.status !== "analyzed_topic_timing") return;
  assert.equal(result.basis.basisRef, basis.basisRef);
  assert.equal(result.analysis.basis.basisRef, basis.basisRef);
});

test("old response is refused when quota, current context, target or full bid changes", () => {
  const input = request(), oldModel = model(basisOf(input));
  const variants = [{ ...input, quota: 1 }, { ...input, contextRef: "history:new" },
    { ...input, evaluationRef: "evaluation:new" },
    { ...input, bid: { ...input.bid, curve: [{ quota: 0, netValue: 0 },
      { quota: 1, netValue: 0.25 }, { quota: 2, netValue: 0.75 }] } }];

  for (const variant of variants) {
    const result = analyzeTopicLearningTiming(JSON.stringify({ ...variant, model: oldModel }));
    assert.equal(result.status, "binding_mismatch");
  }
});

test("scope and utility cannot be relabelled even with the old request hash", () => {
  const input = request(), declaration = model(basisOf(input));
  for (const patch of [{ sourceScope: "another-scope" }, { utilityUnit: "another-unit" }]) {
    assert.equal(analyzeTopicLearningTiming(JSON.stringify({ ...input, model: { ...declaration, ...patch } })).status,
      "binding_mismatch");
  }
});

test("quota must be an offered discrete point and bid validation remains canonical", () => {
  const input = request();

  for (const quota of [-1, 0.5, 3]) {
    assert.equal(analyzeTopicLearningTiming(JSON.stringify({ ...input, quota })).status, "invalid_input");
  }

  assert.equal(analyzeTopicLearningTiming(JSON.stringify({ ...input,
    bid: { ...input.bid, questionId: "private-topic-not-in-central-contract" } })).status, "invalid_input");
  assert.equal(analyzeTopicLearningTiming("not json").status, "invalid_input");
});
