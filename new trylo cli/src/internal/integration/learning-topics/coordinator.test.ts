import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTopicCoordinator } from "./coordinator.js";
import { createTopicBudgetPool, type IssuedTopicAllocation } from "./pool.js";
import { createRewardV2BoardPort } from "../reward/v2-board-port.js";
import { canonicalJson, contentHashOf } from "../../learning/control/hash.js";
import { groundLearningTopic } from "../../learning/domains/shared/topics/ground.js";
import { prepareTopicOpportunity, type TopicOpportunity } from "../../learning/domains/shared/topics/opportunity.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "trylo-topic-coordinator-")), boardRoot = path.join(root, "board");
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { boardRoot, scope: "project:coordinator", poolId: "host-budget", algorithmVersion: "ws1-pool-v1",
    utilityUnit: "goal-v1", quotaUnit: "probe-v1", totalQuota: 2, enabled: () => true };
  return { options, pool: createTopicBudgetPool(options), board: createRewardV2BoardPort(boardRoot, () => true) };
}

function opportunity(boardSequence: number, maxQuota: number, kind: "positive" | "stop" | "unvalued") {
  const windowJson = JSON.stringify({ schemaVersion: 1, domain: "prompt", scope: "project:coordinator", boardSequence,
    watermarks: [{ runId: "run", throughSequence: 2 }], records: [
      { ref: "e", runId: "run", sequence: 2, scope: "project:coordinator", origin: "checker_result", text: "输入为空时处理失败。" }] });
  const proposal = JSON.stringify({ schemaVersion: 1, question: "空输入时应该采用什么处理步骤？", whenRelevant: "后续遇到空输入",
    expectedChange: "根据判别结果修订处理步骤", citations: [{ evidenceRef: "e", quote: "输入为空时处理失败" }],
    alternatives: [{ id: "precondition", explanation: "缺少输入前置检查" }, { id: "representation", explanation: "空值表示不兼容" }],
    discriminator: { observation: "在固定处理步骤下比较输入表示", hypothesisIds: ["precondition", "representation"] } });
  const grounded = groundLearningTopic(proposal, windowJson);

  assert.ok(grounded.ok);
  if (!grounded.ok) throw new Error("fixture_topic_rejected");

  const model = { schemaVersion: 1, prior: [0.5, 0.5], utilities: kind === "stop" ? [[1, 0]] : [[1, 0], [0, 1]],
    questions: [{ id: grounded.value.topicId, cost: 0.1, units: 1, likelihood: [[1, 0], [0, 1]] }] };

  return prepareTopicOpportunity({ proposals: [proposal], windowJson, modelJson: kind === "unvalued" ? null : JSON.stringify(model),
    utilityUnit: "goal-v1", quotaUnit: "probe-v1", maxQuota });
}

test("a real STOP offer returns its zero curve without a reservation, grant or claim", async t => {
  const fx = await fixture(t);
  let prepared: TopicOpportunity | undefined, executions = 0;
  const coordinator = createTopicCoordinator({ pool: fx.pool, domainRelation: "separable", enabled: () => true, domains: [{
    domain: "prompt", prepare(input) { return prepared = opportunity(input.boardSequence, input.maxQuota, "stop"); },

    async execute() {
      executions += 1;
      return { status: "completed" };
    },
  }] });
  const result = await coordinator.invoke({ requestId: "stop", totalQuota: 2 }, new AbortController().signal);

  assert.equal(result.status, "idle");
  assert.equal(executions, 0);
  assert.equal(result.allocationId, undefined);
  assert.equal(prepared?.status, "offered");
  if (prepared?.status !== "offered") throw new Error("fixture_not_offered");

  assert.deepEqual(prepared.recommend(2), { status: "stop" });
  const summary = result.preparations[0];
  assert.equal(summary?.status, "offered");

  if (summary?.status !== "offered") throw new Error("offer_summary_missing");

  assert.deepEqual(summary.bid, prepared.bid);
  assert.deepEqual(summary.bid.curve, [
    { quota: 0, netValue: 0 }, { quota: 1, netValue: 0 }, { quota: 2, netValue: 0 }]);
  const view = await fx.board.read();
  assert.equal(view.facts.length, 1);
  assert.equal(JSON.parse(view.facts[0]!.payloadJson).type, "ws1_topic_pool");
  const restarted = await createTopicBudgetPool(fx.options).open();
  assert.equal(restarted.status, "open");

  if (restarted.status === "open") assert.equal(restarted.remaining, 2);
});

