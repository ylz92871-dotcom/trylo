import assert from "node:assert/strict";
import test from "node:test";
import { emptyBoardState, type BoardState } from "../../learning/control/state.js";
import type { CentralPursuitCandidate } from "../../learning/control/decision/pursuit-contract.js";
import type { CentralResponseTarget } from "../../learning/control/decision/prediction-input.js";
import type { RewardV2Draft } from "../../learning/reward/v2-facts.js";
import { canonicalJson } from "../../learning/control/hash.js";
import { createCentralResponseWindowDraft } from "./response-registration.js";
import type { CentralResponseProtocol } from "./response-protocol.js";
import { lookupCentralResponseEvidence, type CentralResponseDiscoveryBinding } from "./response-discovery.js";

const scope = "workspace:response-discovery", condition = "c".repeat(64);
const target: CentralResponseTarget = { key: "target:economic-window", utilityUnit: "utility:verified-window",
  referenceKey: "population:registered-use", baselineRuleKey: "baseline:frozen-deployment-rule", windowRef: "window:one-real-use" };

function candidate(id = "current"): CentralPursuitCandidate {
  const policyRef = "policy:tool-research-v1";
  return {
    opportunity: { opportunityId: `opportunity:${id}`, scope, targetRef: target.key, instanceRef: `stage:${id}`,
      sourceRef: `source:${id}`, stage: "initial", conditionRef: condition, baselineRef: `baseline:actual-${id}`,
      windowRef: target.windowRef, offer: { offerId: `offer:${id}`, owner: { plane: "agent", domain: "tool" },
        policyRef, reserve: { tokens: 1000, calls: 1, steps: 1 }, maxPromptChars: 4000 } },
    source: { issueId: `issue:${id}`, grantId: `grant:${id}`, sourceBindingRef: `source-binding:${id}`,
      domainStage: { stageRef: `stage:${id}`, kind: "initial", policyRef, sourceReportId: `report:${id}`,
        readiness: { kind: "ready", evidenceRefs: [`source:${id}`] } } },
    readiness: { kind: "ready", sourceRef: "business:idle", now: 100, nextHandoff: null },
    target: { kind: "boundary-independent", sourceRef: "source:fixed-window" },
    fee: { kind: "hard-budget-only", sourceRef: "source:hard-cap" }, purpose: "focused_learning",
    objective: { instanceId: `objective:${id}`, criterion: "proposal_delivered", definitionRef: "criterion:proposal",
      familyRef: "pursuit-family:research", familySourceRef: "source:pursuit-family" },
  };
}

function protocol(unit = target.utilityUnit): CentralResponseProtocol {
  return { scope, experimentRef: "experiment:deployment-pair", experimentVersion: "1", conditionHash: condition,
    utilityUnit: unit, deltaBounds: { minimum: -1, maximum: 1, sourceRef: "source:hard-effect-bounds" },
    policyFamilyRef: "response-family:research", familySourceRef: "source:response-equivalence" };
}

function registration(id: string, targetValue = target, withProtocol = true): RewardV2Draft {
  const opportunity = candidate(`history-${id}`).opportunity;
  const result = createCentralResponseWindowDraft({ unitId: `unit:${id}`, grantId: `grant:history-${id}`,
    opportunity: { ...opportunity, targetRef: targetValue.key, windowRef: targetValue.windowRef }, measurementIds: [`pair:${id}`],
    comparison: { kind: "deployed_learning_vs_frozen_baseline", resultRef: `result:${id}`, adoptionRef: `adoption:${id}`,
      registrationRef: `registration:${id}`, baselineRuleKey: targetValue.baselineRuleKey } }, targetValue,
  withProtocol ? protocol(targetValue.utilityUnit) : undefined);
  if (result.status !== "ready") assert.fail(result.reason);

  return result.value;
}

function measurement(id: string, experimentRef = "experiment:deployment-pair"): RewardV2Draft {
  return { id: `pair:${id}`, scope, kind: "feedback", algorithmVersion: "ws1-paired-measurement-v1",
    payloadJson: canonicalJson({ schemaVersion: 1, type: "ws1_paired_measurement", observationBinding: null,
      measurement: { id: `pair:${id}`, scope, experimentRef, experimentVersion: "1", conditionHash: condition,
        utilityUnit: target.utilityUnit, sourceRef: `checker:${id}`, kind: "measured",
        baselineUtility: 0, candidateUtility: .25, fullStudyCost: 100 } }) };
}

