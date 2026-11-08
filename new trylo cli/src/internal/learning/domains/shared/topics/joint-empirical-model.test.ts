import test from "node:test";
import assert from "node:assert/strict";
import { buildJointEmpiricalModel, readJointMeasurement, readJointOutcome, type JointEmpiricalPolicy,
  type JointOutcome, type TopicJointMeasurement } from "./joint-empirical-model.js";
import { readInformationModel, type InformationDecision } from "./information-model.js";
import { applyTopicObservation } from "./information-observation.js";
import { contentHashOf } from "../../../control/hash.js";

type Measured = Extract<TopicJointMeasurement, { kind: "measured" }>;

// These measured-record fixtures exercise current-target diagnostics, not policy-learning gain or real checker authentication.
const POLICY: JointEmpiricalPolicy = { scope: "joint-diagnostics", protocolId: "checked-two-field", protocolVersion: "1",
  conditionHash: "a".repeat(64), utilityUnit: "diagnostic-goal", futureUses: 0.5, utilityScale: 8,
  utilityBounds: { minimum: 0, maximum: 8 }, priorStrength: 2, actions: ["keep", "switch"], questions: [
    { experimentRef: "left", experimentVersion: "1", units: 1, outcomes: ["0", "1"] },
    { experimentRef: "right", experimentVersion: "1", units: 2, outcomes: ["0", "1"] }] };
const DECISION: InformationDecision = { initialState: "current", states: [
  { id: "current", action: 0, transitions: [{ questionId: "q:left", next: ["l0", "l1"] }, { questionId: "q:right", next: ["r0", "r1"] }] },
  { id: "l0", action: 0, transitions: [{ questionId: "q:right", next: ["zero", "one"] }] },
  { id: "l1", action: 0, transitions: [{ questionId: "q:right", next: ["zero", "one"] }] },
  { id: "r0", action: 0, transitions: [{ questionId: "q:left", next: ["zero", "one"] }] },
  { id: "r1", action: 0, transitions: [{ questionId: "q:left", next: ["zero", "one"] }] },
  { id: "zero", action: 0, transitions: [] }, { id: "one", action: 1, transitions: [] }] };

function near(actual: number, expected: number): void { assert.ok(Math.abs(actual - expected) < 2e-12, `${actual} != ${expected}`); }

function measurement(input: { readonly id: string; readonly episodeId: string; readonly sequence: number;
  readonly vector: readonly [string, string]; readonly utilities: readonly [number, number]; readonly costs: readonly [number, number]; readonly supersedes?: string }): Measured {
  return { id: input.id, episodeId: input.episodeId, sequence: input.sequence, scope: POLICY.scope,
    protocolId: POLICY.protocolId, protocolVersion: POLICY.protocolVersion, conditionHash: POLICY.conditionHash, utilityUnit: POLICY.utilityUnit,
    sourceRef: `checker:${input.id}`, ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }), kind: "measured",
    observations: ["left", "right"].map((experimentRef, index) => ({ experimentRef, experimentVersion: "1",
      outcome: input.vector[index]!, fullStudyCost: input.costs[index]!, checkRef: `checker:${input.id}:${experimentRef}` })),
    actionUtilities: ["keep", "switch"].map((actionId, index) => ({ actionId, value: input.utilities[index]!, checkRef: `checker:${input.id}:${actionId}` })) };
}

function cohort(): Measured[] {
  return [measurement({ id: "a", episodeId: "episode-a", sequence: 1, vector: ["0", "0"], utilities: [2, 0], costs: [1, 3] }),
    measurement({ id: "b", episodeId: "episode-b", sequence: 2, vector: ["0", "0"], utilities: [4, 2], costs: [3, 5] }),
    measurement({ id: "c", episodeId: "episode-c", sequence: 3, vector: ["1", "1"], utilities: [0, 8], costs: [5, 7] })];
}

function build(measurements: readonly TopicJointMeasurement[], policy: JointEmpiricalPolicy = POLICY) {
  return buildJointEmpiricalModel({ policy, boardSequence: 20, measurements,
    questions: [{ experimentRef: "left", questionId: "q:left" }, { experimentRef: "right", questionId: "q:right" }], decision: DECISION });
}

