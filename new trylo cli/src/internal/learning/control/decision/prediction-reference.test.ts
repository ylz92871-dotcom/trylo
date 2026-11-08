import test from "node:test";
import assert from "node:assert/strict";
import { buildReferenceCentralResponseForecast } from "./prediction-reference.js";
import type { CentralResponseFamilyBinding } from "./prediction-reference.js";
import type { CentralResponseForecastInput, CentralResponseHistory, CentralResponseOpportunity } from "./prediction-input.js";
import { summarizeCentralEffectSupport } from "./effect-support.js";

const reference = { minimum: -1, maximum: 1, sourceRef: "objective:window-effect-support" };

function opportunity(id: string, policyRef = "policy:v1"): CentralResponseOpportunity {
  return { opportunityId: id, scope: "project:reference", targetRef: "target:reference", instanceRef: `stage:${id}`,
    sourceRef: `source:${id}`, stage: "initial", conditionRef: "condition:one", baselineRef: `baseline:${id}`, windowRef: "window:fixed",
    offer: { offerId: `offer:${id}`, owner: { plane: "agent", domain: "tool" }, policyRef,
      reserve: { tokens: 1000, calls: 1, steps: 1 }, maxPromptChars: 4000 } };
}

function input(values: readonly (number | null)[]): CentralResponseForecastInput {
  return { basis: { scope: "project:reference", boardSequence: 20, budgetId: "budget:reference", utilityUnit: "window-effect",
    valuationRef: "valuation:reference" }, target: { key: "target:reference", utilityUnit: "window-effect", referenceKey: "population:one",
      baselineRuleKey: "rule:frozen-baseline", windowRef: "window:fixed" }, opportunities: [opportunity("current")],
    history: values.map((value, index): CentralResponseHistory => ({ ...opportunity(`history:${index}`), unitId: `unit:${index}`,
      revisionRef: `revision:${index}`, sequence: index + 1,
      outcome: value === null ? { kind: "unknown", reason: "awaiting_feedback" }
        : { kind: "paired_window", candidateUtility: value, baselineUtility: 0 } })),
    limits: { maxObservations: 16, maxQueries: 8, maxLatentDimension: 8, maxComponents: 1 } };
}

function forecast(source: CentralResponseForecastInput, bounds = reference, familyBindings: readonly CentralResponseFamilyBinding[] = []) {
  const result = buildReferenceCentralResponseForecast(source, bounds, undefined, familyBindings);
  if (result.status !== "ready") throw new Error(`${result.status}:${result.reason}`);
  return result.value;
}

function near(actual: number | null, expected: number) {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(actual! - expected) < 1e-12, `${actual} != ${expected}`);
}

test("a first opportunity receives an explicit proper working reference without fabricated observed samples", () => {
  const source = input([]), before = JSON.stringify(source), result = forecast(source), row = result.queries[0]!;
  near(row.mean, 0);
  near(row.variance, 1 / 3);
  near(row.processVariance, 1);
  assert.equal(row.support, "bounded_reference_prior");
  assert.equal(row.population, 0);
  assert.equal(row.pending, 0);
  assert.deepEqual(row.calibrationUnitIds, []);
  assert.deepEqual(row.updateUnitIds, []);
  assert.ok(result.modelAssumptions!.some(text => text.includes("not an observed frequency")));
  assert.equal(JSON.stringify(source), before);
});

test("one complete fact and identical later facts update the original predictor once each without a variance gate", () => {
  // ν=1, v0=1/3: first y=1 gives N(1/4,1/4); two y=1 give N(2/5,1/5).
  const one = forecast(input([1])).queries[0]!, two = forecast(input([1, 1])).queries[0]!;
  near(one.mean, .25);
  near(one.variance, .25);
  near(two.mean, .4);
  near(two.variance, .2);
  assert.equal(two.support, "updated_bounded_reference");
  assert.deepEqual(two.updateUnitIds, ["unit:0", "unit:1"]);
  assert.deepEqual(two.calibrationUnitIds, []);
});

test("pending windows preserve a completion mean range without replacing unknown responses by zero", () => {
  const result = forecast(input([1, null])), row = result.queries[0]!;
  near(row.mean, .25);
  assert.equal(row.population, 2);
  assert.equal(row.pending, 1);
  near(row.pendingMeanRange![0], 0);
  near(row.pendingMeanRange![1], .4);
  assert.deepEqual(row.updateUnitIds, ["unit:0"]);
});

