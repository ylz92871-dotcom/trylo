import test from "node:test";
import assert from "node:assert/strict";
import { buildCentralResponseForecast } from "./prediction-model.js";
import type { CentralResponseForecastInput, CentralResponseHistory, CentralResponseOpportunity } from "./prediction-input.js";

function opportunity(id: string, policyRef = "policy:tool-research-v1"): CentralResponseOpportunity {
  return { opportunityId: id, scope: "project:one", targetRef: "learning-window-effect-v1", instanceRef: `stage:${id}`,
    sourceRef: `source:${id}`, stage: "initial", conditionRef: "condition:typescript-npm", baselineRef: `baseline:${id}`,
    windowRef: "one-registered-deployment-window-v1", offer: { offerId: `offer:${id}`, owner: { plane: "agent", domain: "tool" },
      policyRef, reserve: { tokens: 4096, calls: 2, steps: 2 }, maxPromptChars: 16000 } };
}

function input(values = [-2, 2, 3]): CentralResponseForecastInput {
  const current = opportunity("current");
  return { basis: { scope: current.scope, boardSequence: 20, budgetId: "budget:one", utilityUnit: "verified-window-utility-v1", valuationRef: "valuation:one" },
    target: { key: current.targetRef, utilityUnit: "verified-window-utility-v1", referenceKey: "registered-deployment-cohort-v1",
      baselineRuleKey: "keep-existing-capability-v1", windowRef: current.windowRef },
    opportunities: [current], history: values.map((value, index) => ({ ...opportunity(`history-${index}`), unitId: `unit:${index}`,
      sequence: index + 1, revisionRef: `revision:${index}`, outcome: { kind: "paired_window", candidateUtility: value, baselineUtility: 0 } })),
    limits: { maxObservations: 32, maxQueries: 8, maxLatentDimension: 8, maxComponents: 2 } };
}

function forecast(source: CentralResponseForecastInput) {
  const result = buildCentralResponseForecast(source);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") throw new Error("forecast_not_ready");
  return result.value;
}

function near(actual: number | null, expected: number) {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(actual! - expected) < 1e-12, `${actual} != ${expected}`);
}

test("source-derived calibration and later feedback jointly update the existing response predictor", () => {
  const source = input(), before = JSON.stringify(source), result = forecast(source), row = result.queries[0]!;

  // Independent normal-normal oracle: prior N(0,4), y=3 with R=8 => N(1,8/3).
  near(row.mean, 1);
  near(row.variance, 8 / 3);
  near(row.processVariance, 8);
  assert.deepEqual(row.calibrationUnitIds, ["unit:0", "unit:1"]);
  assert.deepEqual(row.updateUnitIds, ["unit:2"]);
  assert.equal(row.support, "updated_history");
  assert.equal(JSON.stringify(source), before);
  const revised = forecast({ ...source, history: source.history.map((item, index) => index !== 2 ? item
    : { ...item, revisionRef: "revision:corrected", outcome: { kind: "paired_window", baselineUtility: 0, candidateUtility: -3 } }) });

  near(revised.queries[0]!.mean, -1);
  assert.notEqual(revised.forecastRef, result.forecastRef);
});

test("late corrections update a calibration value without replacing the original episode's calibration role", () => {
  const source = input(), history = source.history.map((row, index) => ({ ...row, episodeSequence: row.sequence,
    ...(index === 0 ? { sequence: 10, revisionRef: "revision:late-calibration-correction",
      outcome: { kind: "paired_window" as const, candidateUtility: -4, baselineUtility: 0 } } : {}) }));
  const result = forecast({ ...source, history }), row = result.queries[0]!;

  assert.deepEqual(row.calibrationUnitIds, ["unit:0", "unit:1"]);
  assert.deepEqual(row.updateUnitIds, ["unit:2"]);
  // Corrected calibration N(-1,9), y=3 with R=18 gives N(1/3,6).
  near(row.mean, 1 / 3);
  near(row.variance, 6);
  near(row.processVariance, 18);
  assert.equal(buildCentralResponseForecast({ ...source, basis: { ...source.basis, boardSequence: 9 }, history }).status, "invalid");
});

test("current comparable policies share uncertainty; cross-policy dependency remains unknown", () => {
  const source = input(), other = opportunity("other", "policy:workflow-compile-v1");
  const extra: CentralResponseHistory[] = source.history.map(row => ({ ...row, offer: { ...row.offer, policyRef: other.offer.policyRef },
    unitId: `other:${row.unitId}` }));
  const result = forecast({ ...source, opportunities: [source.opportunities[0]!, opportunity("same"), other], history: [...source.history, ...extra] });

  near(result.joint.covariance[0]![1]!, 8 / 3);
  assert.equal(result.joint.covariance[0]![2], null);
  assert.equal(result.queries[2]!.offer.policyRef, other.offer.policyRef);
});

test("missing, pending and degenerate calibration require specific evidence rather than inventing value", () => {
  for (const values of [[], [1], [1, 1]]) {
    const result = forecast(input(values));
    assert.deepEqual(result.queries, []);
    assert.equal(result.requirements[0]!.reason, values.length < 2 ? "paired_history_missing" : "history_variance_unidentified");
  }

  const source = input(), pending: CentralResponseHistory = { ...opportunity("pending"), unitId: "pending", sequence: 4,
    revisionRef: "pending:one", outcome: { kind: "unknown", reason: "feedback-window-open" } };
  const result = forecast({ ...source, history: [...source.history, pending] });

  assert.deepEqual(result.queries, []);
  assert.equal(result.requirements[0]!.reason, "pending_feedback");
});

test("duplicate independent units and mismatched target/basis are rejected at the boundary", () => {
  const source = input();
  for (const bad of [
    { ...source, history: [...source.history, source.history[0]!] },
    { ...source, opportunities: [{ ...source.opportunities[0]!, windowRef: "other-window" }] },
    { ...source, basis: { ...source.basis, boardSequence: 1 } },
    { ...source, target: { ...source.target, utilityUnit: "other-unit" } },
  ]) assert.equal(buildCentralResponseForecast(bad).status, "invalid");
});

