import test from "node:test";
import assert from "node:assert/strict";
import { fitGaussianComponent, predictGaussianComponent } from "./gaussian.js";
import { mixGaussianComponents } from "./mixture.js";
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

test("one observation jointly updates shared and local effects, while new groups retain local uncertainty", () => {
  // beta,u iid N(0,1), y=beta+u+epsilon=3, Var(epsilon)=1.
  const fit = ready(fitGaussianComponent({ latentDimension: 2, observations: [3], observationOffsets: [0],
    observationFactors: [[1, 1]], noise: [[1]], limits }));

  vector(fit.latentMean, [1, 1]);
  near(fit.logEvidence, -.5 * (Math.log(2 * Math.PI) + Math.log(3) + 3));
  const prediction = ready(predictGaussianComponent(fit, {
    queryOffsets: [0, 0, 0, 0], queryFactors: [[1, 1], [1, 0], [1, 0], [1, 0]],
    independentPriorFactors: [[0, 0], [1, 0], [1, 0], [0, 1]], limits,
  }));

  vector(prediction.mean, [2, 1, 1, 1]);
  matrix(prediction.covariance, [
    [2 / 3, 1 / 3, 1 / 3, 1 / 3],
    [1 / 3, 5 / 3, 5 / 3, 2 / 3],
    [1 / 3, 5 / 3, 5 / 3, 2 / 3],
    [1 / 3, 2 / 3, 2 / 3, 5 / 3],
  ]);
});

test("known correlated measurement noise preserves sum and contrast uncertainty", () => {
  const fit = ready(fitGaussianComponent({ latentDimension: 2, observations: [1, -1], observationOffsets: [0, 0],
    observationFactors: [[1, 0], [0, 1]], noise: [[2, 1], [1, 2]], limits }));
  const prediction = ready(predictGaussianComponent(fit, { queryOffsets: [0, 0, 0, 0],
    queryFactors: [[1, 0], [0, 1], [1, 1], [1, -1]], independentPriorFactors: [[], [], [], []], limits }));

  vector(prediction.mean, [.5, -.5, 0, 1]);
  matrix(prediction.covariance, [
    [5 / 8, 1 / 8, 3 / 4, 1 / 2], [1 / 8, 5 / 8, 3 / 4, -1 / 2],
    [3 / 4, 3 / 4, 3 / 2, 0], [1 / 2, -1 / 2, 0, 1],
  ]);
  near(fit.logEvidence, -.5 * (2 * Math.log(2 * Math.PI) + Math.log(8) + 1));

  const negative = ready(fitGaussianComponent({ latentDimension: 2, observations: [1, 1], observationOffsets: [0, 0],
    observationFactors: [[1, 0], [0, 1]], noise: [[2, -1], [-1, 2]], limits }));
  const flipped = ready(predictGaussianComponent(negative, { queryOffsets: [0, 0],
    queryFactors: [[1, 0], [0, 1]], independentPriorFactors: [[], []], limits }));

  vector(flipped.mean, [.5, .5]);
  matrix(flipped.covariance, [[5 / 8, -1 / 8], [-1 / 8, 5 / 8]]);
});

test("finite hypothesis evidence updates weights and retains between-model covariance", () => {
  const components = [1, 4].map((variance, index) => {
    const scale = Math.sqrt(variance);
    const fit = ready(fitGaussianComponent({ latentDimension: 1, observations: [1], observationOffsets: [0],
      observationFactors: [[scale]], noise: [[1]], limits }));

    near(fit.logEvidence, -.5 * (Math.log(2 * Math.PI) + Math.log(1 + variance) + 1 / (1 + variance)));
    const prediction = ready(predictGaussianComponent(fit, { queryOffsets: [0, 0],
      queryFactors: [[scale], [2 * scale]], independentPriorFactors: [[], []], limits }));
    const posteriorVariance = variance / (variance + 1);

    vector(prediction.mean, [posteriorVariance, 2 * posteriorVariance]);
    matrix(prediction.covariance, [[posteriorVariance, 2 * posteriorVariance], [2 * posteriorVariance, 4 * posteriorVariance]]);

    return { id: `h${index + 1}`, logWeight: Math.log(.5) + fit.logEvidence,
      mean: prediction.mean, covarianceFactor: prediction.covarianceFactor };
  });
  const mixed = ready(mixGaussianComponents(components, limits));
  const ratio = Math.sqrt(2 / 5) * Math.exp(3 / 20), w1 = 1 / (1 + ratio), w2 = ratio / (1 + ratio);
  const mean = w1 / 2 + 4 * w2 / 5;
  const variance = w1 / 2 + 4 * w2 / 5 + 9 * w1 * w2 / 100;

  vector(mixed.mean, [mean, 2 * mean]);
  matrix(mixed.covariance, [[variance, 2 * variance], [2 * variance, 4 * variance]]);
  assert.equal(mixed.components.length, 2);
  near(Math.exp(mixed.components[0]!.logWeight), w1);
  near(Math.exp(mixed.components[1]!.logWeight), w2);
});

test("zero observations retain a proper prior and allow singular query covariance", () => {
  const fit = ready(fitGaussianComponent({ latentDimension: 2, observations: [], observationOffsets: [],
    observationFactors: [], noise: [], limits }));

  near(fit.logEvidence, 0);
  const prediction = ready(predictGaussianComponent(fit, { queryOffsets: [0, 0, 0],
    queryFactors: [[1, 0], [1, 0], [0, 0]], independentPriorFactors: [[], [], []], limits }));

  vector(prediction.mean, [0, 0, 0]);
  matrix(prediction.covariance, [[1, 1, 0], [1, 1, 0], [0, 0, 0]]);
});

test("a nonzero factor whose variance underflows is not reported as known zero", () => {
  const fit = ready(fitGaussianComponent({ latentDimension: 0, observations: [], observationOffsets: [],
    observationFactors: [], noise: [], limits }));
  const result = predictGaussianComponent(fit, { queryOffsets: [0], queryFactors: [[]],
    independentPriorFactors: [[1e-200]], limits });
  if (result.status === "ready") throw new Error("nonzero_variance_underflow_returned_ready");

  assert.equal(result.status, "unsupported");
  assert.equal(result.reason, "numeric_range");
});

test("asymmetric or singular measurement noise is rejected without changing the model", () => {
  for (const noise of [[[1, .5], [0, 1]], [[1, 1], [1, 1]]]) {
    const result = fitGaussianComponent({ latentDimension: 2, observations: [1, -1], observationOffsets: [0, 0],
      observationFactors: [[1, 0], [0, 1]], noise, limits });
    assert.notEqual(result.status, "ready");
    if (result.status === "ready") throw new Error("unsupported_noise_accepted");
    assert.ok(result.reason.length > 0);
  }
});
