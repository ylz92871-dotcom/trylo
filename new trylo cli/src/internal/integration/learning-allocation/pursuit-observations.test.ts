import assert from "node:assert/strict";
import test from "node:test";
import { emptyBoardState } from "../../learning/control/state.js";
import type { BoardState } from "../../learning/control/state.js";
import type { RewardV2Draft } from "../../learning/reward/v2-facts.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { isCentralPursuitObjective, isCentralPursuitObservation } from "../../learning/control/decision/pursuit-validation.js";
import { createCentralPursuitObservationDraft, readCentralPursuitObservations } from "./pursuit-observations.js";
import type { CentralPursuitObservationDraft } from "./pursuit-observations.js";

const scope = "workspace:pursuit-observation";

function observation(outcome: CentralPursuitObservationDraft["outcome"] = "pending"): CentralPursuitObservationDraft {
  return { unitId: "unit:one", scope, conditionRef: "condition:typescript", objective: { instanceId: "objective:one",
    criterion: "checker_verified", definitionRef: "criterion:external-check-v1", familyRef: "protocol:tool-research-v1",
    familySourceRef: "source:tool-protocol" }, grantId: "grant:one", stageRef: "stage:one",
    sourceRef: "source:original-check", revisionRef: "revision:one", outcome };
}

function draft(input = observation()): RewardV2Draft {
  const result = createCentralPursuitObservationDraft(input);
  if (result.status !== "ready") assert.fail(result.reason);
  return result.value;
}

function board(...facts: readonly RewardV2Draft[]): BoardState {
  return { ...emptyBoardState(), sequence: facts.length, rewardV2Facts: facts.map((fact, index) => ({ ...fact, sequence: index + 1 })) };
}

function read(...facts: readonly RewardV2Draft[]) {
  const result = readCentralPursuitObservations(board(...facts), scope);
  if (result.status !== "ready") assert.fail(result.reason);
  return result;
}

test("shared guards validate every causal identity and preserve qualification levels", () => {
  const row = observation();

  for (const criterion of ["proposal_delivered", "checker_verified", "adopted"] as const) {
    assert.ok(isCentralPursuitObjective({ ...row.objective, criterion }));
  }

  for (const outcome of ["qualified", "closed_no_result", "pending"] as const) assert.ok(isCentralPursuitObservation({ ...row, sequence: 1, outcome }));

  for (const key of ["unitId", "scope", "conditionRef", "grantId", "stageRef", "sourceRef", "revisionRef"]) {
    assert.equal(isCentralPursuitObservation({ ...row, sequence: 1, [key]: "" }), false);
  }

  for (const key of ["instanceId", "definitionRef", "familyRef", "familySourceRef"]) {
    assert.equal(isCentralPursuitObjective({ ...row.objective, [key]: "" }), false);
  }

  assert.equal(isCentralPursuitObservation({ ...row, sequence: 1, outcome: "completed" }), false);
  assert.equal(isCentralPursuitObservation({ ...row, sequence: 0 }), false);
});

test("drafts are deterministic original-writer facts without a caller-supplied source sequence", () => {
  const source = observation(), first = draft(source), before = JSON.stringify(source);

  assert.deepEqual(first, draft({ ...source }));
  assert.equal(first.algorithmVersion, "central-pursuit-outcome-v1");
  assert.equal(first.kind, "feedback");
  assert.equal(first.payloadJson, canonicalJson({ schemaVersion: 1, observation: source }));
  assert.equal(first.id, `pursuit-observation:${contentHashOf({ schemaVersion: 1, observation: source })}`);
  const extra = { ...source, sequence: 99 };

  assert.equal(createCentralPursuitObservationDraft(extra).status, "invalid");
  const result = read(first);

  assert.equal(result.observations[0]?.sequence, 1);
  assert.equal(result.observations[0]?.outcome, "pending");
  assert.deepEqual(result.heads, [{ unitId: source.unitId, factId: first.id }]);
  assert.equal(JSON.stringify(source), before);
});

test("one effective revision replaces pending or qualified labels without creating another trial", () => {
  const first = draft(), second = draft({ ...observation("qualified"), revisionRef: "revision:two", sourceRef: "checker:verified",
    supersedes: first.id }), third = draft({ ...observation("closed_no_result"), revisionRef: "revision:three",
    sourceRef: "checker:correction", supersedes: second.id });
  const result = read(first, second, third);

  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0]?.outcome, "closed_no_result");
  assert.equal(result.observations[0]?.sequence, 3);
  assert.deepEqual(result.heads, [{ unitId: "unit:one", factId: third.id }]);
  assert.notEqual(read(first).sourceRef, result.sourceRef);
});

test("duplicate facts, unlinked duplicate units and revision forks are rejected", () => {
  const first = draft(), unlinked = draft({ ...observation("qualified"), revisionRef: "revision:unlinked" });
  const second = draft({ ...observation("qualified"), revisionRef: "revision:two", supersedes: first.id });
  const fork = draft({ ...observation("closed_no_result"), revisionRef: "revision:fork", supersedes: first.id });
  for (const state of [board(first, first), board(first, unlinked), board(first, second, fork)]) {
    assert.equal(readCentralPursuitObservations(state, scope).status, "invalid");
  }
});