function board(...facts: readonly RewardV2Draft[]): BoardState {
  return { ...emptyBoardState(), sequence: facts.length,
    rewardV2Facts: facts.map((fact, index) => ({ ...fact, sequence: index + 1 })) };
}

function lookup(value: BoardState, candidates = [candidate()], bindings?: readonly CentralResponseDiscoveryBinding[]) {
  const result = lookupCentralResponseEvidence({ board: value, scope, candidates, ...(bindings === undefined ? {} : { bindings }) });
  if (result.status !== "ready") assert.fail(result.reason);
  return result;
}

test("canonical v2 discovery keeps the actual stage identity and native protocol metadata", () => {
  const current = candidate(), original = JSON.stringify(current), value = board(registration("one"));
  const result = lookup(value, [current]), group = result.groups[0]!;

  assert.deepEqual(result.unmatched, []);
  assert.deepEqual(group.target, target);
  assert.deepEqual(group.protocols[0]!.protocol, protocol());
  assert.deepEqual(group.opportunities[0], current.opportunity);
  assert.equal(group.opportunities[0]!.baselineRef, "baseline:actual-current");
  assert.equal(group.registrations[0]!.window.opportunity.baselineRef, "baseline:actual-history-one");
  assert.ok(group.familyBindings.some(row => row.instanceRef === current.opportunity.instanceRef));
  assert.equal(JSON.stringify(current), original);
});

test("same-domain labels do not transport a changed policy, condition, owner or stage without an explicit binding", () => {
  const current = candidate(), value = board(registration("one"));
  for (const opportunity of [
    { ...current.opportunity, offer: { ...current.opportunity.offer, policyRef: "policy:different" } },
    { ...current.opportunity, conditionRef: "other-condition" },
    { ...current.opportunity, offer: { ...current.opportunity.offer, owner: { plane: "agent" as const, domain: "skill" as const } } },
    { ...current.opportunity, stage: "continuation" as const },
  ]) {
    const result = lookup(value, [{ ...current, opportunity }]);
    assert.deepEqual(result.groups, []);
    assert.equal(result.unmatched[0]!.reason, "response_registration_not_matched");
  }
});

test("explicit economic target remapping requires this stage's sourced baseline under the target rule", () => {
  const current = candidate(), other = { ...target, key: "target:another-value", windowRef: "window:another-use" };
  const value = board(registration("one", other)), binding: CentralResponseDiscoveryBinding = {
    opportunityId: current.opportunity.opportunityId, targetKey: other.key, conditionRef: condition,
    policyFamilyRef: protocol().policyFamilyRef, sourceRef: "domain:current-target-confirmed" };

  assert.equal(lookup(value, [current], [binding]).unmatched[0]!.reason, "response_baseline_binding_required");
  const bound = { ...binding, baseline: { ruleKey: other.baselineRuleKey,
    instanceRef: "baseline:current-sourced-economic-instance", sourceRef: "domain:current-baseline" } };
  const mapped = lookup(value, [current], [bound]).groups[0]!.opportunities[0]!;

  assert.equal(mapped.targetRef, other.key);
  assert.equal(mapped.windowRef, other.windowRef);
  assert.equal(mapped.baselineRef, bound.baseline.instanceRef);
  assert.equal(mapped.instanceRef, current.opportunity.instanceRef);
  assert.equal(mapped.sourceRef, current.opportunity.sourceRef);
  assert.deepEqual(mapped.offer, current.opportunity.offer);
  assert.equal(lookup(value, [current], [{ ...bound, baseline: { ...bound.baseline, ruleKey: "rule:wrong" } }])
    .unmatched[0]!.reason, "response_baseline_binding_required");
});

