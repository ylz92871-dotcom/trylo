import test from "node:test";
import assert from "node:assert/strict";
import { readInformationModel, type InformationModelV1, type InformationModelV2 } from "./information-model.js";
import { planTopicInformation } from "./information-plan.js";
import { applyTopicObservation } from "./information-observation.js";
import { buildEmpiricalTopicModel, isEmpiricalTopicPolicy, type EmpiricalTopicPolicy, type TopicPairedMeasurement } from "./empirical-model.js";
import { groundLearningExperiment, groundLearningTopic } from "./ground.js";
import type { TopicDraft, TopicEvidenceWindow } from "./contracts.js";

function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 2e-12, `${actual} != ${expected}`);
}

function planned(json: string, quota: number) {
  const result = planTopicInformation(json, quota);
  assert.equal(result.status, "planned");
  if (result.status !== "planned") throw new Error("plan_missing");
  return result;
}

function policy(futureUses = 1): EmpiricalTopicPolicy {
  return { scope: "decision-test", experimentRef: "paired-read", experimentVersion: "1", conditionHash: "a".repeat(64),
    utilityUnit: "declared-test-utility", futureUses, utilityScale: 1, experimentUnits: 1,
    // The declared objective range must fit the shared unit scale, including its horizon.
    deltaBounds: { minimum: -1, maximum: 1 }, priorStrength: 2, priorWeights: [0.25, 0.25, 0.25, 0.25] };
}

function empirical(futureUses = 1, actions: readonly number[] = [0, 1, 1]) {
  const p = policy(futureUses);
  const measurements: TopicPairedMeasurement[] = ["loss", "gain-a", "gain-b"].map((id, index) => ({
    id, sequence: index + 1, scope: p.scope, experimentRef: p.experimentRef, experimentVersion: p.experimentVersion,
    conditionHash: p.conditionHash, utilityUnit: p.utilityUnit, sourceRef: `checker:${id}`, kind: "measured",
    baselineUtility: 0, candidateUtility: index === 0 ? -0.5 : 0.5, fullStudyCost: 0.02 }));
  const built = buildEmpiricalTopicModel({ policy: p, questionId: "pair", boardSequence: 3, measurements,
    decision: { currentAction: 0, projections: measurements.map((row, index) => ({ measurementId: row.id, nextAction: actions[index]! })) } });

  assert.equal(built.status, "ready");
  if (built.status !== "ready") throw new Error("empirical_missing");

  const read = readInformationModel(built.modelJson);

  assert.equal(read.ok, true);
  if (!read.ok) throw new Error("model_missing");

  return { built, model: read.model };
}

test("schema2 stopping deploys its actual action and a missing transition cannot unlock a better action", () => {
  const model: InformationModelV2 = { schemaVersion: 2, prior: [0.5, 0.5], utilities: [[0, 0], [1, 1]],
    questions: [{ id: "reveal", cost: 0, units: 1, likelihood: [[1, 0], [0, 1]] }],
    decision: { initialState: "current", states: [{ id: "current", action: 0, transitions: [] }] } };
  for (const quota of [0, 1]) {
    const plan = planned(JSON.stringify(model), quota);
    assert.equal(plan.questionId, null);
    near(plan.baseline, 0);
    near(plan.value, 0);
  }
});

test("an actual observation advances the declared action and removes the answered transition from every state", () => {
  const transition = { questionId: "reveal", next: ["keep", "adopt"] };
  const model: InformationModelV2 = { schemaVersion: 2, prior: [0.5, 0.5], utilities: [[0, 0], [-1, 1]],
    questions: [{ id: "reveal", cost: 0.05, units: 1, likelihood: [[1, 0], [0, 1]] }],
    decision: { initialState: "current", states: [
      { id: "current", action: 0, transitions: [transition] }, { id: "keep", action: 0, transitions: [transition] },
      { id: "adopt", action: 1, transitions: [transition] }] } };
  const json = JSON.stringify(model), before = planned(json, 1);
  assert.equal(before.questionId, "reveal");
  near(before.value, 0.45);
  const update = applyTopicObservation(json, "reveal", 1);

  assert.equal(update.status, "updated");
  if (update.status !== "updated") return;

  assert.equal(update.model.schemaVersion, 2);
  if (update.model.schemaVersion !== 2) return;

  assert.equal(update.model.decision.initialState, "adopt");
  assert.deepEqual(update.model.prior, [0, 1]);
  assert.equal(update.model.questions.length, 0);
  assert.ok(update.model.decision.states.every(state => state.transitions.length === 0));
  const after = planned(update.modelJson, 0);
  assert.equal(after.questionId, null);
  near(after.value, 1);
  assert.deepEqual(applyTopicObservation(update.modelJson, "reveal", 1), { status: "rejected", reason: "topic_observation_invalid" });
});

