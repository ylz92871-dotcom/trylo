import assert from "node:assert/strict";
import test from "node:test";
import type { CentralTimingInput } from "./timing-contract.js";
import { analyzeCentralOpportunityTiming, enumerateCentralTimingPrograms } from "./timing-model.js";

function input(): CentralTimingInput {
  return { schemaVersion: 1, opportunityId: "opportunity:deadline", windowRef: "window:deadline",
    forecastRef: "forecast:deadline", mean: .6,
    basis: { scope: "workspace:timing", boardSequence: 1, budgetId: "budget:timing", utilityUnit: "window-utility", valuationRef: "value:timing" },
    offer: { offerId: "offer:deadline", owner: { plane: "agent", domain: "tool" }, policyRef: "policy:deadline",
      reserve: { tokens: 100, calls: 1, steps: 1 }, maxPromptChars: 1000 },
    readiness: { kind: "ready", sourceRef: "business:timing", now: 0, nextHandoff: { at: 8, sourceRef: "handoff:8" } },
    target: { kind: "deadline", sourceRef: "target:deadline", useBy: 10, durationUpperBound: 4, durationSourceRef: "duration:4" },
    fee: { kind: "hard-budget-only", sourceRef: "fee:hard-caps" } };
}

function ready(source: unknown) {
  const result = analyzeCentralOpportunityTiming(source);
  if (result.status !== "ready") assert.fail(JSON.stringify(result));
  return result;
}

function supported(): CentralTimingInput {
  const source = input();
  return { ...source, target: { kind: "deadline", sourceRef: "target:deadline", useBy: 10, durationUpperBound: 4,
    durationSourceRef: "duration:4", grossSupport: { minimum: -1, maximum: 1, sourceRef: "objective:hard-gross-support" } } };
}

test("an unresolved defer preserves the known timely now program without claiming a family optimum", () => {
  const source = input(), original = JSON.stringify(source), result = ready(source);

  assert.equal(result.advice, "requires_model");
  assert.equal(result.netValue, null);
  assert.equal(result.selectedControl, null);
  assert.deepEqual(result.provisional, { control: "now", netValue: .6, scope: "best_known_feasible_program" });
  assert.ok(result.requirements.includes("gross_support_missing"));
  assert.equal(result.model, null);
  assert.equal(result.analysis, null);
  assert.equal(JSON.stringify(source), original);
});

test("actual gross support can exclude an unresolved defer and certify the complete now witness", () => {
  const result = ready({ ...supported(), fee: { kind: "utility", sourceRef: "objective:interference", now: .1, atHandoff: .6 } });

  assert.equal(result.advice, "now");
  assert.equal(result.netValue, .5);
  assert.ok(result.analysis?.firstControlCertificate.strict.includes("now"));
  const defer = result.model?.contexts[0]?.actions.find(action => action.id === "defer");

  assert.equal(defer?.kind, "closed_upper_frontier");

  if (defer?.kind === "closed_upper_frontier") assert.equal(defer.upper, .4);

  assert.ok(result.sourceRefs.includes("objective:hard-gross-support"));
  assert.deepEqual(result.requirements, []);
});

test("an upper frontier that can still win remains in the original timing analysis", () => {
  const result = ready(supported());

  assert.equal(result.advice, "requires_model");
  assert.equal(result.netValue, null);
  assert.equal(result.provisional?.control, "now");
  assert.deepEqual(result.analysis?.firstControlCertificate.nonInferior, []);
  assert.equal(result.analysis?.value.high, "1/1");
  const defer = result.analysis?.contexts[0]?.actions.find(action => action.id === "defer");

  assert.equal(defer?.value.low, null);
  assert.equal(defer?.kind, "closed_upper_frontier");
  assert.ok(result.requirements.includes("timing_competitor_not_excluded"));
});

test("deadline censoring uses outcome support rather than a potentially misleading mean", () => {
  // A mean-zero payoff can have positive expected censored benefit if completion
  // is correlated with its sign. No completion independence is declared here.
  const result = ready({ ...supported(), mean: 0 });
  assert.equal(result.advice, "requires_model");
  assert.equal(result.analysis?.value.high, "1/1");
  assert.deepEqual(result.analysis?.firstControlCertificate.nonInferior, []);
});

test("nonpositive full support can certify idle without manufacturing a processing lower witness", () => {
  const source = supported();
  const result = ready({ ...source, mean: -.2, target: { kind: "deadline", sourceRef: "target:deadline", useBy: 10,
    durationUpperBound: 4, durationSourceRef: "duration:4", grossSupport: { minimum: -1, maximum: -.1, sourceRef: "support:negative" } } });

  assert.equal(result.advice, "stop");
  assert.equal(result.netValue, 0);
  assert.ok(result.analysis?.firstControlCertificate.nonInferior.includes("no_more_processing"));
  const defer = result.analysis?.contexts[0]?.actions.find(action => action.id === "defer");

  assert.equal(defer?.value.low, null);
  assert.equal(defer?.value.high, "0/1");
});