test("actual partial-window bounds narrow the pending completion range while leaving the revealed-only point conditional", () => {
  const source = input([1, null]), pending = source.history[1]!;
  const partial = summarizeCentralEffectSupport({ target: source.target, comparisonsPerWindow: 1,
    deltaBounds: { minimum: .5, maximum: 1, sourceRef: "source:pending-effect-range" }, windows: [{ unitId: pending.unitId,
      revisionRef: pending.revisionRef, sourceRef: pending.sourceRef, comparisonIds: ["comparison:pending"], measurements: [] }] });
  if (partial.status !== "ready") throw new Error("partial_support_not_ready");

  const result = buildReferenceCentralResponseForecast(source, reference, partial.value);
  if (result.status !== "ready") throw new Error(result.reason);

  const row = result.value.queries[0]!;

  near(row.mean, .25);
  near(row.pendingMeanRange![0], .3);
  near(row.pendingMeanRange![1], .4);
  assert.ok(row.sourceRefs.includes("source:pending-effect-range"));
});

test("only source-declared same-response families transfer across changed policy or resource envelopes", () => {
  const original = input([1, 1]), current = opportunity("current", "policy:v2");
  const source = { ...original, opportunities: [{ ...current, offer: { ...current.offer, reserve: { tokens: 2000, calls: 2, steps: 2 } } }] };

  near(forecast(source).queries[0]!.mean, 0);
  const bindings = [...source.history, ...source.opportunities].map(row => ({ instanceRef: row.instanceRef,
    familyRef: "response-family:equivalent-selector", sourceRef: "host:policy-equivalence" }));
  const result = forecast(source, reference, bindings), row = result.queries[0]!;

  near(row.mean, .4);
  assert.equal(row.offer.policyRef, "policy:v2");
  assert.equal(row.offer.reserve.tokens, 2000);
  assert.ok(row.sourceRefs.includes("host:policy-equivalence"));
  const differentCondition = { ...source, opportunities: [{ ...source.opportunities[0]!, conditionRef: "condition:other" }] };

  near(forecast(differentCondition, reference, bindings).queries[0]!.mean, 0);
});

test("a genuine hard point support is deterministic but must agree with every known response", () => {
  const hard = { minimum: .25, maximum: .25, sourceRef: "objective:hard-point-support" };
  const row = forecast(input([.25, null]), hard).queries[0]!;
  near(row.mean, .25);
  assert.equal(row.variance, 0);
  assert.equal(row.processVariance, 0);
  assert.deepEqual(row.pendingMeanRange, [.25, .25]);
  assert.equal(buildReferenceCentralResponseForecast(input([.5]), hard).status, "invalid");
});

test("effective revisions rebuild the posterior instead of adding duplicate evidence", () => {
  const source = input([1]), original = forecast(source), revised = forecast({ ...source, history: [{ ...source.history[0]!,
    revisionRef: "revision:corrected", outcome: { kind: "paired_window", candidateUtility: -1, baselineUtility: 0 } }] });
  near(revised.queries[0]!.mean, -.25);
  assert.equal(revised.queries[0]!.population, 1);
  assert.notEqual(revised.forecastRef, original.forecastRef);
  assert.equal(buildReferenceCentralResponseForecast({ ...source, history: [source.history[0]!, source.history[0]!] }, reference).status, "invalid");
});

test("source contradictions and nonrepresentable working variances fail explicitly without jitter", () => {
  assert.equal(buildReferenceCentralResponseForecast(input([2]), reference).status, "invalid");
  assert.equal(buildReferenceCentralResponseForecast(input([]), { minimum: 0, maximum: 3e-162,
    sourceRef: "objective:tiny-nonzero-support" }).status, "unsupported");
  assert.equal(buildReferenceCentralResponseForecast(input([]), reference, undefined, [{ instanceRef: "stage:current",
    familyRef: "family:a", sourceRef: "source:a" }, { instanceRef: "stage:current", familyRef: "family:b", sourceRef: "source:b" }]).status, "invalid");
});
