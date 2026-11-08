import assert from "node:assert/strict";
import test from "node:test";
import { emptyBoardState } from "../../learning/control/state.js";
import type { BoardState } from "../../learning/control/state.js";
import { reduce } from "../../learning/control/reducer.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import type { RewardV2Draft } from "../../learning/reward/v2-facts.js";
import { activeEmpiricalTopicSupport } from "../../learning/domains/shared/topics/empirical-model.js";
import type { TopicMeasurementSelector, TopicPairedMeasurement } from "../../learning/domains/shared/topics/empirical-model.js";
import { isCentralResponseProtocol } from "./response-protocol.js";
import type { CentralResponseProtocol } from "./response-protocol.js";
import { createCentralResponseWindowDraft, centralResponseRegistrationsOf, centralResponseWindowsOf } from "./response-registration.js";
import type { CentralResponseWindowRegistration } from "./response-registration.js";
import { isCentralResponseTarget } from "../../learning/control/decision/prediction-validation.js";
import type { CentralResponseTarget } from "../../learning/control/decision/prediction-input.js";

const scope = "workspace:response-protocol";
const target = { key: "target:window", utilityUnit: "utility:window", referenceKey: "population:use-window",
  baselineRuleKey: "rule:frozen-baseline", windowRef: "window:one-use" };

function registration(unitId = "unit:one"): CentralResponseWindowRegistration {
  return { unitId, grantId: "grant:one", measurementIds: [`measurement:${unitId}`],
    comparison: { kind: "deployed_learning_vs_frozen_baseline", resultRef: "result:one", adoptionRef: "adoption:one",
      registrationRef: "source:registered", baselineRuleKey: target.baselineRuleKey },
    opportunity: { opportunityId: "opportunity:one", scope, targetRef: target.key, instanceRef: "stage:one", sourceRef: "source:one",
      stage: "initial", conditionRef: "condition:one", baselineRef: "baseline:one", windowRef: target.windowRef,
      offer: { offerId: "offer:one", owner: { plane: "agent", domain: "tool" }, policyRef: "executable-policy:revision1",
        reserve: { tokens: 100, calls: 1, steps: 1 }, maxPromptChars: 1000 } } };
}

function protocol(): CentralResponseProtocol {
  return { scope, experimentRef: "experiment:paired-deployment", experimentVersion: "1", conditionHash: "condition:one",
    utilityUnit: target.utilityUnit, deltaBounds: { minimum: -1, maximum: 1, sourceRef: "objective:hard-support" },
    policyFamilyRef: "response-family:stable-stop-v1", familySourceRef: "source:semantic-family" };
}

function draft(unitId: string, source?: CentralResponseProtocol) {
  const result = createCentralResponseWindowDraft(registration(unitId), target, source);
  if (result.status !== "ready") assert.fail(result.reason);
  return result.value;
}

function board(...facts: readonly RewardV2Draft[]): BoardState {
  return { ...emptyBoardState(), sequence: facts.length,
    rewardV2Facts: facts.map((fact, index) => ({ ...fact, sequence: index + 1 })) };
}

test("legacy registration IDs and serialized payload retain their exact v1 recipe", () => {
  const input = registration(), result = draft(input.unitId);

  assert.equal(result.id, `response-registration:${contentHashOf([target, input])}`);
  assert.equal(result.algorithmVersion, "central-response-window-v1");
  assert.equal(result.payloadJson, canonicalJson({ schemaVersion: 1, target, registration: input }));
  const decoded = centralResponseRegistrationsOf(board(result), scope);
  if (decoded.status !== "ready") assert.fail(decoded.reason);

  assert.equal(decoded.value[0]?.protocol, null);
  assert.equal(decoded.value[0]?.window.registeredAtSequence, 1);
});