test("revision parents must already exist in the same source prefix and unit", () => {
  const first = draft(), forward = draft({ ...observation("qualified"), revisionRef: "revision:forward", supersedes: first.id });
  assert.equal(readCentralPursuitObservations(board(forward, first), scope).status, "invalid");
  const otherUnit = draft({ ...observation("qualified"), unitId: "unit:other", revisionRef: "revision:other", supersedes: first.id });
  assert.equal(readCentralPursuitObservations(board(first, otherUnit), scope).status, "invalid");
  const reused = draft({ ...observation("qualified"), supersedes: first.id });
  assert.equal(readCentralPursuitObservations(board(first, reused), scope).status, "invalid");
});

test("corrections cannot silently change the objective, condition, grant or actual stage", () => {
  const first = draft();
  for (const input of [
    { ...observation("qualified"), objective: { ...observation().objective, criterion: "adopted" as const } },
    { ...observation("qualified"), conditionRef: "condition:other" },
    { ...observation("qualified"), grantId: "grant:other" },
    { ...observation("qualified"), stageRef: "stage:other" },
  ]) {
    const revision = draft({ ...input, revisionRef: "revision:two", supersedes: first.id });
    assert.equal(readCentralPursuitObservations(board(first, revision), scope).status, "invalid");
  }
});

test("corrupt source identities and future or reordered facts fail closed while legacy formats coexist", () => {
  const first = draft(), second = draft({ ...observation(), unitId: "unit:two" });

  assert.equal(readCentralPursuitObservations(board({ ...first, id: "not-the-content-id" }), scope).status, "invalid");
  assert.equal(readCentralPursuitObservations(board({ ...first, kind: "learning_decision" }), scope).status, "invalid");
  const state = board(first, second);

  assert.equal(readCentralPursuitObservations({ ...state, sequence: 1 }, scope).status, "invalid");
  assert.equal(readCentralPursuitObservations({ ...state, rewardV2Facts: [...state.rewardV2Facts!].reverse() }, scope).status, "invalid");
  const legacy: RewardV2Draft = { id: "legacy:one", scope, kind: "feedback", algorithmVersion: "other-owner-v1", payloadJson: "{}" };

  assert.equal(read(legacy, first).observations.length, 1);
});

test("explicit resource models require a frozen treatment and use a distinct v2 storage discriminator", () => {
  const source = observation(), objective = { ...source.objective,
    resourceModel: { kind: "shared_or_exact_treatment" as const, sourceRef: "source:resource-model" } };

  assert.equal(createCentralPursuitObservationDraft({ ...source, objective }).status, "invalid");
  const modeled = draft({ ...source, objective, treatmentRef: "treatment:exact-offer-hash" });

  assert.equal(modeled.algorithmVersion, "central-pursuit-outcome-v2");
  assert.equal(JSON.parse(modeled.payloadJson).schemaVersion, 2);
  assert.equal(read(modeled).observations[0]?.treatmentRef, "treatment:exact-offer-hash");
  assert.deepEqual(read(modeled).observations[0]?.objective.resourceModel, objective.resourceModel);
  assert.equal(isCentralPursuitObjective({ ...objective, resourceModel: { ...objective.resourceModel, sourceRef: "" } }), false);
  assert.equal(isCentralPursuitObservation({ ...source, sequence: 1, treatmentRef: "" }), false);
});

test("flat v1 history can receive a source-backed treatment refinement without changing its statistical objective", () => {
  const first = draft(), refined = draft({ ...observation(), treatmentRef: "treatment:exact-offer-hash",
    sourceRef: "source:original-treatment-recovered", revisionRef: "revision:refined", supersedes: first.id });

  assert.equal(refined.algorithmVersion, "central-pursuit-outcome-v2");
  const result = read(first, refined);

  assert.equal(result.observations.length, 1);
  assert.deepEqual(result.observations[0]?.objective, observation().objective);
  assert.equal(result.observations[0]?.objective.resourceModel, undefined);
  assert.equal(result.observations[0]?.treatmentRef, "treatment:exact-offer-hash");
});

test("a known treatment cannot change or disappear and model definitions cannot silently migrate", () => {
  const initial = draft({ ...observation(), treatmentRef: "treatment:one" });

  for (const corrected of [{ ...observation(), treatmentRef: "treatment:two" }, observation()]) {
    const next = draft({ ...corrected, revisionRef: "revision:changed", supersedes: initial.id });
    assert.equal(readCentralPursuitObservations(board(initial, next), scope).status, "invalid");
  }

  const legacy = draft(), objective = { ...observation().objective,
    resourceModel: { kind: "shared_or_exact_treatment" as const, sourceRef: "source:model-class" } };
  const migrated = draft({ ...observation(), objective, treatmentRef: "treatment:one", revisionRef: "revision:model-added", supersedes: legacy.id });

  assert.equal(readCentralPursuitObservations(board(legacy, migrated), scope).status, "invalid");
  const modeled = draft({ ...observation(), objective, treatmentRef: "treatment:one" });
  const changed = draft({ ...observation(), objective: { ...objective, resourceModel: { ...objective.resourceModel, sourceRef: "source:other-model" } },
    treatmentRef: "treatment:one", revisionRef: "revision:model-changed", supersedes: modeled.id });

  assert.equal(readCentralPursuitObservations(board(modeled, changed), scope).status, "invalid");
});

test("new treatment semantics cannot be mislabeled as legacy v1 or decoded under a mismatched schema", () => {
  const modeled = draft({ ...observation(), treatmentRef: "treatment:exact" });
  assert.equal(readCentralPursuitObservations(board({ ...modeled, algorithmVersion: "central-pursuit-outcome-v1" }), scope).status, "invalid");
  const original = draft();
  assert.equal(readCentralPursuitObservations(board({ ...original, algorithmVersion: "central-pursuit-outcome-v2" }), scope).status, "invalid");
});
