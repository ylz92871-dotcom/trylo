import test from "node:test";
import assert from "node:assert/strict";
import { applyTopicObservation } from "./information-observation.js";
import { planTopicInformation } from "./information-plan.js";

function model() {
  return { schemaVersion: 1, prior: [0.25, 0.25, 0.25, 0.25], utilities: [[1, 0, 0, 1], [0, 1, 1, 0]], questions: [
    { id: "first", cost: 0.05, units: 2, likelihood: [[1, 0], [1, 0], [0, 1], [0, 1]] },
    { id: "second", cost: 0.05, units: 1, likelihood: [[1, 0], [0, 1], [1, 0], [0, 1]] }] };
}

test("actual complementary observations update the joint belief, remove used questions and change the next choice", () => {
  const initial = JSON.stringify(model()), plan = planTopicInformation(initial, 3);
  assert.equal(plan.status, "planned");

  if (plan.status !== "planned") return;
  assert.equal(plan.questionId, "first");
  const update = applyTopicObservation(initial, "first", 0);
  assert.equal(update.status, "updated");
  if (update.status !== "updated") return;

  assert.deepEqual(update.model.prior, [0.5, 0.5, 0, 0]);
  assert.equal(update.spentUnits, 2);
  assert.deepEqual(update.model.questions.map(row => row.id), ["second"]);
  const next = planTopicInformation(update.modelJson, 1);
  assert.equal(next.status, "planned");
  if (next.status === "planned") assert.equal(next.questionId, "second");

  const final = applyTopicObservation(update.modelJson, "second", 1);
  assert.equal(final.status, "updated");
  if (final.status !== "updated") return;

  assert.deepEqual(final.model.prior, [0, 1, 0, 0]);
  assert.equal(final.model.questions.length, 0);
  const stop = planTopicInformation(final.modelJson, 1);
  assert.equal(stop.status, "planned");
  if (stop.status === "planned") assert.equal(stop.questionId, null);

  assert.deepEqual(JSON.parse(initial), model());
});

test("an impossible or malformed observation never fabricates a posterior", () => {
  const input = model();
  input.prior = [1, 0, 0, 0];
  assert.deepEqual(applyTopicObservation(JSON.stringify(input), "first", 1), { status: "rejected", reason: "topic_observation_out_of_model" });
  for (const outcome of [-1, 0.5, NaN, 2]) assert.deepEqual(applyTopicObservation(JSON.stringify(input), "first", outcome), { status: "rejected", reason: "topic_observation_invalid" });
  assert.deepEqual(applyTopicObservation(JSON.stringify(input), "absent", 0), { status: "rejected", reason: "topic_observation_invalid" });
});

test("a rare but possible observed event is retained even if its marginal probability underflows", () => {
  const input = { schemaVersion: 1, prior: [1e-250, 1], utilities: [[1, 0], [0, 1]], questions: [
    { id: "rare", units: 1, cost: 0, likelihood: [[1e-250, 1], [0, 1]] }] };
  const result = applyTopicObservation(JSON.stringify(input), "rare", 0);
  assert.equal(result.status, "updated");
  if (result.status !== "updated") return;
  assert.deepEqual(result.model.prior, [1, 0]);
  assert.ok(Number.isFinite(result.logProbability));
  assert.equal(Math.exp(result.logProbability), 0);
});
