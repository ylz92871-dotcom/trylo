import test from "node:test";
import assert from "node:assert/strict";
import { buildCentralInterceptEvidence } from "./prediction-intercept.js";
import { buildCentralResponseForecast } from "./prediction-model.js";
import { buildReferenceCentralResponseForecast } from "./prediction-reference.js";
import { fitSchedulingResponse, predictSchedulingResponse } from "../prediction/index.js";
import type { ResponseObservation } from "../prediction/response-contracts.js";
import type { CentralResponseForecastInput, CentralResponseHistory, CentralResponseOpportunity } from "./prediction-input.js";

function observation(id: string, value: number): ResponseObservation {
  return { id, revisionRef: `revision:${id}`, sourceRef: `source:${id}`, targetKey: "target:intercept", featureMapKey: "map:intercept",
    instanceRef: `instance:${id}`, baselineRef: `baseline:${id}`, group: "one-class", sharedFeatures: [1], localFeatures: [], value };
}

function opportunity(id: string): CentralResponseOpportunity {
  return { opportunityId: id, scope: "project:intercept", targetRef: "target:intercept", instanceRef: `stage:${id}`, sourceRef: `source:${id}`,
    stage: "initial", conditionRef: "condition:one", baselineRef: `baseline:${id}`, windowRef: "window:fixed",
    offer: { offerId: `offer:${id}`, owner: { plane: "agent", domain: "tool" }, policyRef: "policy:one",
      reserve: { tokens: 1000, calls: 1, steps: 1 }, maxPromptChars: 4000 } };
}

function input(values: readonly number[], maxObservations: number): CentralResponseForecastInput {
  return { basis: { scope: "project:intercept", boardSequence: 10000, budgetId: "budget:one", utilityUnit: "utility:window-effect",
    valuationRef: "valuation:one" }, target: { key: "target:intercept", utilityUnit: "utility:window-effect", referenceKey: "population:registered",
      baselineRuleKey: "baseline:frozen", windowRef: "window:fixed" }, opportunities: [opportunity("current")],
    history: values.map((value, index): CentralResponseHistory => ({ ...opportunity(`past:${index}`), unitId: `unit:${index}`,
      revisionRef: `revision:${index}`, sequence: index + 1, outcome: { kind: "paired_window", candidateUtility: value, baselineUtility: 0 } })),
    limits: { maxObservations, maxQueries: 8, maxLatentDimension: 1, maxComponents: 1 } };
}

function near(actual: number | null, expected: number) {
  assert.notEqual(actual, null);
  if (actual === null) throw new Error("expected_numeric_posterior");
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}

test("one exact intercept mean preserves all raw observations while respecting the original kernel row cap", () => {
  const rows = [observation("a", 0), observation("b", 2), observation("c", 4)], original = JSON.stringify(rows);
  const result = buildCentralInterceptEvidence(rows, 2, 2);
  if (result.status !== "ready") throw new Error(result.reason);
  assert.equal(result.value.reduction, "one_exact_intercept_mean");
  assert.equal(result.value.fullObservationCount, 3);
  assert.equal(result.value.observations.length, 1);
  assert.equal(result.value.observations[0]!.value, 2);
  near(result.value.noise[0]![0]!, 2 / 3);
  assert.equal(JSON.stringify(rows), original);
});

test("one observation uses the same single-row likelihood with explicit sufficient-statistic identity", () => {
  const rows = [observation("a", 2)], result = buildCentralInterceptEvidence(rows, 2, 2);
  if (result.status !== "ready") throw new Error(result.reason);
  assert.equal(result.value.reduction, "one_exact_intercept_mean");
  assert.equal(result.value.fullObservationCount, 1);
  assert.equal(result.value.observations[0]!.value, 2);
  assert.deepEqual(result.value.noise, [[2]]);
  assert.match(result.value.observations[0]!.id, /^response-sufficient-mean:/);
});

