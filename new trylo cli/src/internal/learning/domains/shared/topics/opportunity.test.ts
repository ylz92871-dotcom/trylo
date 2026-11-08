import test from "node:test";
import assert from "node:assert/strict";
import { groundLearningTopic } from "./ground.js";
import { prepareTopicOpportunity } from "./opportunity.js";

function inputs() {
  const windowJson = JSON.stringify({ schemaVersion: 1, domain: "prompt", scope: "project:one", boardSequence: 4,
    watermarks: [{ runId: "run", throughSequence: 2 }], records: [
      { ref: "e", runId: "run", sequence: 2, scope: "project:one", origin: "checker_result", text: "输入为空时处理失败。" }] });
  const proposal = JSON.stringify({ schemaVersion: 1, question: "空输入时应该采用什么处理步骤？", whenRelevant: "后续遇到空输入",
    expectedChange: "根据判别结果修订处理步骤", citations: [{ evidenceRef: "e", quote: "输入为空时处理失败" }],
    alternatives: [{ id: "precondition", explanation: "缺少输入前置检查" }, { id: "representation", explanation: "空值表示不兼容" }],
    discriminator: { observation: "在固定处理步骤下比较输入表示", hypothesisIds: ["precondition", "representation"] } });
  const topic = groundLearningTopic(proposal, windowJson);
  assert.ok(topic.ok);
  if (!topic.ok) throw new Error("fixture_rejected");

  const model = { schemaVersion: 1, prior: [0.5, 0.5], utilities: [[1, 0], [0, 1]],
    questions: [{ id: topic.value.topicId, cost: 0.1, units: 1, likelihood: [[1, 0], [0, 1]] }] };

  return { input: { proposals: [proposal], windowJson, modelJson: JSON.stringify(model), utilityUnit: "goal-v1-normalized",
    quotaUnit: "bounded-probe-v1", maxQuota: 2 }, model, topic: topic.value };
}

test("central receives only a bound domain/quota curve; the domain retains the semantic choice", () => {
  const { input, topic } = inputs(), offer = prepareTopicOpportunity(input);

  assert.equal(offer.status, "offered");
  if (offer.status !== "offered") return;

  assert.equal(offer.bid.domain, "prompt");
  assert.equal(offer.bid.scope, "project:one");
  assert.equal(offer.bid.basis.boardSequence, 4);
  assert.deepEqual(offer.bid.curve.map(row => row.quota), [0, 1, 2]);
  assert.ok(Math.abs(offer.bid.curve[1]!.netValue - 0.4) < 2e-12);
  assert.ok(Math.abs(offer.bid.curve[2]!.netValue - 0.4) < 2e-12);
  assert.equal(JSON.stringify(offer.bid).includes(topic.question), false);
  assert.equal(JSON.stringify(offer.bid).includes(topic.topicId), false);
  assert.deepEqual(offer.recommend(0), { status: "stop" });
  const selected = offer.recommend(1);
  assert.equal(selected.status, "question");

  if (selected.status === "question") assert.equal(selected.topic.topicId, topic.topicId);

  for (const quota of [-1, 0.5, 3, NaN]) assert.deepEqual(offer.recommend(quota), { status: "invalid_quota" });

  assert.ok(Object.isFrozen(offer.bid));
  assert.ok(Object.isFrozen(offer.bid.curve));
});

test("a semantically grounded question with no trusted model stays unvalued, not worthless", () => {
  const { input } = inputs();
  assert.deepEqual(prepareTopicOpportunity({ ...input, modelJson: null }), { status: "unvalued", reason: "topic_model_required" });
});

test("a model cannot smuggle an unrelated topic into a domain offer", () => {
  const { input, model } = inputs();
  model.questions[0]!.id = "some-other-topic";
  assert.deepEqual(prepareTopicOpportunity({ ...input, modelJson: JSON.stringify(model) }), { status: "rejected", reason: "topic_model_binding" });
});

test("abstention and empty windows cannot be promoted into a forced learning bid", () => {
  const { input } = inputs();
  assert.deepEqual(prepareTopicOpportunity({ ...input, proposals: [] }), { status: "empty" });
  assert.deepEqual(prepareTopicOpportunity({ ...input, proposals: ['{"schemaVersion":1,"decision":"no_topic","reason":"没有可支持的问题"}'] }), { status: "empty" });
  assert.equal(prepareTopicOpportunity({ ...input, windowJson: "bad" }).status, "rejected");
});

test("budget limits cover the whole curve rather than resetting for each point", () => {
  const { input } = inputs();
  assert.deepEqual(prepareTopicOpportunity({ ...input, nodeLimit: 1 }), { status: "planning_limit", nodes: 1 });
  assert.deepEqual(prepareTopicOpportunity({ ...input, maxQuota: 7 }), { status: "rejected", reason: "topic_opportunity_budget" });
});

test("the offer identity binds model, units, source prefix and open question contents", () => {
  const { input, model } = inputs(), first = prepareTopicOpportunity(input), repeat = prepareTopicOpportunity(input);

  assert.equal(first.status, "offered");
  assert.equal(repeat.status, "offered");
  if (first.status !== "offered" || repeat.status !== "offered") return;

  assert.equal(first.bid.valuationId, repeat.bid.valuationId);
  model.questions[0]!.cost = 0.2;
  const changed = prepareTopicOpportunity({ ...input, modelJson: JSON.stringify(model) });

  assert.equal(changed.status, "offered");
  if (changed.status === "offered") assert.notEqual(changed.bid.valuationId, first.bid.valuationId);

  const otherUnits = prepareTopicOpportunity({ ...input, utilityUnit: "other-goal" });

  assert.equal(otherUnits.status, "offered");
  if (otherUnits.status === "offered") assert.notEqual(otherUnits.bid.valuationId, first.bid.valuationId);
});
