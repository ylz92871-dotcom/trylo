import test from "node:test";
import assert from "node:assert/strict";
import { createTopicLearningSystem, type TopicExperimentRegistration } from "./system.js";

test("system construction requires a common utility scale covering fixed and declared demand", () => {
  const entry: TopicExperimentRegistration = {
    descriptor: { ref: "scale-contract", version: "1", domain: "tool", purpose: "Check declared utility scale" },
    policy: { conditionHash: "a".repeat(64), futureUses: 2, utilityScale: 1, experimentUnits: 1,
      deltaBounds: { minimum: -1, maximum: 1 }, priorStrength: 2, priorWeights: [0.25, 0.25, 0.25, 0.25] },
    checkerVersion: "check-v1", executionVersion: "execution-v1",
    probe: { async run() { throw new Error("probe_must_not_run"); }, async read() { return undefined; } },
  };
  const construct = (experiment: TopicExperimentRegistration) => createTopicLearningSystem({
    boardRoot: "unused-system-scale-contract", scope: "scale-contract", enabled: () => false,
    configuration: { policy: { poolId: "scale-contract", algorithmVersion: "scale-v1", utilityUnit: "test-utility",
      quotaUnit: "approved-pair", totalQuota: 6 }, perTurnQuota: 1, experiments: [experiment], domainRelation: "separable" },
  });

  assert.throws(() => construct(entry), { message: "topic_system_model_policy" });
  const demand = { ...entry, policy: { ...entry.policy, futureUses: 1 }, ...{ demandHorizon: 2 },
    demandPolicy: async () => ({ status: "unmodelled" as const, reason: "demand_must_not_run" }) };

  assert.throws(() => construct(demand), { message: "topic_system_demand_scale" });
  assert.doesNotThrow(() => construct({ ...demand, policy: { ...demand.policy, utilityScale: 2 } }));
});
