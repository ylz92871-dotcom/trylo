import test from "node:test";
import assert from "node:assert/strict";
import { fitSchedulingResponse, rebuildSchedulingResponse, predictSchedulingResponse } from "./index.js";
import type { GaussianLimits, NumericMatrix, NumericVector, PredictionResult } from "./contracts.js";

const limits: GaussianLimits = { maxObservations: 16, maxLatentDimension: 8, maxQueries: 8, maxComponents: 4 };

function ready<T>(result: PredictionResult<T>): T {
  if (result.status !== "ready") throw new Error(`${result.reason}: ${result.detail}`);
  return result.value;
}

function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) / (1 + Math.abs(expected)) <= 1e-9, `${actual} != ${expected}`);
}

function vector(actual: NumericVector, expected: NumericVector): void {
  assert.equal(actual.length, expected.length);
  expected.forEach((value, index) => near(actual[index]!, value));
}

function matrix(actual: NumericMatrix, expected: NumericMatrix): void {
  assert.equal(actual.length, expected.length);
  expected.forEach((row, index) => vector(actual[index]!, row));
}

function input(): Parameters<typeof fitSchedulingResponse>[0] {
  return { target: { key: "response-family", unit: "declared-utility", stage: "initial",
    referenceKey: "reference-tasks", baselineRuleKey: "continue-current", consumerKey: "consumer-v1" },
    featureMap: { key: "features-v1", sourceRef: "features:declared", sharedNames: ["intercept"], localNames: ["unit"] },
    observations: [{ id: "effect-one", revisionRef: "revision:one", sourceRef: "source:one", targetKey: "response-family",
      featureMapKey: "features-v1", instanceRef: "preK-one", baselineRef: "baseline-one", group: "old",
      sharedFeatures: [1], localFeatures: [1], value: 3 }],
    hypotheses: [{ id: "h", logPriorWeight: 0, sourceRef: "prior:declared", noiseSourceRef: "noise:qualified",
      sharedMean: [0], sharedFactor: [[1]], localFactor: [[1]], noise: [[1]] }], limits };
}

function queries(): Parameters<typeof predictSchedulingResponse>[1]["queries"] {
  return ["old", "new-one", "new-one", "new-two"].map((group, index) => ({ id: `query-${index}`,
    targetKey: "response-family", featureMapKey: "features-v1", instanceRef: `currentK-${index}`,
    baselineRef: `current-baseline-${index}`, group, sharedFeatures: [1], localFeatures: [1] }));
}

test("public response entry learns shared and local effects without equating baseline instances", () => {
  const source = input(), unchanged = JSON.stringify(source), requested = queries();
  const fit = ready(fitSchedulingResponse(source));
  const prediction = ready(predictSchedulingResponse(fit, { queries: requested }));

  vector(prediction.mean, [2, 1, 1, 1]);
  matrix(prediction.covariance, [
    [2 / 3, 1 / 3, 1 / 3, 1 / 3], [1 / 3, 5 / 3, 5 / 3, 2 / 3],
    [1 / 3, 5 / 3, 5 / 3, 2 / 3], [1 / 3, 2 / 3, 2 / 3, 5 / 3],
  ]);
  assert.equal(prediction.interpretation, "latent-conditional-response");
  assert.deepEqual(prediction.queries.map(query => query.id), requested.map(query => query.id));
  assert.equal(prediction.queries[0]!.support, "local-observations");
  assert.equal(prediction.queries[1]!.support, "declared-transfer");
  assert.equal(JSON.stringify(source), unchanged);
  const rebuilt = ready(rebuildSchedulingResponse(source));

  assert.deepEqual(ready(predictSchedulingResponse(rebuilt, { queries: requested })), prediction);
});

test("rebuilding with one effective revision replaces its value instead of adding another trial", () => {
  const original = input();
  const corrected = { ...original, observations: original.observations.map(row => ({ ...row,
    revisionRef: "revision:corrected", sourceRef: "source:correction", value: 0 })) };
  const prediction = ready(predictSchedulingResponse(ready(rebuildSchedulingResponse(corrected)), { queries: queries() }));

  vector(prediction.mean, [0, 0, 0, 0]);
  near(prediction.covariance[0]![0]!, 2 / 3);
  near(prediction.covariance[1]![1]!, 5 / 3);
  const duplicated = { ...original, observations: [...original.observations, ...corrected.observations],
    hypotheses: original.hypotheses.map(hypothesis => ({ ...hypothesis, noise: [[1, 0], [0, 1]] })) };

  assert.notEqual(fitSchedulingResponse(duplicated).status, "ready");
});

test("qualified target and feature bindings reject mismatches and non-finite measurements", () => {
  const original = input();

  for (const observations of [
    original.observations.map(row => ({ ...row, targetKey: "another-target" })),
    original.observations.map(row => ({ ...row, featureMapKey: "another-map" })),
    original.observations.map(row => ({ ...row, value: Number.NaN })),
  ]) {
    assert.notEqual(fitSchedulingResponse({ ...original, observations }).status, "ready");
  }

  const fit = ready(fitSchedulingResponse(original));

  assert.notEqual(predictSchedulingResponse(fit, { queries: queries().map(query => ({ ...query, targetKey: "another-target" })) }).status, "ready");
});

test("no observations retains the caller prior and reports prior-only support", () => {
  const original = input();
  const fit = ready(fitSchedulingResponse({ ...original, observations: [],
    hypotheses: original.hypotheses.map(hypothesis => ({ ...hypothesis, noise: [] })) }));
  const prediction = ready(predictSchedulingResponse(fit, { queries: [queries()[0]!] }));

  vector(prediction.mean, [0]);
  matrix(prediction.covariance, [[2]]);
  assert.equal(prediction.queries[0]!.support, "prior-only");
});
