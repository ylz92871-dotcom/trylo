import test from "node:test";
import assert from "node:assert/strict";
import { buildEmpiricalCentralResponseForecast } from "./prediction-empirical.js";
import type { CentralResponseForecastInput, CentralResponseHistory, CentralResponseOpportunity } from "./prediction-input.js";

function opportunity(id: string): CentralResponseOpportunity {
  return { opportunityId: id, scope: "project:empirical", targetRef: "target:empirical", instanceRef: `stage:${id}`, sourceRef: `source:${id}`,
    stage: "initial", conditionRef: "condition:one", baselineRef: `baseline:${id}`, windowRef: "window:legacy",
    offer: { offerId: `offer:${id}`, owner: { plane: "agent", domain: "tool" }, policyRef: "policy:v1",
      reserve: { tokens: 1000, calls: 1, steps: 1 }, maxPromptChars: 4000 } };
}

function input(values: readonly (number | null)[]): CentralResponseForecastInput {
  return { basis: { scope: "project:empirical", boardSequence: 20, budgetId: "budget:empirical", utilityUnit: "utility:window-effect",
    valuationRef: "valuation:empirical" }, target: { key: "target:empirical", utilityUnit: "utility:window-effect", referenceKey: "population:registered",
      baselineRuleKey: "baseline:frozen", windowRef: "window:legacy" }, opportunities: [opportunity("current")],
    history: values.map((value, index): CentralResponseHistory => ({ ...opportunity(`history:${index}`), unitId: `unit:${index}`,
      revisionRef: `revision:${index}`, sequence: index + 1, outcome: value === null ? { kind: "unknown", reason: "awaiting_feedback" }
        : { kind: "paired_window", candidateUtility: value, baselineUtility: 0 } })),
    limits: { maxObservations: 16, maxQueries: 8, maxLatentDimension: 1, maxComponents: 1 } };
}

function forecast(source: CentralResponseForecastInput) {
  const result = buildEmpiricalCentralResponseForecast(source);
  if (result.status !== "ready") throw new Error(result.reason);
  return result.value;
}

test("one complete v1 effect supplies an explicit empirical working point without a variance claim", () => {
  const result = forecast(input([-.5])), query = result.queries[0]!;
  assert.equal(query.mean, -.5);
  assert.equal(query.support, "empirical_history");
  assert.equal(query.variance, null);
  assert.equal(query.processVariance, null);
  assert.equal(query.population, 1);
  assert.equal(query.pending, 0);
  assert.deepEqual(query.updateUnitIds, ["unit:0"]);
  assert.ok(result.modelAssumptions!.some(text => text.includes("exchangeability")));
});

test("unbounded pending stays in population metadata but is never imputed into the complete sample mean", () => {
  const result = forecast(input([-.5, null])), query = result.queries[0]!;
  assert.equal(query.mean, -.5);
  assert.equal(query.population, 2);
  assert.equal(query.pending, 1);
  assert.equal(query.pendingMeanRange, undefined);
  assert.equal(query.variance, null);
  assert.deepEqual(result.requirements, []);
});

test("zero complete observations remain unvalued while a known zero effect and an available Gaussian stay distinct", () => {
  assert.deepEqual(forecast(input([null])).queries, []);
  assert.deepEqual(forecast(input([])).queries, []);
  const observedZero = forecast(input([0])).queries[0]!;
  assert.equal(observedZero.mean, 0);
  assert.equal(observedZero.support, "empirical_history");
  assert.equal(observedZero.variance, null);
  const gaussian = forecast(input([.2, .4])).queries[0]!;
  assert.equal(gaussian.support, "calibrated_history");
  assert.notEqual(gaussian.variance, null);
  assert.deepEqual(gaussian.calibrationUnitIds, ["unit:0", "unit:1"]);
});

test("a revised complete history changes the empirical point without adding a duplicate sample", () => {
  const source = input([-.25, -.25]), before = forecast(source), revised = forecast({ ...source,
    history: source.history.map((row, index) => index === 1 ? { ...row, revisionRef: "revision:corrected",
      outcome: { kind: "paired_window", candidateUtility: .25, baselineUtility: 0 } } : row) });

  assert.equal(before.queries[0]!.mean, -.25);
  // The repaired data now admits the original nonzero-noise Gaussian path.
  assert.equal(revised.queries[0]!.support, "calibrated_history");
  assert.ok(Math.abs(revised.queries[0]!.mean) < 1e-12);
  assert.notEqual(revised.forecastRef, before.forecastRef);
});