test("the frozen actual positive bid is the durable reservation and execution capability's source", async t => {
  const fx = await fixture(t);
  let prepared: TopicOpportunity | undefined, grant: IssuedTopicAllocation | undefined;
  let mutable: { basis: { boardSequence: number; evidenceWindowHash: string }; curve: { quota: number; netValue: number }[] } | undefined;
  const coordinator = createTopicCoordinator({ pool: fx.pool, domainRelation: "separable", enabled: () => true, domains: [{
    domain: "prompt", prepare(input) {
      prepared = opportunity(input.boardSequence, input.maxQuota, "positive");
      if (prepared.status !== "offered") return prepared;
      // An adapter may own mutable containers; the numerical offer still comes from the real planner.
      const bid = { ...prepared.bid, basis: { ...prepared.bid.basis }, curve: prepared.bid.curve.map(point => ({ ...point })) };
      mutable = bid;
      return { ...prepared, bid };
    },

    async execute(input) {
      grant = input.grant;
      return { status: "completed", processed: 0 };
    },
  }] });
  const result = await coordinator.invoke({ requestId: "positive", totalQuota: 2 }, new AbortController().signal);

  assert.equal(result.status, "completed");
  assert.ok(grant);
  assert.equal(result.allocationId, grant.allocationId);
  const summary = result.preparations[0];
  assert.equal(summary?.status, "offered");

  if (summary?.status !== "offered" || prepared?.status !== "offered" || mutable === undefined) throw new Error("offer_summary_missing");

  assert.deepEqual(summary.bid, prepared.bid);
  assert.ok(summary.bid.curve[1]!.netValue > 0);
  assert.ok(Object.isFrozen(summary));
  assert.ok(Object.isFrozen(summary.bid));
  assert.ok(Object.isFrozen(summary.bid.basis));
  assert.ok(Object.isFrozen(summary.bid.curve));
  assert.ok(summary.bid.curve.every(Object.isFrozen));
  const bidJson = canonicalJson(summary.bid);

  mutable.basis.evidenceWindowHash = "changed-after-preparation";
  mutable.curve[1]!.netValue = 0;
  assert.equal(canonicalJson(summary.bid), bidJson);
  const view = await fx.board.read(), records = view.facts.map(fact => JSON.parse(fact.payloadJson));
  const reservation = records.find(row => row.type === "ws1_topic_reservation");
  assert.ok(reservation);
  const request = JSON.parse(reservation.requestJson);

  assert.equal(reservation.requestId, "positive");
  assert.deepEqual(request.bids, [summary.bid]);
  assert.equal(request.scope, fx.options.scope);
  assert.equal(request.boardSequence, summary.bid.basis.boardSequence);
  assert.equal(request.utilityUnit, summary.bid.utilityUnit);
  assert.equal(request.quotaUnit, summary.bid.quotaUnit);
  assert.equal(reservation.plan.netValue, summary.bid.curve[reservation.plan.allocated]!.netValue);
  assert.equal(reservation.plan.allocationId, grant.allocationId);
  assert.deepEqual(reservation.plan.allocations, grant.allocations);
  assert.equal(grant.allocations[0]!.valuationId, summary.bid.valuationId);
  assert.equal(grant.allocations[0]!.bidHash, contentHashOf(summary.bid));
  assert.equal(records.some(row => row.type === "ws1_topic_claim"), false);
  const restarted = await createTopicBudgetPool(fx.options).open();
  assert.equal(restarted.status, "open");

  if (restarted.status === "open") assert.equal(restarted.remaining, 2 - reservation.plan.allocated);
});

test("unvalued and invalid preparations cannot expose an unvalidated bid or execute work", async t => {
  const fx = await fixture(t);
  let invalid = false, executions = 0;
  const coordinator = createTopicCoordinator({ pool: fx.pool, domainRelation: "separable", enabled: () => true, domains: [{
    domain: "prompt", prepare(input) {
      const offer = opportunity(input.boardSequence, input.maxQuota, invalid ? "positive" : "unvalued");
      if (!invalid || offer.status !== "offered") return offer;
      const bid = { ...offer.bid, untrustedExtra: "must-not-be-returned" };
      return { ...offer, bid };
    },

    async execute() {
      executions += 1;
      return { status: "completed" };
    },
  }] });
  const unvalued = await coordinator.invoke({ requestId: "unvalued", totalQuota: 2 }, new AbortController().signal);

  assert.equal(unvalued.status, "waiting");
  assert.deepEqual(unvalued.preparations, [
    { domain: "prompt", status: "unvalued", reason: "topic_model_required" }]);
  assert.equal(Object.hasOwn(unvalued.preparations[0]!, "bid"), false);
  invalid = true;
  const rejected = await coordinator.invoke({ requestId: "invalid", totalQuota: 2 }, new AbortController().signal);

  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.reason, "topic_coordinator_bid_binding");
  assert.deepEqual(rejected.preparations, []);
  assert.equal(JSON.stringify(rejected).includes("must-not-be-returned"), false);
  assert.equal(executions, 0);
  assert.equal((await fx.board.read()).facts.length, 1);
});