test("v2 protocol metadata survives the original Board writer and canonical lookup", () => {
  const source = protocol(), fact = draft("unit:v2", source);

  assert.equal(fact.algorithmVersion, "central-response-window-v2");
  const legacyPayload = { schemaVersion: 2, target, registration: registration("unit:v2"), protocol: source };

  assert.equal(fact.id, `response-registration:${contentHashOf(legacyPayload)}`);
  assert.equal(fact.payloadJson, canonicalJson(legacyPayload));
  const written = reduce(emptyBoardState(), { type: "record_reward_v2_fact", commandId: "register:protocol-v2",
    issuedAt: "2026-11-04T15:00:00.000Z", expectedSequence: 0, fact });
  if (!written.ok) assert.fail(written.reason);

  const decoded = centralResponseRegistrationsOf(written.state, scope);
  if (decoded.status !== "ready") assert.fail(decoded.reason);

  assert.deepEqual(decoded.value[0]?.protocol, source);
  assert.equal(decoded.value[0]?.factId, fact.id);
  assert.equal(decoded.value[0]?.window.registeredAtSequence, written.state.sequence);
  assert.equal(decoded.value[0]?.window.opportunity.offer.policyRef, "executable-policy:revision1");
  const oldProjection = centralResponseWindowsOf(written.state, target, scope);
  if (oldProjection.status !== "ready") assert.fail(oldProjection.reason);

  assert.equal(oldProjection.value[0]?.unitId, "unit:v2");
});

test("explicit response estimands use v3 and retain their declared contrast with optional protocol metadata", () => {
  assert.ok(isCentralResponseTarget(target));
  assert.ok(isCentralResponseTarget({ ...target, estimand: "learning_policy_response" }));
  assert.equal(isCentralResponseTarget({ ...target, estimand: "adopted_means_policy" }), false);

  for (const source of [undefined, protocol()]) {
    const explicitTarget: CentralResponseTarget = { ...target, estimand: "deployment_response" };
    const created = createCentralResponseWindowDraft(registration(), explicitTarget, source);
    if (created.status !== "ready") assert.fail(created.reason);

    const payload: { readonly schemaVersion: 3; readonly target: CentralResponseTarget;
      readonly registration: CentralResponseWindowRegistration; readonly protocol: CentralResponseProtocol | null } = {
      schemaVersion: 3, target: explicitTarget, registration: registration(), protocol: source ?? null };

    assert.equal(created.value.algorithmVersion, "central-response-window-v3");
    assert.equal(created.value.payloadJson, canonicalJson(payload));
    assert.equal(created.value.id, `response-registration:${contentHashOf(payload)}`);
    const decoded = centralResponseRegistrationsOf(board(created.value), scope);
    if (decoded.status !== "ready") assert.fail(decoded.reason);

    assert.deepEqual(decoded.value[0]?.target, explicitTarget);
    assert.deepEqual(decoded.value[0]?.protocol, source ?? null);
  }
});

test("whole-policy contrasts cannot be relabelled as deployment responses or stored under legacy algorithms", () => {
  const fullTarget = { ...target, estimand: "learning_policy_response" as const }, original = registration();
  const full = { ...original, comparison: { kind: "learning_policy_vs_frozen_baseline" as const, assignmentRef: "pursuit-observation:initial",
    registrationRef: "source:policy-assignment", baselineRuleKey: target.baselineRuleKey } };

  assert.equal(createCentralResponseWindowDraft(original, fullTarget).status, "invalid");
  assert.equal(createCentralResponseWindowDraft({ ...original, comparison: { kind: "unqualified", reason: "not-adopted" } }, fullTarget).status, "invalid");
  assert.equal(createCentralResponseWindowDraft(full, target).status, "invalid");
  assert.equal(createCentralResponseWindowDraft(full, { ...target, estimand: "deployment_response" }).status, "invalid");
  const valid = createCentralResponseWindowDraft(full, fullTarget, protocol());
  if (valid.status !== "ready") assert.fail(valid.reason);

  assert.equal(centralResponseRegistrationsOf(board(valid.value), scope).status, "ready");

  for (const schemaVersion of [1, 2]) {
    const payload = schemaVersion === 1 ? { schemaVersion, target: fullTarget, registration: full }
      : { schemaVersion, target: fullTarget, registration: full, protocol: protocol() };
    const disguised: RewardV2Draft = { ...valid.value, algorithmVersion: `central-response-window-v${schemaVersion}`, payloadJson: canonicalJson(payload) };
    assert.equal(centralResponseRegistrationsOf(board(disguised), scope).status, "invalid");
  }
});

