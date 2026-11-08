import test from "node:test";
import assert from "node:assert/strict";
import { emptyBoardState } from "../../learning/control/state.js";
import { reduce } from "../../learning/control/reducer.js";
import type { CoordinationAction } from "../../learning/control/coordination-contract.js";
import type { RewardV2Draft } from "../../learning/reward/v2-facts.js";
import type { CentralResponseOpportunity, CentralResponseTarget } from "../../learning/control/decision/prediction-input.js";
import type { CentralPursuitCandidate } from "../../learning/control/decision/pursuit-contract.js";
import { centralPursuitTreatmentRef } from "../../learning/control/decision/pursuit-resource-model.js";
import { createCentralResponseWindowDraft } from "./response-registration.js";
import { lookupCentralResponseEvidence } from "./response-discovery.js";
import type { CentralResponseProtocol } from "./response-protocol.js";
import { buildCentralResponseEvidenceForecast } from "./response-forecast.js";
import { createCentralPursuitObservationDraft } from "./pursuit-observations.js";

const scope = "project:response-forecast", condition = "c".repeat(64), date = "2026-11-04T15:00:00.000Z";
const target = { key: "target:economic-effect", utilityUnit: "utility:window-effect", referenceKey: "population:registered-use",
  baselineRuleKey: "rule:frozen-baseline", windowRef: "window:registered-cohort" };

function opportunity(id: string, policyRef = "policy:tool-v1"): CentralResponseOpportunity {
  return { opportunityId: `opportunity:${id}`, scope, targetRef: target.key, instanceRef: `stage:${id}`, sourceRef: `source:${id}`,
    stage: "initial", conditionRef: condition, baselineRef: `baseline:${id}`, windowRef: target.windowRef,
    offer: { offerId: `offer:${id}`, owner: { plane: "agent", domain: "tool" }, policyRef,
      reserve: { tokens: 1000, calls: 1, steps: 1 }, maxPromptChars: 4000 } };
}

function candidate(id: string, policyRef = "policy:tool-v1"): CentralPursuitCandidate {
  const current = opportunity(id, policyRef);
  return { opportunity: current, source: { issueId: `issue:${id}`, grantId: `grant:${id}`, sourceBindingRef: `source-binding:${id}`,
    domainStage: { stageRef: current.instanceRef, kind: "initial", policyRef, sourceReportId: `report:${id}`,
      readiness: { kind: "ready", evidenceRefs: [current.sourceRef] } } },
    readiness: { kind: "ready", sourceRef: "business:idle", now: 100, nextHandoff: null },
    target: { kind: "boundary-independent", sourceRef: "business:fixed-use-window" }, fee: { kind: "hard-budget-only", sourceRef: "objective:hard-budget" },
    purpose: "focused_learning", objective: { instanceId: `objective:${id}`, criterion: "proposal_delivered", definitionRef: "criterion:proposal",
      familyRef: "family:research-result", familySourceRef: "source:research-protocol" } };
}

function protocol(id = "one", low = -1, high = 1): CentralResponseProtocol {
  return { scope, experimentRef: `experiment:${id}`, experimentVersion: "v1", conditionHash: condition, utilityUnit: target.utilityUnit,
    deltaBounds: { minimum: low, maximum: high, sourceRef: `source:bounds:${id}` },
    policyFamilyRef: `response-family:${id}`, familySourceRef: `source:family:${id}` };
}