test("schema1 keeps its free-action Bellman result, canonical update and existing grounded topic identity", () => {
  const model: InformationModelV1 = { schemaVersion: 1, prior: [0.5, 0.5], utilities: [[1, 0], [0, 1]],
    questions: [{ id: "legacy", cost: 0.1, units: 1, likelihood: [[1, 0], [0, 1]] }] };
  const plan = planned(JSON.stringify(model), 1);
  assert.equal(plan.questionId, "legacy");
  near(plan.value, 0.9);
  const update = applyTopicObservation(JSON.stringify(model), "legacy", 1);

  assert.equal(update.status, "updated");
  if (update.status !== "updated") return;

  assert.equal(update.modelJson, '{"prior":[0,1],"questions":[],"schemaVersion":1,"utilities":[[1,0],[0,1]]}');
  const window: TopicEvidenceWindow = { schemaVersion: 1, domain: "routing", scope: "legacy", boardSequence: 7,
    watermarks: [{ runId: "run", throughSequence: 1 }], records: [{ ref: "e", runId: "run", sequence: 1,
      scope: "legacy", origin: "execution_result", text: "Read failed." }] };
  const draft: TopicDraft = { schemaVersion: 1, question: "Why did the read fail?", whenRelevant: "On the same input.",
    expectedChange: "Check the cause before changing the reader.", citations: [{ evidenceRef: "e", quote: "Read failed." }],
    alternatives: [{ id: "input", explanation: "Invalid input." }, { id: "reader", explanation: "Reader defect." }],
    discriminator: { observation: "Repeat with a verified input.", hypothesisIds: ["input", "reader"] } };
  const grounded = groundLearningTopic(JSON.stringify(draft), JSON.stringify(window));
  assert.equal(grounded.ok, true);

  if (!grounded.ok) return;

  assert.equal(grounded.value.topicId, "topic:51ddfdea64b40e5541ed11b8ebed8195ca630944846409ef4a7c481ace809838");
});

test("Dirichlet study/deployment joint prediction and conditional decision value equal independent hand fractions", () => {
  const { built, model } = empirical(), question = model.questions[0]!;

  assert.deepEqual(built.outcomes, [{ utilityClass: 1, deploymentAction: 0 }, { utilityClass: 2, deploymentAction: 1 }]);
  // Counts (1,2), restricted prior alpha (1,1): posterior alpha=(2,3).
  // The independent joint table is P(Y,Z)=[[1/5,1/5],[1/5,2/5]], not the product of marginal predictions.
  const joint = [[1 / 5, 1 / 5], [1 / 5, 2 / 5]];

  near(model.prior[0]!, 2 / 5);
  near(model.prior[1]!, 3 / 5);

  for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) near(model.prior[z]! * question.likelihood[z]![y]!, joint[y]![z]!);

  const plan = planned(built.modelJson, 1);
  assert.equal(plan.questionId, "pair");
  near(plan.baseline, 0);
  // On Y=gain the domain adopts; expected next utility is (2*(-1/2)+4*(1/2))/6=1/6.
  // P(Y=gain)=3/5, so study value is (3/5)*(1/6)-1/50=2/25.
  near(plan.value, 2 / 25);
  near(plan.netGain, 2 / 25);
  const observed = applyTopicObservation(built.modelJson, "pair", 1);

  assert.equal(observed.status, "updated");
  if (observed.status !== "updated") return;

  near(observed.model.prior[0]!, 1 / 3);
  near(observed.model.prior[1]!, 2 / 3);
  near(planned(observed.modelJson, 0).value, 1 / 6);
});

test("unseen joint utility/action cells receive no invented support or observation column", () => {
  const { built, model } = empirical(1, [0, 0, 1]);
  assert.deepEqual(built.outcomes, [{ utilityClass: 1, deploymentAction: 0 },
    { utilityClass: 2, deploymentAction: 0 }, { utilityClass: 2, deploymentAction: 1 }]);
  assert.deepEqual(built.provenance.outcomeCounts, [1, 1, 1]);
  assert.equal(model.prior.length, 3);
  assert.ok(model.questions[0]!.likelihood.every(row => row.length === 3));
  assert.deepEqual(applyTopicObservation(built.modelJson, "pair", 3), { status: "rejected", reason: "topic_observation_invalid" });
});

test("fractional future demand scales deployment benefit without rounding or changing study cost", () => {
  assert.equal(isEmpiricalTopicPolicy(policy(0.5)), true);
  const full = empirical(), half = empirical(0.5);
  half.model.utilities[1]!.forEach((value, index) => near(value, full.model.utilities[1]![index]! / 2));
  near(half.model.questions[0]!.cost, full.model.questions[0]!.cost);
  const plan = planned(half.built.modelJson, 1);
  assert.equal(plan.questionId, "pair");
  near(plan.value, 3 / 100);
});

test("host catalog conditionHash grounds the matching experiment and changes identity across niches", () => {
  const draft = { schemaVersion: 3, experimentRef: "read-pair", question: "Which reader should be used?", whenRelevant: "On the same read conditions.",
    expectedChange: "Select the verified reader.", citations: [{ evidenceRef: "check", quote: "The two readers disagreed." }] };
  const window: TopicEvidenceWindow = { schemaVersion: 1, domain: "routing", scope: "condition-test", boardSequence: 4,
    watermarks: [{ runId: "run", throughSequence: 1 }], records: [{ ref: "check", runId: "run", sequence: 1,
      scope: "condition-test", origin: "checker_result", text: "The two readers disagreed." }],
    experiments: [{ ref: "read-pair", version: "1", domain: "routing", purpose: "Compare existing readers", conditionHash: "a".repeat(64) }] };
  const first = groundLearningExperiment(JSON.stringify(draft), JSON.stringify(window));
  assert.equal(first.ok, true);
  if (!first.ok) return;

  assert.equal(first.value.experiment.conditionHash, "a".repeat(64));
  const changed = { ...window, experiments: [{ ...window.experiments![0]!, conditionHash: "b".repeat(64) }] };
  const second = groundLearningExperiment(JSON.stringify(draft), JSON.stringify(changed));
  assert.equal(second.ok, true);
  if (!second.ok) return;

  assert.equal(second.value.experiment.conditionHash, "b".repeat(64));
  assert.notEqual(first.value.topicId, second.value.topicId);
  assert.deepEqual(groundLearningExperiment(JSON.stringify({ ...draft, conditionHash: "b".repeat(64) }), JSON.stringify(window)),
    { ok: false, reason: "topic_shape_invalid" });
});