function ready(measurements: readonly TopicJointMeasurement[], policy: JointEmpiricalPolicy = POLICY) {
  const built = build(measurements, policy);
  assert.equal(built.status, "ready");
  if (built.status !== "ready") throw new Error("joint_model_missing");
  const read = readInformationModel(built.modelJson);
  assert.ok(read.ok);
  if (!read.ok) throw new Error("joint_model_invalid");
  return { built, model: read.model };
}

test("unequal complete episode counts give hand-computed Dirichlet frequencies and correlated conditional observations", () => {
  const { built, model } = ready(cohort());

  assert.deepEqual(built.provenance.stateCounts, [2, 1]);
  assert.deepEqual(built.provenance.observationVectors, [["0", "0"], ["1", "1"]]);
  // N=3, K=2, concentration=2: ((2+1)/5,(1+1)/5), without a caller-supplied probability table.
  near(model.prior[0]!, 3 / 5);
  near(model.prior[1]!, 2 / 5);
  assert.deepEqual(model.questions[0]!.likelihood, [[1, 0], [0, 1]]);
  assert.deepEqual(model.questions[1]!.likelihood, [[1, 0], [0, 1]]);
  const left = model.questions[0]!, right = model.questions[1]!;
  const joint10 = model.prior.reduce((sum, p, state) => sum + p * left.likelihood[state]![1]! * right.likelihood[state]![0]!, 0);

  near(joint10, 0);
  assert.notEqual(joint10, (2 / 5) * (3 / 5), "unconditional independence would invent an absent combination");
  const conditioned = applyTopicObservation(built.modelJson, "q:left", 1);
  assert.equal(conditioned.status, "updated");

  if (conditioned.status !== "updated") return;

  assert.deepEqual(conditioned.model.prior, [0, 1]);
  const remaining = conditioned.model.questions.find(question => question.id === "q:right")!;

  near(conditioned.model.prior.reduce((sum, p, state) => sum + p * remaining.likelihood[state]![1]!, 0), 1);
});

test("checked action group means and each question's complete study-cost mean use one scale and fractional demand", () => {
  const rows = cohort(), half = ready(rows), full = ready(rows, { ...POLICY, futureUses: 1 });

  // Group 00: keep mean=3, switch mean=1; group 11: (0,8). Multiply by .5 / 8.
  near(half.model.utilities[0]![0]!, 3 / 16);
  near(half.model.utilities[1]![0]!, 1 / 16);
  near(half.model.utilities[0]![1]!, 0);
  near(half.model.utilities[1]![1]!, 1 / 2);
  // Left complete costs (1,3,5) average 3; right (3,5,7) average 5, both divided by 8.
  near(half.model.questions[0]!.cost, 3 / 8);
  near(half.model.questions[1]!.cost, 5 / 8);

  for (let action = 0; action < 2; action++) for (let state = 0; state < 2; state++) near(full.model.utilities[action]![state]!, 2 * half.model.utilities[action]![state]!);

  assert.deepEqual(full.model.questions.map(question => question.cost), half.model.questions.map(question => question.cost));
});

test("linear episode corrections replace old influence while duplicate episodes, forks and active unknown remain unvalued", () => {
  const rows = cohort(), corrected = measurement({ id: "a-fixed", episodeId: "episode-a", sequence: 4, supersedes: "a",
    vector: ["1", "1"], utilities: [0, 6], costs: [5, 7] });
  const revised = ready([...rows, corrected]);
  assert.deepEqual(revised.built.provenance.stateCounts, [1, 2]);
  assert.deepEqual(revised.built.provenance.supportIds, ["b", "c", "a-fixed"]);
  near(revised.model.prior[0]!, 2 / 5);
  near(revised.model.prior[1]!, 3 / 5);
  const duplicate = measurement({ id: "duplicate", episodeId: "episode-a", sequence: 4,
    vector: ["1", "1"], utilities: [0, 6], costs: [5, 7] });

  assert.deepEqual(build([...rows, duplicate]), { status: "unvalued", reason: "topic_joint_conflict" });
  assert.deepEqual(build([...rows, corrected, { ...corrected, id: "fork", sequence: 5 }]), { status: "unvalued", reason: "topic_joint_conflict" });
  const unknown: TopicJointMeasurement = { id: "pending", episodeId: "episode-pending", sequence: 4, scope: POLICY.scope,
    protocolId: POLICY.protocolId, protocolVersion: POLICY.protocolVersion, conditionHash: POLICY.conditionHash, utilityUnit: POLICY.utilityUnit,
    sourceRef: "execution:pending", kind: "unknown", reason: "checker_unavailable" };

  assert.deepEqual(build([...rows, unknown]), { status: "unvalued", reason: "topic_joint_unknown" });
});

