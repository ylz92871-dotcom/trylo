import test from "node:test";
import assert from "node:assert/strict";
import { buildReferenceCentralResponseForecast } from "./prediction-reference.js";
import { centralResponseTimingTarget } from "./response-timing.js";
import { analyzeCentralOpportunityTiming } from "./timing-model.js";
import type { CentralResponseForecastInput, CentralResponseForecastQuery } from "./prediction-input.js";
import type { CentralTimingTarget } from "./timing-contract.js";

const deadline: Extract<CentralTimingTarget, { kind: "deadline" }> = { kind: "deadline", sourceRef: "source:fixed-use-deadline",
  useBy: 106, durationUpperBound: 4, durationSourceRef: "source:duration-upper-four" };

function prediction() {
  const opportunity = { opportunityId: "opportunity:response-timing", scope: "project:response-timing", targetRef: "target:window",
    instanceRef: "stage:current", sourceRef: "source:stage", stage: "initial" as const, conditionRef: "condition:one",
    baselineRef: "baseline:frozen-current", windowRef: "window:fixed-use", offer: { offerId: "offer:current",
      owner: { plane: "agent" as const, domain: "tool" as const }, policyRef: "policy:response-timing",
      reserve: { tokens: 1000, calls: 1, steps: 1 }, maxPromptChars: 4000 } };
  const input: CentralResponseForecastInput = { basis: { scope: opportunity.scope, boardSequence: 2, budgetId: "budget:response-timing",
    utilityUnit: "utility:whole-window-effect", valuationRef: "valuation:source-window" },
    target: { key: opportunity.targetRef, utilityUnit: "utility:whole-window-effect", referenceKey: "population:registered-windows",
      baselineRuleKey: "rule:frozen-baseline", windowRef: opportunity.windowRef }, opportunities: [opportunity],
    history: [{ ...opportunity, opportunityId: "opportunity:past", instanceRef: "stage:past", sourceRef: "source:past",
      unitId: "unit:pending", revisionRef: "revision:pending", sequence: 1, outcome: { kind: "unknown", reason: "awaiting_feedback" } }],
    limits: { maxObservations: 8, maxQueries: 8, maxLatentDimension: 1, maxComponents: 1 } };
  const result = buildReferenceCentralResponseForecast(input, { minimum: 0, maximum: 1, sourceRef: "source:actual-whole-window-support" });
  if (result.status !== "ready") throw new Error(result.reason);

  return result.value;
}

function analyze(query: CentralResponseForecastQuery, target: CentralTimingTarget = deadline) {
  const forecast = prediction();
  return analyzeCentralOpportunityTiming({ schemaVersion: 1, opportunityId: query.opportunityId, windowRef: query.windowRef,
    forecastRef: forecast.forecastRef, mean: query.mean, basis: forecast.basis, offer: query.offer,
    readiness: { kind: "ready", sourceRef: "business:current-boundary", now: 100,
      nextHandoff: { at: 105, sourceRef: "business:actual-handoff" } },
    target: centralResponseTimingTarget(query, target),
    fee: { kind: "utility", sourceRef: "objective:business-interference", now: 0, atHandoff: .75 } });
}

test("a sourced response bound certifies now against an unresolved deferred completion in the actual timing kernel", () => {
  const query = prediction().queries[0]!, result = analyze(query);
  if (result.status !== "ready") throw new Error(result.reason);

  assert.equal(result.advice, "now");
  assert.equal(result.netValue, .5);
  assert.ok(result.analysis?.firstControlCertificate.nonInferior.includes("now"));
  const deferred = result.model?.contexts[0]!.actions.find(action => action.id === "defer");
  if (deferred?.kind !== "closed_upper_frontier") throw new Error("deferred_support_frontier_missing");

  assert.equal(deferred.upper, .25);
  assert.equal(deferred.frontierScopeRef, "source:actual-whole-window-support");
  assert.ok(result.sourceRefs.includes("source:actual-whole-window-support"));
});

test("parameter variance and pending completion means cannot replace an absent actual gross support", () => {
  const query = prediction().queries[0]!;
  const { grossSupport, ...withoutGrossSupport } = query;

  assert.ok(grossSupport);
  assert.ok(withoutGrossSupport.pendingMeanRange);
  assert.notEqual(withoutGrossSupport.variance, null);
  const result = analyze(withoutGrossSupport);
  if (result.status !== "ready") throw new Error(result.reason);

  assert.equal(result.advice, "requires_model");
  assert.equal(result.netValue, null);
  assert.ok(result.requirements.includes("gross_support_missing"));
  assert.equal(result.analysis, null);
});

test("a caller's explicit legal-family support remains authoritative and changes the timing comparison", () => {
  const query = prediction().queries[0]!, explicit: Extract<CentralTimingTarget, { kind: "deadline" }> = {
    ...deadline, grossSupport: { minimum: 0, maximum: 2, sourceRef: "source:caller-legal-family-support" } };
  const result = analyze(query, explicit);
  if (result.status !== "ready") throw new Error(result.reason);

  assert.equal(result.advice, "requires_model");
  assert.ok(result.requirements.includes("timing_competitor_not_excluded"));
  const deferred = result.model?.contexts[0]!.actions.find(action => action.id === "defer");
  if (deferred?.kind !== "closed_upper_frontier") throw new Error("caller_frontier_missing");

  assert.equal(deferred.upper, 1.25);
  assert.equal(deferred.frontierScopeRef, explicit.grossSupport!.sourceRef);
});