test("v1 fixed first-pair calibration keeps its posterior when later history exceeds the dense work cap", () => {
  const source = input([0, 2, 4, 6, 8], 2), compressed = buildCentralResponseForecast(source);
  if (compressed.status !== "ready") throw new Error("v1_posterior_not_ready");

  const dense = fitSchedulingResponse({ target: { key: source.target.key, unit: source.target.utilityUnit, stage: "initial",
    referenceKey: source.target.referenceKey, baselineRuleKey: source.target.baselineRuleKey, consumerKey: source.target.windowRef },
    featureMap: { key: "map:intercept", sourceRef: "source:independent-dense-oracle", sharedNames: ["intercept"], localNames: [] },
    observations: [4, 6, 8].map((value, index) => observation(`dense:${index}`, value)),
    hypotheses: [{ id: "one-fixed", logPriorWeight: 0, sourceRef: "source:prior", noiseSourceRef: "source:fixed-R",
      sharedMean: [1], sharedFactor: [[1]], localFactor: [], noise: [[2, 0, 0], [0, 2, 0], [0, 0, 2]] }],
    limits: { maxObservations: 8, maxQueries: 8, maxLatentDimension: 1, maxComponents: 1 } });
  if (dense.status !== "ready") throw new Error(dense.reason);

  const direct = predictSchedulingResponse(dense.value, { queries: [{ id: "dense-query", targetKey: source.target.key,
    featureMapKey: "map:intercept", instanceRef: "instance:current", baselineRef: "baseline:current", group: "one-class",
    sharedFeatures: [1], localFeatures: [] }] });
  if (direct.status !== "ready") throw new Error(direct.reason);

  const row = compressed.value.queries[0]!;

  // N(1,1) prior and y=(4,6,8), R=2: precision=1+3/2, posterior N(4,2/5).
  near(row.mean, 4);
  near(row.variance, .4);
  near(row.mean, direct.value.mean[0]!);
  near(row.variance, direct.value.covariance[0]![0]!);
  assert.deepEqual(row.calibrationUnitIds, ["unit:0", "unit:1"]);
  assert.deepEqual(row.updateUnitIds, ["unit:2", "unit:3", "unit:4"]);
  assert.ok(compressed.value.modelAssumptions!.some(text => text.includes("not measured known true")));
});

test("513 qualified reference responses and a later update remain usable without increasing Gaussian work limits", () => {
  const reference = { minimum: -1, maximum: 1, sourceRef: "source:whole-window-bounds" };
  const source = input(Array.from({ length: 513 }, () => .5), 512), result = buildReferenceCentralResponseForecast(source, reference);
  if (result.status !== "ready") throw new Error(result.reason);

  const row = result.value.queries[0]!;

  // R=1, prior precision=3, sum(y)=513/2; all rows still contribute.
  near(row.mean, (513 / 2) / 516);
  near(row.variance, 1 / 516);
  assert.equal(row.updateUnitIds.length, 513);
  assert.equal(row.population, 513);
  assert.equal(source.limits.maxObservations, 512);
  const later = buildReferenceCentralResponseForecast(input([...Array.from({ length: 513 }, () => .5), -1], 512), reference);
  if (later.status !== "ready") throw new Error(later.reason);

  near(later.value.queries[0]!.mean, (513 / 2 - 1) / 517);
  near(later.value.queries[0]!.variance, 1 / 517);
  assert.equal(later.value.queries[0]!.updateUnitIds.length, 514);
  assert.notEqual(later.value.forecastRef, result.value.forecastRef);
});

test("a reduced-noise underflow or zero available kernel slots cannot become a false deterministic fit", () => {
  const rows = [observation("a", 0), observation("b", 0)];
  const underflow = buildCentralInterceptEvidence(rows, Number.MIN_VALUE, 1);

  assert.equal(underflow.status, "unsupported");

  if (underflow.status === "unsupported") assert.equal(underflow.reason, "central_intercept_noise_underflow");

  assert.equal(buildCentralInterceptEvidence(rows, 1, 0).status, "unsupported");
  assert.equal(buildCentralResponseForecast(input([0, 2], 0)).status, "unsupported");
  assert.equal(buildReferenceCentralResponseForecast(input([.5], 0), { minimum: -1, maximum: 1, sourceRef: "source:bounds" }).status, "unsupported");
});
