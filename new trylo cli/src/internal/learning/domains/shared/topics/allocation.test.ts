import test from "node:test";
import assert from "node:assert/strict";
import { allocateTopicBudget, type TopicAllocationRequest } from "../../../control/topic-allocation.js";
import { allocateLearning } from "../../../control/allocation-kernel.js";
import { contentHashOf } from "../../../control/hash.js";
import type { LearningDomain } from "../../../control/contracts.js";

function bid(domain: LearningDomain, values: number[]) {
  return { schemaVersion: 1 as const, valuationId: "value:" + domain, domain, scope: "project:one", basis: { boardSequence: 5, evidenceWindowHash: "source:" + domain },
    utilityUnit: "goal-v1", quotaUnit: "probe-v1", modelKind: "declared_finite_expected_utility" as const,
    curve: values.map((netValue, quota) => ({ quota, netValue })) };
}

function request(): TopicAllocationRequest {
  return { schemaVersion: 1, scope: "project:one", boardSequence: 5, utilityUnit: "goal-v1", quotaUnit: "probe-v1",
    domainRelation: "separable", totalQuota: 2, bids: [bid("prompt", [0, 0, 0.9]), bid("tool", [0, 0.3, 0.4])] };
}

test("central allocates a complementary two-unit domain instead of greedily splitting quota", () => {
  const input = request(), result = allocateTopicBudget(JSON.stringify(input));
  assert.equal(result.status, "allocated");
  if (result.status !== "allocated") return;
  assert.deepEqual(result.plan.allocations.map(({ domain, quota }) => ({ domain, quota })), [{ domain: "prompt", quota: 2 }, { domain: "tool", quota: 0 }]);
  assert.equal(result.plan.netValue, 0.9);
  assert.equal(result.plan.allocated, 2);
  assert.equal(result.plan.allocations[0]!.bidHash, contentHashOf(input.bids[0]));
  assert.equal(JSON.stringify(result.plan).includes("questionId"), false);
  assert.ok(Object.isFrozen(result.plan.allocations));
});

test("zero gain, ties and empty domains conserve quota rather than forcing spending", () => {
  for (const bids of [[], [bid("prompt", [0, 0, 0])]]) {
    const result = allocateTopicBudget(JSON.stringify({ ...request(), bids }));
    assert.equal(result.status, "allocated");
    if (result.status === "allocated") {
      assert.equal(result.plan.allocated, 0);
      assert.equal(result.plan.netValue, 0);
    }
  }
});

test("allocation binds owner, common prefix, utility and resource units without equating domain evidence hashes", () => {
  for (const patch of [{ scope: "other" }, { utilityUnit: "other" }, { quotaUnit: "other" }, { basis: { boardSequence: 4, evidenceWindowHash: "x" } }]) {
    const input = request();
    const result = allocateTopicBudget(JSON.stringify({ ...input, bids: [{ ...input.bids[0], ...patch }] }));
    assert.deepEqual(result, { status: "rejected", reason: "topic_allocation_binding" });
  }
  assert.equal(allocateTopicBudget(JSON.stringify(request())).status, "allocated");
});

test("sparse quotas, duplicate owners, hidden topics and nonseparable requests are refused", () => {
  const input = request(), original = input.bids[0]!;
  const invalid = [{ ...input, domainRelation: "shared_benefit" }, { ...input, totalQuota: 7 },
    { ...input, bids: [original, original] }, { ...input, bids: [{ ...original, questionId: "central-must-not-see" }] },
    { ...input, bids: [{ ...original, curve: [{ quota: 0, netValue: 0 }, { quota: 2, netValue: 0.9 }] }] },
    { ...input, bids: [{ ...original, curve: [{ quota: 0, netValue: 1 }] }] }];

  for (const value of invalid) assert.equal(allocateTopicBudget(JSON.stringify(value)).status, "rejected");

  assert.equal(allocateTopicBudget("not json").status, "rejected");
  assert.equal(allocateTopicBudget(" ".repeat(65537)).status, "rejected");
});

test("valuation identity and content change the allocation identity; input ordering is deterministic", () => {
  const first = allocateTopicBudget(JSON.stringify(request())), repeat = allocateTopicBudget(JSON.stringify(request()));
  assert.equal(first.status, "allocated");
  assert.equal(repeat.status, "allocated");
  if (first.status !== "allocated" || repeat.status !== "allocated") return;
  assert.equal(first.plan.allocationId, repeat.plan.allocationId);
  const input = request(), changed = allocateTopicBudget(JSON.stringify({ ...input, bids: [{ ...input.bids[0], valuationId: "new-version" }, input.bids[1]] }));
  assert.equal(changed.status, "allocated");
  if (changed.status === "allocated") assert.notEqual(changed.plan.allocationId, first.plan.allocationId);
});

test("promoted additive kernel preserves fixed-domain constant-shift invariance", () => {
  const absolute = allocateLearning([{ domain: "one", values: [10, 10, 10.9] }, { domain: "two", values: [-3, -2.7, -2.6] }], 2);
  const net = allocateLearning([{ domain: "one", values: [0, 0, 0.9] }, { domain: "two", values: [0, 0.3, 0.4] }], 2);
  assert.deepEqual(absolute.allocations, net.allocations);
  assert.ok(Math.abs(absolute.value - net.value - 7) < 1e-12);
});
