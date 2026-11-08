import assert from "node:assert/strict";
import test from "node:test";
import { emptyBoardState } from "../../learning/control/state.js";
import { reduce } from "../../learning/control/reducer.js";
import type { CoordinationAction } from "../../learning/control/coordination-contract.js";
import type { CentralPursuitCandidate } from "../../learning/control/decision/pursuit-contract.js";
import { centralPursuitTreatmentRef } from "../../learning/control/decision/pursuit-resource-model.js";
import type { CentralResponseTarget } from "../../learning/control/decision/prediction-input.js";
import type { RewardV2Draft } from "../../learning/reward/v2-facts.js";
import { createCentralResponseWindowDraft } from "./response-registration.js";
import { createCentralPursuitObservationDraft } from "./pursuit-observations.js";
import { lookupCentralResponseEvidence } from "./response-discovery.js";
import type { CentralLearningEvidenceInput } from "./evidence-decision-contract.js";
import { assessCentralEconomicEvidence } from "./economic-evidence.js";

const scope = "workspace:economic-evidence", condition = "c".repeat(64), date = "2026-11-04T15:00:00.000Z";
const target = { key: "target:economic-use", utilityUnit: "utility:deployed-effect", referenceKey: "population:registered-window",
  baselineRuleKey: "rule:frozen-baseline", windowRef: "window:one-use", estimand: "learning_policy_response" as const };

function candidate(id: string, economic = true): CentralPursuitCandidate {
  const domain = economic ? "tool" as const : "skill" as const, policyRef = `policy:${domain}`;
  return { opportunity: { opportunityId: `opportunity:${id}`, scope, targetRef: economic ? target.key : "target:proposal-only",
    instanceRef: `stage:${id}`, sourceRef: `source:${id}`, stage: "initial", conditionRef: condition,
    baselineRef: `baseline:${id}`, windowRef: target.windowRef, offer: { offerId: `offer:${id}`,
      owner: { plane: "agent", domain }, policyRef, reserve: { tokens: 1000, calls: 1, steps: 1 }, maxPromptChars: 4000 } },
    source: { issueId: `issue:${id}`, grantId: `grant:${id}`, sourceBindingRef: `binding:${id}`, domainStage: {
      stageRef: `stage:${id}`, kind: "initial", policyRef, sourceReportId: `report:${id}`,
      readiness: { kind: "ready", evidenceRefs: [`source:${id}`] } } },
    readiness: { kind: "ready", sourceRef: "business:idle", now: 100, nextHandoff: null },
    target: { kind: "boundary-independent", sourceRef: "source:window-start-rule" },
    fee: { kind: "hard-budget-only", sourceRef: "source:hard-cap-only" }, purpose: "focused_learning",
    objective: { instanceId: `objective:${id}`, criterion: "proposal_delivered", definitionRef: "criterion:proposal",
      familyRef: `pursuit-family:${domain}`, familySourceRef: "source:pursuit-family" } };
}

