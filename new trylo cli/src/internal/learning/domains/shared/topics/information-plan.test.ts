import test from "node:test";
import assert from "node:assert/strict";
import { planTopicInformation } from "./information-plan.js";
import { readInformationModel, type InformationModel, type InformationQuestion } from "./information-model.js";

function reveal(id: string, bits: number[], cost = 0.01, units = 1): InformationQuestion {
  return { id, cost, units, likelihood: bits.map(bit => [1 - bit, bit]) };
}

function solve(questions: readonly InformationQuestion[], quota = 1, utilities = [[1, 0], [0, 1]], prior = [0.5, 0.5]) {
  return planTopicInformation(JSON.stringify({ schemaVersion: 1, prior, utilities, questions }), quota);
}

function near(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 2e-12, `${actual} != ${expected}`); }

test("decision-relevant question beats an equally informative irrelevant question", () => {
  const result = solve([reveal("irrelevant", [0, 1, 0, 1]), reveal("relevant", [0, 0, 1, 1])], 1,
    [[1, 1, 0, 0], [0, 0, 1, 1]], [0.25, 0.25, 0.25, 0.25]);
  assert.equal(result.status, "planned");
  if (result.status !== "planned") return;
  assert.equal(result.questionId, "relevant");
  near(result.value, 0.99);
  near(result.netGain, 0.49);
});

test("two complementary prerequisites are selected despite each having negative one-step net value", () => {
  const questions = [reveal("first", [0, 0, 1, 1], 0.05), reveal("second", [0, 1, 0, 1], 0.05)];
  const utilities = [[1, 0, 0, 1], [0, 1, 1, 0]], prior = [0.25, 0.25, 0.25, 0.25];
  const one = solve(questions, 1, utilities, prior), two = solve(questions, 2, utilities, prior);
  assert.equal(one.status, "planned");
  assert.equal(two.status, "planned");
  if (one.status !== "planned" || two.status !== "planned") return;
  assert.equal(one.questionId, null);
  assert.equal(two.questionId, "first");
  near(two.value, 0.9);
});

test("duplicate questions cannot receive the same knowledge benefit twice", () => {
  const result = solve([reveal("one", [0, 1], 0.1), reveal("paraphrase", [0, 1], 0.1)], 2);
  assert.equal(result.status, "planned");
  if (result.status === "planned") near(result.value, 0.9);
});

test("unlearnable observations, uncontrollable losses and low future need all allow stopping", () => {
  const noise = { id: "noise", cost: 0.01, units: 1, likelihood: [[0.5, 0.5], [0.5, 0.5]] };
  const results = [solve([noise]), solve([reveal("external", [0, 1])], 1, [[-1, 0], [-1, 0]]),
    solve([reveal("local", [0, 1])], 1, [[0.001, 0], [0, 0.001]])];
  for (const result of results) {
    assert.equal(result.status, "planned");
    if (result.status === "planned") {
      assert.equal(result.questionId, null);
      near(result.netGain, 0);
    }
  }
});

test("costs and indivisible quota are both charged, including a zero-budget baseline", () => {
  const question = reveal("expensive", [0, 1], 0.1, 2);
  const zero = solve([question], 0), one = solve([question], 1), two = solve([question], 2);
  assert.equal(zero.status, "planned");
  assert.equal(one.status, "planned");
  assert.equal(two.status, "planned");
  if (zero.status !== "planned" || one.status !== "planned" || two.status !== "planned") return;
  near(zero.value, 0.5);
  assert.equal(one.questionId, null);
  assert.equal(two.questionId, "expensive");
  near(two.value, 0.9);
});

test("ties choose stopping, including impossible observations", () => {
  const result = solve([{ id: "known", cost: 0, units: 1, likelihood: [[1, 0], [1, 0]] }]);
  assert.equal(result.status, "planned");
  if (result.status === "planned") {
    assert.equal(result.questionId, null);
    near(result.value, 0.5);
  }
});

test("resource exhaustion returns unavailable instead of a partial winning question", () => {
  const json = JSON.stringify({ schemaVersion: 1, prior: [0.5, 0.5], utilities: [[1, 0], [0, 1]], questions: [reveal("q", [0, 1])] });
  assert.deepEqual(planTopicInformation(json, 1, 1), { status: "planning_limit", nodes: 1 });
});

test("fractional, nonfinite and oversized planning budgets cannot start a search", () => {
  const json = JSON.stringify({ schemaVersion: 1, prior: [1], utilities: [[0]], questions: [] });
  for (const quota of [-1, 1.5, NaN, Infinity, 7]) assert.deepEqual(planTopicInformation(json, quota), { status: "invalid", reason: "topic_planning_budget" });
  for (const limit of [0, 0.5, NaN, Infinity, 100001]) assert.deepEqual(planTopicInformation(json, 0, limit), { status: "invalid", reason: "topic_planning_budget" });
});

test("malformed models, hidden score fields and impossible probabilities are rejected", () => {
  const model: InformationModel = { schemaVersion: 1, prior: [0.5, 0.5], utilities: [[1, 0]], questions: [reveal("q", [0, 1])] };
  const invalid = [{ ...model, prior: [1, 1] }, { ...model, utilities: [[2, 0]] }, { ...model, permission: "granted" },
    { ...model, questions: [{ ...model.questions[0], cost: -1 }] }, { ...model, questions: [model.questions[0], model.questions[0]] },
    { ...model, questions: [{ ...model.questions[0], likelihood: [[0.8, 0.8], [1, 0]] }] }];

  for (const value of invalid) assert.deepEqual(readInformationModel(JSON.stringify(value)), { ok: false, reason: "topic_model_invalid" });

  assert.deepEqual(readInformationModel("bad"), { ok: false, reason: "topic_model_json" });
  assert.deepEqual(readInformationModel(" ".repeat(65537)), { ok: false, reason: "topic_model_size" });
  assert.equal(planTopicInformation('{"schemaVersion":1,"prior":[1e999],"utilities":[[0]],"questions":[]}', 0).status, "invalid");
});

test("a zero prior state cannot gain posterior mass from a fictitious outcome", () => {
  const result = solve([reveal("q", [0, 1], 0)], 2, [[1, 0], [0, 1]], [1, 0]);
  assert.equal(result.status, "planned");
  if (result.status === "planned") {
    near(result.value, 1);
    assert.equal(result.questionId, null);
  }
});
