import test from "node:test";
import assert from "node:assert/strict";
import { fitNonnegativeCost, predictNonnegativeCost } from "./cost.js";
import { predictBetaBinomialDemand } from "./demand.js";
import { boundExpectedNeedGain } from "./dependence.js";
import type { GaussianLimits, PredictionResult } from "./contracts.js";

const limits: GaussianLimits = { maxObservations: 16, maxLatentDimension: 8, maxQueries: 8, maxComponents: 4 };

function ready<T>(result: PredictionResult<T>): T {
  if (result.status !== "ready") throw new Error(`${result.reason}: ${result.detail}`);
  return result.value;
}

function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) / (1 + Math.abs(expected)) <= 1e-9, `${actual} != ${expected}`);
}

function costInput(): Parameters<typeof fitNonnegativeCost>[0] {
  return { targetKey: "cost-target", resourceUnit: "declared-work", referenceAmount: 1,
    conditionalIndependence: "gate-and-positive-log-given-h", limits,
    receipts: [
      { id: "zero", gateGroupId: "g", sourceRef: "source:zero", revisionRef: "revision:zero", status: "complete", amount: 0 },
      { id: "two", gateGroupId: "g", sourceRef: "source:two", revisionRef: "revision:two", status: "complete", amount: 2 },
      { id: "four", gateGroupId: "g", sourceRef: "source:four", revisionRef: "revision:four", status: "complete", amount: 4 },
      { id: "unknown", gateGroupId: "g", sourceRef: "source:unknown", revisionRef: "revision:unknown", status: "unknown" },
    ],
    hypotheses: [{ id: "h", sourceRef: "prior:declared", priorLogWeight: 0,
      gatePriors: [{ groupId: "g", alpha: 1, beta: 1 }],
      positiveLog: { latentDimension: 1, rowIds: ["two", "four"], observationOffsets: [0, 0],
        observationFactors: [[1], [1]], noise: [[1, 0], [0, 1]] } }],
  };
}

test("cost gate updates only complete receipts and preserves zero versus unknown", () => {
  const fit = ready(fitNonnegativeCost(costInput()));
  // Positive gate is Beta(3,2); this query declares the positive amount as exactly 2.
  const prediction = ready(predictNonnegativeCost(fit, { targetKey: "cost-target", gateGroupId: "g",
    components: [{ hypothesisId: "h", queryOffset: Math.log(2), queryFactor: [0],
      independentPriorFactor: [], logResidualVariance: 0 }] }));

  near(prediction.positiveProbability, 3 / 5);
  near(prediction.zeroProbability, 2 / 5);
  near(prediction.mean, 6 / 5);
  near(prediction.actualVariance, 24 / 25);
  near(prediction.latentMeanVariance, 4 / 25);
  near(prediction.expectedProcessVariance, 20 / 25);
  assert.equal(prediction.joint, "single-query-marginal-only");
});

test("positive log costs use the learned mean and full declared predictive variance", () => {
  const fit = ready(fitNonnegativeCost(costInput()));
  // Prior z~N(0,1), log observations log2/log4 with unit noise give m=log2,v=1/3.
  // A declared independent query factor adds log2-1/3, so total v=log2.
  const prediction = ready(predictNonnegativeCost(fit, { targetKey: "cost-target", gateGroupId: "g",
    components: [{ hypothesisId: "h", queryOffset: 0, queryFactor: [1],
      independentPriorFactor: [Math.sqrt(Math.log(2) - 1 / 3)], logResidualVariance: 0 }] }));

  near(prediction.mean, 6 * Math.sqrt(2) / 5);
  near(prediction.actualVariance, 168 / 25);
  near(prediction.actualVariance, prediction.latentMeanVariance + prediction.expectedProcessVariance);
});

test("invalid or repeated cost receipts do not become zero-cost evidence", () => {
  const input = costInput();
  for (const receipts of [
    [...input.receipts, input.receipts[0]!],
    [{ id: "negative", gateGroupId: "g", sourceRef: "source:negative", revisionRef: "revision:negative",
      status: "complete" as const, amount: -1 }],
  ]) {
    assert.notEqual(fitNonnegativeCost({ ...input, receipts }).status, "ready");
  }
});

test("Beta-binomial demand separates rate uncertainty from future occurrence noise", () => {
  const input = { targetKey: "need-target", referenceUnit: "reference-tasks", sourceRef: "source:counts",
    prior: { alpha: 1, beta: 1, sourceRef: "prior:declared" }, n: 4, k: 1, horizon: 3 };
  const prediction = ready(predictBetaBinomialDemand(input));

  near(prediction.posteriorAlpha, 2);
  near(prediction.posteriorBeta, 4);
  near(prediction.rateMean, 1 / 3);
  near(prediction.rateVariance, 2 / 63);
  near(prediction.mean, 1);
  near(prediction.meanDemandVariance, 2 / 7);
  near(prediction.expectedProcessVariance, 4 / 7);
  near(prediction.actualVariance, 6 / 7);
  assert.equal(prediction.support, "local-observations");
  const priorOnly = ready(predictBetaBinomialDemand({ ...input, n: 0, k: 0, horizon: 0 }));

  assert.equal(priorOnly.support, "prior-only");
  near(priorOnly.mean, 0);
  near(priorOnly.actualVariance, 0);
  const observedZero = ready(predictBetaBinomialDemand({ ...input, k: 0 }));

  assert.equal(observedZero.support, "local-observations");
  near(observedZero.rateMean, 1 / 6);
  assert.notEqual(predictBetaBinomialDemand({ ...input, k: 5 }).status, "ready");
});

test("unrepresentable rare rate moments are not returned as a known zero demand", () => {
  const result = predictBetaBinomialDemand({ targetKey: "rare", referenceUnit: "tasks", sourceRef: "s",
    prior: { alpha: 1e-300, beta: 1e24, sourceRef: "p" }, n: 0, k: 0, horizon: 1e15 });
  if (result.status === "ready") throw new Error("rare_rate_underflow_returned_ready");
  assert.equal(result.status, "unsupported");
  assert.equal(result.reason, "numeric_range");
});

test("need-gain bounds retain signed gains and are attained by opposite couplings", () => {
  const result = ready(boundExpectedNeedGain({ targetKey: "product-target", sourceRef: "source:bounds",
    horizon: 2, needMean: 1, gainMean: 1, gainLower: -1, gainUpper: 3 }));

  // Upper: (N,G)=(0,-1)/(2,3); lower: (0,3)/(2,-1), both with mass 1/2.
  near(result.lower, -1);
  near(result.upper, 3);
  assert.equal(result.joint, "unspecified");
  assert.equal(result.interpretation, "support-and-marginal-mean-identification-bounds");
  assert.notEqual(boundExpectedNeedGain({ targetKey: "product-target", sourceRef: "source:bounds",
    horizon: 2, needMean: 3, gainMean: 1, gainLower: -1, gainUpper: 3 }).status, "ready");
});