function fixture(responseTarget: CentralResponseTarget = target) {
  let board = emptyBoardState();
  const coordinate = (action: CoordinationAction) => {
    const next = reduce(board, { type: "coordinate_learning", commandId: `test:coordinate:${board.sequence}`, issuedAt: date, action });
    if (!next.ok) throw new Error(next.reason);
    board = next.state;
  };
  const append = (fact: RewardV2Draft) => {
    const next = reduce(board, { type: "record_reward_v2_fact", commandId: `test:record:${board.sequence}`, issuedAt: date,
      expectedSequence: board.sequence, fact });
    if (!next.ok) throw new Error(next.reason);
    board = next.state;
  };

  return {
    get board() { return board; },

    register(id: string, ids: readonly string[], nativeProtocol?: CentralResponseProtocol, policyRef = "policy:tool-v1") {
      const current = opportunity(id, policyRef);

      coordinate({ kind: "report", scope, issueId: `issue:${id}`, problemKey: `problem:${id}`, report: { reportId: `report:${id}`,
        source: { subsystem: "tool", taskId: `task:${id}`, versionId: "v1" }, facts: ["Synthetic bounded source contract"], evidenceRefs: [`source:${id}`] } });
      coordinate({ kind: "decide", issueId: `issue:${id}`, expectedRevision: 1, decision: "focused_learning", reason: "Synthetic source stage",
        sourceRefs: [`source:${id}`] });
      coordinate({ kind: "fund", issueId: `issue:${id}`, expectedRevision: 2, grantId: `grant:${id}`, domain: "tool",
        allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000, maxCalls: 1, maxSteps: 1, maxPromptChars: 4000 } });
      let assignment: RewardV2Draft | undefined;

      if (responseTarget.estimand === "learning_policy_response") {
        const draft = createCentralPursuitObservationDraft({ unitId: `unit:${id}`, scope, conditionRef: condition,
          objective: candidate(id, policyRef).objective, grantId: `grant:${id}`, stageRef: `stage:${id}`,
          treatmentRef: centralPursuitTreatmentRef(current.offer),
          sourceRef: `source:assignment:${id}`, revisionRef: `revision:assignment:${id}`, outcome: "pending" });
        if (draft.status !== "ready") throw new Error(draft.reason);
        assignment = draft.value;
      }

      const comparison = assignment !== undefined
        ? { kind: "learning_policy_vs_frozen_baseline" as const, assignmentRef: assignment.id,
          registrationRef: `registration:${id}`, baselineRuleKey: responseTarget.baselineRuleKey }
        : { kind: "deployed_learning_vs_frozen_baseline" as const, resultRef: `result:${id}`,
          adoptionRef: `adoption:${id}`, registrationRef: `registration:${id}`, baselineRuleKey: responseTarget.baselineRuleKey };
      const draft = createCentralResponseWindowDraft({ opportunity: current, unitId: `unit:${id}`,
        grantId: `grant:${id}`, measurementIds: ids, comparison }, responseTarget, nativeProtocol);
      if (draft.status !== "ready") throw new Error(draft.reason);

      append(draft.value);

      if (assignment !== undefined) append(assignment);
    },

    measure(id: string, value: number, experimentRef = "experiment:one", supersedes?: string) {
      append({ id, scope, algorithmVersion: "ws1-paired-measurement-v1", kind: "feedback", payloadJson: JSON.stringify({ schemaVersion: 1,
        type: "ws1_paired_measurement", observationBinding: null, measurement: { id, scope, experimentRef, experimentVersion: "v1",
          conditionHash: condition, utilityUnit: target.utilityUnit, sourceRef: `checker:${id}`, kind: "measured",
          baselineUtility: 0, candidateUtility: value, fullStudyCost: 100, ...(supersedes === undefined ? {} : { supersedes }) } }) });
    },
  };
}

function build(source: ReturnType<typeof fixture>, candidates = [candidate("current")]) {
  const lookup = lookupCentralResponseEvidence({ board: source.board, scope, candidates });
  if (lookup.status !== "ready") throw new Error(lookup.reason);

  assert.deepEqual(lookup.unmatched, []);
  assert.equal(lookup.groups.length, 1);
  const result = buildCentralResponseEvidenceForecast({ board: source.board,
    basis: { scope, boardSequence: source.board.sequence, budgetId: "budget:source", utilityUnit: target.utilityUnit, valuationRef: "valuation:source" },
    group: lookup.groups[0]! });
  if (result.status !== "ready") throw new Error(`${result.status}:${result.reason}`);

  return result;
}

function near(actual: number | null, expected: number) {
  assert.notEqual(actual, null);
  if (actual === null) throw new Error("expected_identified_numeric_moment");
  assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
}

test("v2 canonical discovery retains real partial evidence and does not call a pure prior mature economic evidence", () => {
  const source = fixture();
  source.register("history", ["pair:a", "pair:b"], protocol());
  source.measure("pair:a", .5);
  const result = build(source), query = result.forecast.queries[0]!;
  assert.equal(query.population, 1);
  assert.equal(query.pending, 1);
  near(query.mean, 0);
  near(query.processVariance, 4);
  near(query.pendingMeanRange![0], -.125);
  near(query.pendingMeanRange![1], .375);
  assert.deepEqual(result.identifiedOpportunityIds, []);
  assert.equal(result.input.history.length, 1);
});