test("v1 and distinct same-condition v2 protocols coexist without guessed legacy bounds", () => {
  const source = protocol(), facts = [draft("unit:v1"), draft("unit:v2a", source),
    draft("unit:v2b", { ...source, experimentRef: "experiment:another", experimentVersion: "2" })];
  const decoded = centralResponseRegistrationsOf(board(...facts), scope);
  if (decoded.status !== "ready") assert.fail(decoded.reason);

  assert.equal(decoded.value.length, 3);
  assert.equal(decoded.value[0]?.protocol, null);
  assert.equal(decoded.value[2]?.protocol?.experimentRef, "experiment:another");
  assert.notEqual(facts[1]?.id, facts[2]?.id);
});

test("protocol guards require source identities and real ordered finite supports", () => {
  const source = protocol();

  assert.ok(isCentralResponseProtocol(source));
  assert.ok(isCentralResponseProtocol({ ...source, deltaBounds: { minimum: 0, maximum: 0, sourceRef: "support:deterministic" } }));

  for (const field of ["scope", "experimentRef", "experimentVersion", "conditionHash", "utilityUnit", "policyFamilyRef", "familySourceRef"]) {
    assert.equal(isCentralResponseProtocol({ ...source, [field]: "" }), false);
  }

  for (const deltaBounds of [{ minimum: 1, maximum: -1, sourceRef: "support:x" },
    { minimum: -1, maximum: Infinity, sourceRef: "support:x" }, { minimum: -1, maximum: 1, sourceRef: "" }]) {
    assert.equal(isCentralResponseProtocol({ ...source, deltaBounds }), false);
  }

  assert.equal(isCentralResponseProtocol({ ...source, priorStrength: 1 }), false);
});

test("registration protocol must match the real scope, condition and target unit", () => {
  for (const source of [{ ...protocol(), scope: "workspace:other" }, { ...protocol(), conditionHash: "condition:other" },
    { ...protocol(), utilityUnit: "utility:other" }]) {
    assert.equal(createCentralResponseWindowDraft(registration(), target, source).status, "invalid");
  }
  const before = draft("unit:a", protocol()), after = draft("unit:a", { ...protocol(), policyFamilyRef: "response-family:changed" });
  assert.notEqual(before.id, after.id);
});

test("canonical lookup rejects altered identities, invalid prefixes and duplicate target units", () => {
  const first = draft("unit:a", protocol()), changed = draft("unit:a", { ...protocol(), experimentVersion: "2" });

  assert.equal(centralResponseRegistrationsOf(board(first, changed), scope).status, "invalid");
  assert.equal(centralResponseRegistrationsOf(board({ ...first, id: "incorrect:id" }), scope).status, "invalid");
  assert.equal(centralResponseRegistrationsOf({ ...board(first), sequence: 0 }, scope).status, "invalid");
  const raw = JSON.parse(first.payloadJson);
  const altered = { ...first, payloadJson: canonicalJson({ ...raw, protocol: { ...protocol(), deltaBounds: {
    minimum: -2, maximum: 2, sourceRef: "support:altered" } } }) };

  assert.equal(centralResponseRegistrationsOf(board(altered), scope).status, "invalid");
});

test("the canonical active measurement resolver needs only its selector, not unused model assumptions", () => {
  const selector: TopicMeasurementSelector = { scope, experimentRef: "experiment:one", experimentVersion: "1",
    conditionHash: "condition:one", utilityUnit: target.utilityUnit };
  const original: TopicPairedMeasurement = { ...selector, id: "pair:one", sequence: 1, sourceRef: "checker:one", kind: "measured",
    baselineUtility: 0, candidateUtility: .5, fullStudyCost: 10 };
  const correction: TopicPairedMeasurement = { ...original, id: "pair:two", sequence: 2, sourceRef: "checker:two",
    candidateUtility: -.5, supersedes: original.id };

  assert.deepEqual(activeEmpiricalTopicSupport(selector, [original, correction], 2), [correction]);
});