test("gross support requires a bound source, ordered endpoints and a compatible mean", () => {
  const source = supported(), target = source.target;
  if (target.kind !== "deadline") assert.fail("deadline_required");

  for (const grossSupport of [
    { minimum: 1, maximum: -1, sourceRef: "support:invalid" },
    { minimum: -1, maximum: 1, sourceRef: "" },
    { minimum: -1, maximum: Number.POSITIVE_INFINITY, sourceRef: "support:invalid" },
  ]) assert.equal(analyzeCentralOpportunityTiming({ ...source, target: { ...target, grossSupport } }).status, "rejected");

  const outside = analyzeCentralOpportunityTiming({ ...source, mean: 2 });

  assert.equal(outside.status, "rejected");

  if (outside.status === "rejected") assert.equal(outside.reason, "central_timing_gross_support_conflict");
});

test("legacy complete starts retain their original complete timing comparison", () => {
  const source = input(), result = ready({ ...source, target: { kind: "deadline", sourceRef: "target:deadline",
    useBy: 20, durationUpperBound: 4, durationSourceRef: "duration:4" } });
  assert.equal(result.advice, "now");
  assert.equal(result.netValue, .6);
  assert.ok(result.model?.contexts[0]?.actions.every(action => action.kind === "closed"));
  assert.deepEqual(result.requirements, []);
  assert.equal(result.provisional, undefined);
});

test("joint-planner menus retain negative immediate-net processing programs", () => {
  const source = { ...input(), mean: .2, target: { kind: "boundary-independent" as const, sourceRef: "target:fixed-window" },
    fee: { kind: "utility" as const, sourceRef: "objective:cost", now: .3, atHandoff: .4 } };

  assert.equal(ready(source).advice, "stop");
  const menu = enumerateCentralTimingPrograms(source);
  if (menu.status !== "ready") assert.fail(menu.reason);

  assert.equal(menu.scope, "known_feasible_programs_only");
  assert.deepEqual(menu.programs, [
    { control: "now", at: 0, grossMean: .2, utilityFee: .3 },
    { control: "defer", at: 8, grossMean: .2, utilityFee: .4 },
  ]);
  assert.deepEqual(menu.unresolvedStarts, []);
  assert.deepEqual(menu.requirements, []);
});

test("joint-planner menus preserve completion uncertainty and gross upper semantics", () => {
  const missing = enumerateCentralTimingPrograms(input());
  if (missing.status !== "ready") assert.fail(missing.reason);

  assert.deepEqual(missing.programs, [{ control: "now", at: 0, grossMean: .6, utilityFee: 0 }]);
  assert.deepEqual(missing.unresolvedStarts, [{ control: "defer", at: 8, utilityFee: 0,
    grossUpperBound: null, sourceRef: "duration:4" }]);
  assert.ok(missing.requirements.includes("gross_support_missing"));
  const bounded = enumerateCentralTimingPrograms({ ...supported(),
    fee: { kind: "utility", sourceRef: "objective:fees", now: .1, atHandoff: .2 } });
  if (bounded.status !== "ready") assert.fail(bounded.reason);

  assert.equal(bounded.unresolvedStarts[0]?.grossUpperBound, 1);
  assert.equal(bounded.unresolvedStarts[0]?.utilityFee, .2);
  assert.ok(bounded.requirements.includes("timely_completion_not_bounded"));
  assert.ok(!bounded.requirements.includes("gross_support_missing"));
});

test("joint-planner menus share operational and source guards with local timing", () => {
  for (const readiness of [
    { kind: "waiting_evidence", sourceRef: "source:waiting", evidenceRefs: ["checker:missing"] },
    { kind: "terminal", sourceRef: "source:terminal", reason: "objective:closed" },
    { kind: "in_flight", sourceRef: "source:worker" },
  ]) {
    const menu = enumerateCentralTimingPrograms({ ...input(), readiness });
    if (menu.status !== "ready") assert.fail(menu.reason);
    assert.deepEqual(menu.programs, []);
    assert.deepEqual(menu.unresolvedStarts, []);
  }

  const invalid = enumerateCentralTimingPrograms({ ...supported(), mean: 2 });

  assert.equal(invalid.status, "rejected");
  const handoff = enumerateCentralTimingPrograms({ ...input(), readiness: { kind: "handoff", sourceRef: "source:handoff",
    now: 0, boundaryAt: 5 }, target: { kind: "boundary-independent", sourceRef: "target:constant" } });
  if (handoff.status !== "ready") assert.fail(handoff.reason);

  assert.deepEqual(handoff.programs, [{ control: "defer", at: 5, grossMean: .6, utilityFee: 0 }]);
});