function fixture(value: number | null = -1, bounds: readonly [number, number] = [-1, 1], pending = false,
  responseTarget: CentralResponseTarget = target): CentralLearningEvidenceInput {
  let board = emptyBoardState();
  const coordinate = (action: CoordinationAction) => {
    const result = reduce(board, { type: "coordinate_learning", commandId: `setup:${board.sequence}`, issuedAt: date, action });
    if (!result.ok) assert.fail(result.reason);
    board = result.state;
  };
  const append = (fact: RewardV2Draft) => {
    const result = reduce(board, { type: "record_reward_v2_fact", commandId: `record:${board.sequence}`,
      issuedAt: date, expectedSequence: board.sequence, fact });
    if (!result.ok) assert.fail(result.reason);
    board = result.state;
  };
  const focus = (id: string, economic: boolean) => {
    coordinate({ kind: "report", scope, issueId: `issue:${id}`, problemKey: `problem:${id}`, report: { reportId: `report:${id}`,
      source: { subsystem: economic ? "tool" : "skill", taskId: `task:${id}`, versionId: "source:v1" },
      facts: ["Synthetic bounded actual-shaped stage contract"], evidenceRefs: [`source:${id}`] } });
    coordinate({ kind: "decide", issueId: `issue:${id}`, expectedRevision: 1, decision: "focused_learning",
      reason: "Declared contract focus", sourceRefs: [`source:${id}`] });
  };
  const protocol = { scope, experimentRef: "experiment:effect", experimentVersion: "v1", conditionHash: condition,
    utilityUnit: responseTarget.utilityUnit,
    deltaBounds: { minimum: bounds[0], maximum: bounds[1], sourceRef: "source:hard-effect-support" },
    policyFamilyRef: "response-family:tool", familySourceRef: "source:response-family" };
  const registerStage = (id: string) => {
    const stage = candidate(id);

    focus(id, true);
    coordinate({ kind: "fund", issueId: stage.source.issueId, expectedRevision: 2, grantId: stage.source.grantId, domain: "tool",
      allowance: { schemaVersion: 2, unit: "total_model_tokens", maxTokens: 1000, maxCalls: 1, maxSteps: 1, maxPromptChars: 4000 } });
    const assignment = responseTarget.estimand === "learning_policy_response" ? createCentralPursuitObservationDraft({
      unitId: `unit:${id}`, scope, conditionRef: stage.opportunity.conditionRef, objective: stage.objective,
      grantId: stage.source.grantId, stageRef: stage.opportunity.instanceRef, sourceRef: stage.opportunity.sourceRef,
      revisionRef: `revision:initial-assignment:${id}`, treatmentRef: centralPursuitTreatmentRef(stage.opportunity.offer), outcome: "pending" }) : null;
    if (assignment?.status === "invalid") assert.fail(assignment.reason);

    const comparison = assignment?.status === "ready"
      ? { kind: "learning_policy_vs_frozen_baseline" as const, assignmentRef: assignment.value.id,
        registrationRef: `registration:${id}`, baselineRuleKey: responseTarget.baselineRuleKey }
      : { kind: "deployed_learning_vs_frozen_baseline" as const, resultRef: `result:${id}`, adoptionRef: `adoption:${id}`,
        registrationRef: `registration:${id}`, baselineRuleKey: responseTarget.baselineRuleKey };
    const registration = createCentralResponseWindowDraft({ opportunity: stage.opportunity, unitId: `unit:${id}`,
      grantId: stage.source.grantId, measurementIds: [`pair:${id}`], comparison }, responseTarget, protocol);
    if (registration.status !== "ready") assert.fail(registration.reason);

    // Freeze the whole-policy cohort before the actual initial pending unit is born.
    append(registration.value);

    if (assignment?.status === "ready") append(assignment.value);
  };

  registerStage("history");

  if (pending) registerStage("pending-history");

  if (value !== null) append({ id: "pair:history", scope, kind: "feedback", algorithmVersion: "ws1-paired-measurement-v1",
    payloadJson: JSON.stringify({ schemaVersion: 1, type: "ws1_paired_measurement", observationBinding: null, measurement: {
      id: "pair:history", scope, experimentRef: "experiment:effect", experimentVersion: "v1", conditionHash: condition,
      utilityUnit: responseTarget.utilityUnit, sourceRef: "checker:history", kind: "measured", baselineUtility: 0,
      candidateUtility: value, fullStudyCost: 100 } }) });

  focus("known", true);
  focus("unknown", false);
  coordinate({ kind: "open_budget", expectedSequence: board.sequence, budget: { schemaVersion: 1, budgetId: "budget:evidence",
    scope, unit: "total_model_tokens", limits: { tokens: 2000, calls: 4, steps: 4 }, authorizationRef: "host:explicit-root" } });

  return { schemaVersion: 1, board, basis: { scope, boardSequence: board.sequence, budgetId: "budget:evidence",
    utilityUnit: "qualified_objective_completions", valuationRef: "value:current-sources" },
  candidates: [candidate("known"), candidate("unknown", false)], horizon: 2 };
}

function assess(input: CentralLearningEvidenceInput) {
  const discovery = lookupCentralResponseEvidence({ board: input.board, scope, candidates: input.candidates });
  if (discovery.status !== "ready") assert.fail(discovery.reason);
  const result = assessCentralEconomicEvidence(input, discovery);
  if (result.status !== "ready") assert.fail(result.reason);
  return result;
}

