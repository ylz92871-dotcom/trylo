import assert from "node:assert/strict";
import test from "node:test";
import { reduce } from "../control/reducer.js";
import { emptyBoardState } from "../control/state.js";
import { isRewardV2Draft, validRewardV2Prefix, type RewardV2Draft, type RewardV2Fact } from "./v2-facts.js";
import { topicExperimentBindings } from "../../integration/learning-topics/experiment-binding.js";
import { topicJointMeasurements } from "../../integration/learning-topics/joint-measurement-source.js";

test("the original reducer appends beyond the old lifetime prefix limits while preserving packet and identity guards", () => {
  const scope = "workspace:reward-lifetime", payloadJson = JSON.stringify({ value: "x".repeat(1012) });

  assert.equal(payloadJson.length, 1024);
  const facts: RewardV2Fact[] = Array.from({ length: 16384 }, (_, index) => ({ id: `original:${index}`, scope,
    algorithmVersion: "unrelated-original-owner-v1", kind: "projection", payloadJson, sequence: index + 1 }));

  assert.equal(validRewardV2Prefix(facts, 16384), true);
  const root = { schemaVersion: 1, budgetId: "budget:original", scope, unit: "total_model_tokens", limits: { tokens: 1000, calls: 10, steps: 10 },
    authorizationRef: "authorization:original", mode: "exclusive_new_funding", openedAt: "2026-11-05T00:00:00.000Z", openedSequence: 1 } as const;
  const before = { ...emptyBoardState(), sequence: 16384, rewardV2Facts: facts, centralLearningBudgets: [root] };
  const next: RewardV2Draft = { id: "original:16384", scope, algorithmVersion: "unrelated-original-owner-v1", kind: "projection", payloadJson };
  const command = { type: "record_reward_v2_fact", commandId: `rw2:${next.id}`, issuedAt: "2026-11-05T00:00:01.000Z",
    expectedSequence: before.sequence, fact: next } as const;
  const appended = reduce(before, command);

  assert.equal(appended.ok, true, appended.ok ? undefined : appended.reason);
  if (!appended.ok) return;

  const retained = appended.state.rewardV2Facts!;

  assert.equal(retained.length, 16385);
  assert.equal(retained.reduce((sum, fact) => sum + fact.payloadJson.length, 0), 16 * 1024 * 1024 + 1024);
  assert.equal(retained[0], facts[0]);
  assert.deepEqual(retained.at(-1), { ...next, sequence: 16385 });
  assert.equal(appended.state.centralLearningBudgets?.[0], root, "cumulative persistence does not reset the original budget");
  assert.equal(validRewardV2Prefix(retained, appended.state.sequence), true);
  assert.deepEqual(topicExperimentBindings(retained, scope), []);
  assert.deepEqual(topicJointMeasurements(retained, scope), []);
  assert.equal(validRewardV2Prefix([...retained, { ...retained[0]!, sequence: 16386 }], 16386), false, "IDs remain unique");
  assert.equal(validRewardV2Prefix([retained[1]!, retained[0]!], 16385), false, "original sequence order remains strict");
  assert.equal(reduce(appended.state, command).ok, true, "the original append remains replayable");
  let deep: unknown = {};

  for (let index = 0; index < 34; index++) deep = { nested: deep };

  for (const invalid of ["{", JSON.stringify({ value: "x".repeat(131072) }), JSON.stringify(deep), JSON.stringify({ values: Array(16385).fill(0) })]) {
    const draft = { ...next, id: "invalid:packet", payloadJson: invalid };
    assert.equal(isRewardV2Draft(draft), false);
    const rejected = reduce(appended.state, { ...command, commandId: "rw2:invalid:packet", expectedSequence: appended.state.sequence, fact: draft });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.reason, "invalid_reward");
    assert.equal(rejected.state, appended.state);
  }
});