test("a v2 producer carries its sourced whole-window gross support separately from pending mean completion", () => {
  const source = fixture();
  source.register("history", ["pair:a", "pair:b"], protocol());
  source.measure("pair:a", .5);
  const result = build(source), query = result.forecast.queries[0]!;

  assert.equal(query.grossSupport!.minimum, -2);
  assert.equal(query.grossSupport!.maximum, 2);
  assert.match(query.grossSupport!.sourceRef, /^response-source-bounds:/);
  assert.ok(result.sourceRefs.includes(query.grossSupport!.sourceRef));
  assert.deepEqual(query.pendingMeanRange, [-.125, .375]);
  assert.notEqual(query.grossSupport!.minimum, query.pendingMeanRange![0]);
});

test("one real qualified complete window updates the original predictor and marks only its consumed response class", () => {
  const source = fixture();
  source.register("history", ["pair:a", "pair:b"], protocol());
  source.measure("pair:a", .5);
  source.measure("pair:b", .5);
  const result = build(source), query = result.forecast.queries[0]!;
  near(query.mean, .25);
  near(query.variance, 1);
  assert.deepEqual(query.updateUnitIds, ["unit:history"]);
  assert.deepEqual(result.identifiedOpportunityIds, ["opportunity:current"]);
  assert.equal(query.offer.policyRef, "policy:tool-v1");
  assert.equal(query.offer.reserve.tokens, 1000);
});

test("a whole learning-policy assignment response reaches the sourced reference predictor without requiring adoption", () => {
  const policyTarget: CentralResponseTarget = { ...target, estimand: "learning_policy_response" };
  const source = fixture(policyTarget);
  source.register("history", ["pair:policy"], protocol());
  source.measure("pair:policy", .5);
  const result = build(source), query = result.forecast.queries[0]!;

  assert.deepEqual(result.forecast.target, policyTarget);
  assert.equal(result.input.history.length, 1);
  assert.equal(result.input.history[0]!.outcome.kind, "paired_window");
  assert.equal(query.support, "updated_bounded_reference");
  near(query.mean, .125);
  near(query.variance, .25);
  assert.deepEqual(query.updateUnitIds, ["unit:history"]);
  assert.deepEqual(result.identifiedOpportunityIds, ["opportunity:current"]);
  assert.deepEqual(query.grossSupport, { minimum: -1, maximum: 1, sourceRef: query.grossSupport!.sourceRef });
  assert.equal(query.offer.policyRef, "policy:tool-v1");
});

test("the internal predictor can rebind a later financial prefix without serializing or refitting source facts twice", () => {
  const source = fixture();
  source.register("history", ["pair:a"], protocol());
  source.measure("pair:a", 1);
  const result = build(source), next = result.predict({ ...result.input, basis: { ...result.input.basis,
    boardSequence: result.input.basis.boardSequence + 1, valuationRef: "valuation:after-reconcile" } });
  if (next.status !== "ready") throw new Error(next.reason);

  near(next.value.queries[0]!.mean, result.forecast.queries[0]!.mean);
  assert.equal(next.value.queries[0]!.population, 1);
  assert.notEqual(next.value.forecastRef, result.forecast.forecastRef);
  assert.equal(next.value.basis.boardSequence, result.input.basis.boardSequence + 1);
});

test("a financial-prefix rebound cannot upgrade a deployed-response source into a learning-policy estimand", () => {
  for (const nativeProtocol of [undefined, protocol()]) {
    const source = fixture();
    source.register("history", ["pair:deployed"], nativeProtocol);
    source.measure("pair:deployed", .5);
    const result = build(source), changed = result.predict({ ...result.input,
      target: { ...result.input.target, estimand: "learning_policy_response" },
      basis: { ...result.input.basis, boardSequence: result.input.basis.boardSequence + 1 } });

    assert.equal(changed.status, "invalid");
    assert.equal(changed.reason, "central_response_source_target_changed");
    assert.equal(result.forecast.target.estimand, undefined);
  }
});