test("a sourced explicit binding maps a generic pursuit condition into its economic family without crossing owner or stage", () => {
  const original = candidate(), current: CentralPursuitCandidate = { ...original, opportunity: { ...original.opportunity,
    targetRef: "target:generic-stage-proposal", conditionRef: "condition:generic-proposal", windowRef: "window:stage-goal" } };
  const value = board(registration("economic")), binding: CentralResponseDiscoveryBinding = {
    opportunityId: current.opportunity.opportunityId, targetKey: target.key, conditionRef: condition,
    policyFamilyRef: protocol().policyFamilyRef, sourceRef: "domain:generic-stage-economic-applicability",
    baseline: { ruleKey: target.baselineRuleKey, instanceRef: "baseline:current-economic-instance", sourceRef: "domain:baseline-instance" } };

  assert.equal(lookup(value, [current]).groups.length, 0);
  const mapped = lookup(value, [current], [binding]).groups[0]!.opportunities[0]!;

  assert.equal(mapped.conditionRef, condition);
  assert.equal(mapped.targetRef, target.key);
  assert.equal(mapped.baselineRef, binding.baseline!.instanceRef);
  assert.equal(mapped.instanceRef, current.opportunity.instanceRef);
  assert.equal(mapped.sourceRef, current.opportunity.sourceRef);
  assert.deepEqual(mapped.offer, current.opportunity.offer);

  for (const opportunity of [
    { ...current.opportunity, stage: "continuation" as const },
    { ...current.opportunity, offer: { ...current.opportunity.offer, owner: { plane: "agent" as const, domain: "skill" as const } } },
  ]) {
    const rejected = lookup(value, [{ ...current, opportunity }], [binding]);
    assert.deepEqual(rejected.groups, []);
    assert.equal(rejected.unmatched[0]!.reason, "response_registration_not_matched");
  }

  const differentCondition = lookup(value, [current], [{ ...binding, conditionRef: "condition:other-economic" }]);

  assert.deepEqual(differentCondition.groups, []);
});

test("complete target identity separates units and baselines, and ambiguous matches are not ranked", () => {
  const otherUnit = { ...target, utilityUnit: "utility:incomparable" };
  const result = lookup(board(registration("one"), registration("two", otherUnit)));

  assert.deepEqual(result.groups, []);
  assert.equal(result.unmatched[0]!.reason, "response_target_ambiguous");
  const other = { ...target, key: "target:second", baselineRuleKey: "baseline:other-rule" };
  const second = candidate("second");
  const separate = lookup(board(registration("one"), registration("two", other)), [candidate(),
    { ...second, opportunity: { ...second.opportunity, targetRef: other.key } }]);

  assert.equal(separate.groups.length, 2);
  assert.deepEqual(separate.groups.map(group => group.target.baselineRuleKey), [target.baselineRuleKey, other.baselineRuleKey]);
});

test("mature v1 discovers only the real measurement selector, and never invents bounds or a response family", () => {
  const mature = lookup(board(registration("legacy", target, false), measurement("legacy"))), group = mature.groups[0]!;

  assert.deepEqual(mature.unmatched, []);
  assert.equal(group.protocols[0]!.protocol, null);
  assert.deepEqual(group.protocols[0]!.selector, { scope, experimentRef: "experiment:deployment-pair", experimentVersion: "1",
    conditionHash: condition, utilityUnit: target.utilityUnit });
  assert.deepEqual(group.familyBindings, []);
  const absent = lookup(board(registration("legacy", target, false)));

  assert.deepEqual(absent.groups, []);
  assert.equal(absent.unmatched[0]!.reason, "response_legacy_selector_unidentified");
});

test("legacy mixed comparison members and invalid canonical identities do not become qualified evidence", () => {
  const legacy = registration("legacy", target, false), raw = JSON.parse(legacy.payloadJson);
  const amended = createCentralResponseWindowDraft({ ...raw.registration, measurementIds: ["pair:legacy", "pair:other"] }, target);
  if (amended.status !== "ready") assert.fail(amended.reason);

  const mixed = lookup(board(amended.value, measurement("legacy"), measurement("other", "experiment:different")));

  assert.deepEqual(mixed.groups, []);
  assert.equal(mixed.unmatched[0]!.reason, "response_legacy_selector_unidentified");
  assert.equal(lookupCentralResponseEvidence({ board: board({ ...legacy, id: "tampered:registration" }), scope,
    candidates: [candidate()] }).status, "invalid");
  assert.equal(lookupCentralResponseEvidence({ board: board(legacy), scope, candidates: [candidate()],
    bindings: [{ opportunityId: "opportunity:absent", targetKey: target.key, conditionRef: condition,
      policyFamilyRef: "family:x", sourceRef: "source:x" }] }).status, "invalid");
});