test("unseen target combinations stay outside support and self-rated numbers cannot replace checked record shape", () => {
  const rows = cohort(), { built, model } = ready(rows.slice(0, 2));

  assert.equal(model.prior.length, 1);
  assert.deepEqual(built.provenance.stateCounts, [2]);
  assert.deepEqual(built.provenance.observationVectors, [["0", "0"]]);
  const leftZero = applyTopicObservation(built.modelJson, "q:left", 0);
  assert.equal(leftZero.status, "updated");
  if (leftZero.status !== "updated") return;

  assert.deepEqual(applyTopicObservation(leftZero.modelJson, "q:right", 1), { status: "rejected", reason: "topic_observation_out_of_model" });
  // Ref validation is syntax/source binding only; these fixture references are not proof of checker authentication.
  assert.ok(readJointMeasurement(rows[0]));
  assert.equal(readJointMeasurement({ ...rows[0]!, observations: [{ ...rows[0]!.observations[0]!, checkRef: "0.99" }, rows[0]!.observations[1]!] }), undefined);
  assert.equal(readJointMeasurement({ ...rows[0]!, actionUtilities: [{ ...rows[0]!.actionUtilities[0]!, checkRef: "model:self-score" }, rows[0]!.actionUtilities[1]!] }), undefined);
  const { id, sequence: _sequence, ...body } = rows[0]!, outcome: JointOutcome = { ...body, measurementId: id };

  assert.ok(readJointOutcome(outcome));
  assert.equal(readJointOutcome({ ...outcome, sourceRef: "model:confidence" }), undefined);
  assert.equal(readJointOutcome({ measurementId: "score", kind: "measured", value: 0.99 }), undefined);
});

test("trusted current-target observations condition existing support without recharging a known question", () => {
  const known = [{ experimentRef: "left", experimentVersion: "1", outcome: "1", checkRef: "checker:current-target-left" }];
  const input = { policy: POLICY, boardSequence: 20, measurements: cohort(), knownObservations: known,
    questions: [{ experimentRef: "left", questionId: "q:left" }, { experimentRef: "right", questionId: "q:right" }],
    decision: { ...DECISION, initialState: "l1" } };
  const built = buildJointEmpiricalModel(input);
  assert.equal(built.status, "ready");
  if (built.status !== "ready") return;

  const read = readInformationModel(built.modelJson);
  assert.ok(read.ok);
  if (!read.ok || read.model.schemaVersion !== 2) throw new Error("known_model_missing");

  assert.deepEqual(read.model.prior, [0, 1]);
  assert.deepEqual(read.model.questions.map(question => question.id), ["q:right"]);
  assert.equal(read.model.decision.initialState, "l1");
  assert.equal(read.model.decision.states.find(state => state.id === "l1")!.action, 0);
  assert.ok(read.model.decision.states.every(state => state.transitions.every(transition => transition.questionId !== "q:left")));
  assert.deepEqual(built.provenance.stateCounts, [2, 1]);
  assert.equal(built.provenance.supportIds.length, 3);
  assert.deepEqual(built.provenance.knownObservations, known);
  assert.equal(built.provenance.knownObservationsHash, contentHashOf(known));
  assert.deepEqual(buildJointEmpiricalModel({ ...input, knownObservations: [...known,
    { experimentRef: "right", experimentVersion: "1", outcome: "0", checkRef: "checker:current-target-right" }] }),
  { status: "unvalued", reason: "topic_joint_out_of_model" });
});