test("same-condition protocols select their own registered cohorts and retain both partial supports", () => {
  const source = fixture();

  source.register("a", ["a:one", "a:two"], protocol("a"), "policy:a");
  source.register("b", ["b:one", "b:two"], protocol("b", -2, 2), "policy:b");
  source.measure("a:one", .5, "experiment:a");
  source.measure("b:one", -1, "experiment:b");
  const result = build(source, [candidate("current-a", "policy:a"), candidate("current-b", "policy:b")]);

  assert.equal(result.input.history.length, 2);
  assert.equal(result.forecast.queries.length, 2);
  const [a, b] = result.forecast.queries;

  near(a!.pendingMeanRange![0], -.125);
  near(a!.pendingMeanRange![1], .375);
  near(b!.pendingMeanRange![0], -.75);
  near(b!.pendingMeanRange![1], .25);
  assert.equal(a!.population, 1);
  assert.equal(b!.population, 1);
  assert.deepEqual(result.identifiedOpportunityIds, []);
});

test("one response-equivalent family cannot pool different fixed whole-window cohort sizes", () => {
  const source = fixture(), first = protocol("a"), second = { ...protocol("b"),
    policyFamilyRef: first.policyFamilyRef, familySourceRef: first.familySourceRef };

  source.register("one", ["a:one"], first);
  source.register("two", ["b:one", "b:two"], second);
  source.measure("a:one", .25, "experiment:a");
  source.measure("b:one", .25, "experiment:b");
  source.measure("b:two", .25, "experiment:b");
  const lookup = lookupCentralResponseEvidence({ board: source.board, scope, candidates: [candidate("current")] });
  if (lookup.status !== "ready") throw new Error(lookup.reason);

  const result = buildCentralResponseEvidenceForecast({ board: source.board,
    basis: { scope, boardSequence: source.board.sequence, budgetId: "budget:source", utilityUnit: target.utilityUnit, valuationRef: "valuation:source" },
    group: lookup.groups[0]! });

  assert.deepEqual(result, { status: "invalid", reason: "response_forecast_family_window_definition" });
  const distinct = fixture();

  distinct.register("a", ["distinct:a"], protocol("a"), "policy:a");
  distinct.register("b", ["distinct:b:one", "distinct:b:two"], protocol("b"), "policy:b");
  distinct.measure("distinct:a", .25, "experiment:a");
  distinct.measure("distinct:b:one", .25, "experiment:b");
  distinct.measure("distinct:b:two", .25, "experiment:b");
  assert.equal(build(distinct, [candidate("current-a", "policy:a"), candidate("current-b", "policy:b")]).forecast.queries.length, 2);
});

test("all-v1 complete history keeps the original calibrated route without inventing protocol bounds", () => {
  const source = fixture();
  source.register("one", ["pair:one"]);
  source.register("two", ["pair:two"]);
  source.measure("pair:one", .2);
  source.measure("pair:two", .4);
  const result = build(source), query = result.forecast.queries[0]!;
  near(query.mean, .3);
  assert.equal(query.support, "calibrated_history");
  assert.equal(query.calibrationUnitIds.length, 2);
  assert.deepEqual(result.identifiedOpportunityIds, ["opportunity:current"]);
});

test("equal qualified negative v1 outcomes remain economic evidence without a fabricated zero-noise model", () => {
  const source = fixture();
  source.register("one", ["pair:one"]);
  source.register("two", ["pair:two"]);
  source.measure("pair:one", -.25);
  source.measure("pair:two", -.25);
  const result = build(source), query = result.forecast.queries[0]!;

  assert.equal(query.mean, -.25);
  assert.equal(query.support, "empirical_history");
  assert.equal(query.variance, null);
  assert.equal(query.processVariance, null);
  assert.deepEqual(query.updateUnitIds, ["unit:one", "unit:two"]);
  assert.deepEqual(result.identifiedOpportunityIds, ["opportunity:current"]);
  assert.deepEqual(result.forecast.requirements, []);
});