function near(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`); }

test("legacy deployed responses remain conditional diagnostics even when their actual support is strictly negative", () => {
  const legacyTarget: CentralResponseTarget = { key: target.key, utilityUnit: target.utilityUnit,
    referenceKey: target.referenceKey, baselineRuleKey: target.baselineRuleKey, windowRef: target.windowRef };
  const result = assess(fixture(-2, [-2, -1], false, legacyTarget));

  assert.deepEqual(result.assessments, []);
  assert.deepEqual(result.negative, []);
  assert.equal(result.conditionalResponses.length, 1);
  const diagnostic = result.conditionalResponses[0]!, query = diagnostic.forecast.queries[0]!;

  assert.equal(diagnostic.target.estimand, undefined);
  assert.equal(diagnostic.reason, "deployment_response_not_learning_policy_response");
  assert.deepEqual(diagnostic.opportunityIds, ["opportunity:known"]);
  assert.ok(query.mean < 0);
  assert.equal(query.grossSupport!.maximum, -1);
  assert.ok(diagnostic.sourceRefs.includes("source:hard-effect-support"));
  assert.equal(result.unusable[0]!.reason, "deployment_response_not_learning_policy_response");
});

test("a partial economic group retains its consumed known-negative effect despite an unrelated unmodelled candidate", () => {
  const input = fixture(), original = JSON.stringify(input), result = assess(input), assessment = result.assessments[0]!;

  assert.equal(result.assessments.length, 1);
  assert.equal(assessment.input.candidates.length, 1);
  assert.equal(assessment.input.candidates[0]!.opportunityId, "opportunity:known");
  assert.equal(assessment.input.prediction.basis.utilityUnit, target.utilityUnit);
  assert.deepEqual(assessment.source.identifiedOpportunityIds, ["opportunity:known"]);
  assert.equal(result.negative.length, 1);
  assert.equal(result.negative[0]!.opportunityId, "opportunity:known");
  assert.equal(result.negative[0]!.interpretation, "negative_current_model_expectation");
  near(result.negative[0]!.netValue, -.25);
  assert.equal(result.negative[0]!.utilityUnit, target.utilityUnit);
  assert.equal(assessment.decision.recommendation, "stop");
  assert.equal(assessment.actions.nextStep.kind, "stop");
  assert.equal(JSON.stringify(input), original);
});

test("model-only negative prior means and identified exact-zero effects do not create negative exclusions", () => {
  const prior = assess(fixture(null, [-2, 1]));
  assert.ok(prior.assessments[0]!.source.forecast.queries[0]!.mean < 0);
  assert.deepEqual(prior.assessments[0]!.source.identifiedOpportunityIds, []);
  assert.deepEqual(prior.negative, []);
  const zero = assess(fixture(0, [0, 0]));
  assert.equal(zero.assessments[0]!.source.forecast.queries[0]!.variance, 0);
  assert.deepEqual(zero.assessments[0]!.source.identifiedOpportunityIds, ["opportunity:known"]);
  assert.deepEqual(zero.negative, []);
});

test("source-supported actual net ceilings constrain zero-complete pending stages without turning a prior into evidence", () => {
  for (const specification of [{ bounds: [-2, -1] as const, fee: null }, { bounds: [-1, 1] as const, fee: 2 }]) {
    const input = fixture(null, specification.bounds, true);
    const result = assess(specification.fee === null ? input : { ...input, valueBindings: [{
      opportunityId: "opportunity:known", targetKey: target.key, conditionRef: condition,
      policyFamilyRef: "response-family:tool", sourceRef: "domain:economic-target-and-fee",
      fee: { kind: "utility", sourceRef: "domain:fee-in-deployed-effect-unit", now: specification.fee, atHandoff: specification.fee } }] });
    const assessment = result.assessments[0]!, query = assessment.source.forecast.queries[0]!;

    assert.equal(query.pending, 2);
    assert.deepEqual(query.updateUnitIds, []);
    assert.deepEqual(query.calibrationUnitIds, []);
    assert.deepEqual(assessment.source.identifiedOpportunityIds, []);
    assert.equal(query.support, "bounded_reference_prior");
    const timing = assessment.decision.evaluations[0]!.timing;

    assert.equal(timing?.status, "ready");

    if (timing?.status !== "ready") assert.fail("ready_timing_required");

    assert.equal(timing.advice, "stop");
    assert.equal(result.negative.length, 1);
    assert.equal(result.negative[0]!.opportunityId, "opportunity:known");
    assert.equal(result.negative[0]!.interpretation, "source_supported_negative_net_ceiling");
    near(result.negative[0]!.netValue, -1);
    assert.equal(result.negative[0]!.utilityUnit, target.utilityUnit);
    assert.ok(result.negative[0]!.sourceRefs.includes(query.grossSupport!.sourceRef));
    assert.ok(result.negative[0]!.sourceRefs.includes("source:hard-effect-support"));
  }
});

test("pending completions crossing or touching zero do not become exclusions, while sourced strictly negative ranges can remain", () => {
  for (const measured of [-.5, -1]) {
    const incomplete = assess(fixture(measured, [-1, 1], true)), query = incomplete.assessments[0]!.source.forecast.queries[0]!;
    assert.equal(query.pending, 1);
    assert.ok(query.mean < 0);
    assert.ok(query.pendingMeanRange![1] >= 0);
    assert.deepEqual(incomplete.assessments[0]!.source.identifiedOpportunityIds, ["opportunity:known"]);
    assert.deepEqual(incomplete.negative, []);
    assert.deepEqual(incomplete.unusable, []);
  }

  const bounded = assess(fixture(-2, [-2, -1], true)), query = bounded.assessments[0]!.source.forecast.queries[0]!;

  assert.equal(query.pending, 1);
  assert.ok(query.pendingMeanRange![1] < 0);
  assert.equal(bounded.negative.length, 1);
  assert.equal(bounded.negative[0]!.opportunityId, "opportunity:known");
  assert.equal(bounded.assessments[0]!.input.candidates.length, 1);
});

test("an explicitly economic processing fee can make every pending completion net negative even when gross crosses zero", () => {
  const input = fixture(-.5, [-1, 1], true);
  const result = assess({ ...input, valueBindings: [{ opportunityId: "opportunity:known", targetKey: target.key,
    conditionRef: condition, policyFamilyRef: "response-family:tool", sourceRef: "domain:economic-target-and-fee",
    fee: { kind: "utility", sourceRef: "domain:fee-in-deployed-effect-unit", now: .2, atHandoff: .2 } }] });
  const query = result.assessments[0]!.source.forecast.queries[0]!, range = query.pendingMeanRange!;

  assert.equal(query.pending, 1);
  assert.ok(range[0] < 0 && range[1] > 0);
  near(range[1], .1);
  assert.ok(range[1] - .2 < 0);
  assert.equal(result.negative.length, 1);
  near(result.negative[0]!.netValue, -13 / 40);
  assert.equal(result.negative[0]!.utilityUnit, target.utilityUnit);
});

test("unresolved timing families and a zero-valued processing alternative cannot be labelled strictly negative", () => {
  const input = fixture(), known = input.candidates[0]!;
  const unresolved = assess({ ...input, candidates: [{ ...known, target: { kind: "deadline", sourceRef: "source:use-window",
    useBy: 200, durationUpperBound: 200, durationSourceRef: "source:duration", grossSupport: {
      minimum: -1, maximum: 1, sourceRef: "source:gross-support" } } }, input.candidates[1]!] });

  assert.deepEqual(unresolved.negative, []);
  const zeroLater = assess({ ...input, candidates: [{ ...known,
    readiness: { kind: "ready", sourceRef: "business:now", now: 100, nextHandoff: { at: 300, sourceRef: "business:next" } },
    target: { kind: "deadline", sourceRef: "source:use-window", useBy: 200, durationUpperBound: 0,
      durationSourceRef: "source:instantaneous-completion" } }, input.candidates[1]!] });

  assert.deepEqual(zeroLater.negative, []);
});

test("stage-objective utility fees require an explicit economic-unit fee instead of silently copying numbers", () => {
  const input = fixture(), known = input.candidates[0]!;
  const charged = { ...input, candidates: [{ ...known, fee: { kind: "utility" as const, sourceRef: "pursuit:fee", now: 1, atHandoff: 1 } },
    input.candidates[1]!] };
  const gap = assess(charged);

  assert.deepEqual(gap.assessments, []);
  assert.deepEqual(gap.negative, []);
  assert.equal(gap.unusable[0]!.reason, "economic_fee_unit_binding_required");
  const converted = assess({ ...charged, valueBindings: [{ opportunityId: "opportunity:known", targetKey: target.key,
    conditionRef: condition, policyFamilyRef: "response-family:tool", sourceRef: "domain:economic-confirmation",
    fee: { kind: "hard-budget-only", sourceRef: "domain:economic-fee-contract" } }] });

  assert.equal(converted.assessments.length, 1);
  near(converted.negative[0]!.netValue, -.25);
});