test("an unbounded legacy class is not assigned another class's v2 hard effect range", () => {
  const source = fixture();

  source.register("legacy-one", ["legacy:one"], undefined, "policy:legacy");
  source.register("legacy-two", ["legacy:two"], undefined, "policy:legacy");
  source.register("bounded", ["bounded:one"], protocol("bounded"), "policy:bounded");
  source.measure("legacy:one", 2, "experiment:legacy");
  source.measure("legacy:two", 4, "experiment:legacy");
  source.measure("bounded:one", .5, "experiment:bounded");
  const result = build(source, [candidate("current-legacy", "policy:legacy"), candidate("current-bounded", "policy:bounded")]);

  near(result.forecast.queries[0]!.mean, 3);
  near(result.forecast.queries[1]!.mean, .125);
  assert.equal(result.forecast.queries[0]!.support, "calibrated_history");
  assert.equal(result.forecast.queries[1]!.support, "updated_bounded_reference");
  assert.equal(result.identifiedOpportunityIds.length, 2);
  assert.ok(result.forecast.modelAssumptions!.some(text => text.includes("plug-in empirical Gaussian")));
  assert.ok(result.forecast.modelAssumptions!.some(text => text.includes("uniform law")));
});

test("a discovery record cannot forge a different canonical registration body", () => {
  const source = fixture();
  source.register("history", ["pair:a"], protocol());
  const lookup = lookupCentralResponseEvidence({ board: source.board, scope, candidates: [candidate("current")] });
  if (lookup.status !== "ready") throw new Error(lookup.reason);

  const group = lookup.groups[0]!, original = group.registrations[0]!;
  const result = buildCentralResponseEvidenceForecast({ board: source.board,
    basis: { scope, boardSequence: source.board.sequence, budgetId: "budget:source", utilityUnit: target.utilityUnit, valuationRef: "valuation:source" },
    group: { ...group, registrations: [{ ...original, window: { ...original.window,
      opportunity: { ...original.window.opportunity, baselineRef: "baseline:forged" } } }] } });

  assert.deepEqual(result, { status: "invalid", reason: "response_forecast_registration_binding" });
});

test("cross-protocol response classes cannot count one effective comparison head as independent learning windows", () => {
  const source = fixture(), first = protocol(), second: CentralResponseProtocol = { ...first,
    deltaBounds: { minimum: -2, maximum: 2, sourceRef: "source:other-bounds" },
    policyFamilyRef: "response-family:other", familySourceRef: "source:other-family" };

  source.register("a", ["pair:root"], first, "policy:a");
  source.register("b", ["pair:correction"], second, "policy:b");
  source.measure("pair:root", .25);
  source.measure("pair:correction", .5, "experiment:one", "pair:root");
  const lookup = lookupCentralResponseEvidence({ board: source.board, scope,
    candidates: [candidate("current-a", "policy:a"), candidate("current-b", "policy:b")] });
  if (lookup.status !== "ready") throw new Error(lookup.reason);

  assert.equal(lookup.groups.length, 1);
  const result = buildCentralResponseEvidenceForecast({ board: source.board,
    basis: { scope, boardSequence: source.board.sequence, budgetId: "budget:source", utilityUnit: target.utilityUnit, valuationRef: "valuation:source" },
    group: lookup.groups[0]! });

  assert.deepEqual(result, { status: "invalid", reason: "response_window_reused_measurement" });
  const differentSelectors = fixture();

  differentSelectors.register("a", ["shared:raw-id"], first, "policy:a");
  differentSelectors.register("b", ["shared:raw-id"], { ...second, experimentRef: "experiment:other" }, "policy:b");
  differentSelectors.measure("shared:raw-id", .5);
  const otherLookup = lookupCentralResponseEvidence({ board: differentSelectors.board, scope,
    candidates: [candidate("current-a", "policy:a"), candidate("current-b", "policy:b")] });
  if (otherLookup.status !== "ready") throw new Error(otherLookup.reason);

  const other = buildCentralResponseEvidenceForecast({ board: differentSelectors.board,
    basis: { scope, boardSequence: differentSelectors.board.sequence, budgetId: "budget:source", utilityUnit: target.utilityUnit, valuationRef: "valuation:source" },
    group: otherLookup.groups[0]! });

  assert.deepEqual(other, { status: "invalid", reason: "response_forecast_registration_comparison_reused" });
});
