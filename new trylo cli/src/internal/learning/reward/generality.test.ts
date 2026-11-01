import assert from "node:assert/strict";
import test from "node:test";
import { reduce } from "../control/reducer.js";
import { emptyBoardState, normalizeBoardState, type BoardState } from "../control/state.js";
import { rewardView } from "./algorithm.js";
import { rewardRecordsOf } from "../control/reward-records.js";
import type { RewardExposureDraft, RewardFeedback, RewardMetric, RewardTarget } from "./contracts.js";

const quality: RewardMetric = { id: "quality", version: "1", unit: "fraction", minimum: 0, maximum: 1, preference: "higher" };
const latency: RewardMetric = { id: "latency", version: "1", unit: "ms", minimum: 0, maximum: 1000, preference: "lower" };
function draft(kind: string, metric = quality, id = kind): RewardExposureDraft {
  return { schemaVersion: 1, id, context: { scope: "workspace", taskFamily: "coding", environment: "env1", metric },
    source: { sessionId: "s", turnId: "t", attemptId: "a", eventId: `use-${kind}` },
    targets: [{ kind, id: "asset", version: "v1" }], occurredAt: 1 };
}
function outcome(use: RewardExposureDraft, value: number): RewardFeedback {
  return { schemaVersion: 1, id: `feedback-${use.id}`, exposureId: use.id, source: { ...use.source, eventId: "same-result" },
    evidenceIds: ["same-result"], origin: "environment", outcome: { kind: "measured", value, confidence: 1, noiseVariance: 1 },
    attribution: { kind: "linked", shares: use.targets.map(target => ({ target, share: 1 / use.targets.length })) }, observedAt: 2 };
}
function register(state: BoardState, use: RewardExposureDraft): BoardState {
  const result = reduce(state, { type: "record_reward_exposure", commandId: use.id, issuedAt: "1", exposure: use });
  assert.ok(result.ok, result.ok ? "" : result.reason);
  return result.state;
}

test("reward generality: future object kinds and two metrics accept one shared observation without cross-credit", () => {
  let state = emptyBoardState();
  for (const kind of ["memory", "user_preference", "prompt", "skill", "workflow", "tool", "learning_strategy", "future.module"]) {
    for (const [metric, value] of [[quality, 0.8], [latency, 100]] as const) {
      const use = draft(kind, metric, `${kind}-${metric.id}`);
      state = register(state, use);
      const feedback = outcome(use, value);
      const result = reduce(state, { type: "record_reward_feedback", commandId: feedback.id, issuedAt: "2", feedback });
      assert.ok(result.ok, result.ok ? "" : result.reason);
      state = result.state;
    }
  }
  const view = rewardView(rewardRecordsOf(state));
  assert.equal(view.estimates.size, 16);
  for (const signal of view.signals) {
    assert.ok(Math.abs(signal.normalizedValue! - (signal.context.metric.id === "quality" ? 0.6 : 0.8)) < 1e-12);
    assert.equal(signal.adjustments.length, 1);
  }
});

test("reward adversary: changing the exposure ID cannot count the same use twice", () => {
  const use = draft("memory");
  const state = register(emptyBoardState(), use);
  assert.equal(normalizeBoardState(JSON.parse(JSON.stringify({ ...state, rewardFeedbacks: null })) as BoardState), undefined);
  const result = reduce(state, { type: "record_reward_exposure", commandId: "alias", issuedAt: "1", exposure: { ...use, id: "alias" } });
  assert.equal(result.ok, false);
});

test("reward recovery: shape-valid orphan feedback and conflicting metrics invalidate a snapshot", () => {
  const use = draft("memory");
  const state = register(emptyBoardState(), use);
  assert.equal(normalizeBoardState({ ...state, rewardFeedbacks: [outcome({ ...use, id: "missing" }, 0.5)] }), undefined);
  const other = state.rewardExposures![0]!;
  assert.equal(normalizeBoardState({ ...state, rewardExposures: [other, { ...other, id: "other", context: {
    ...other.context, metric: { ...quality, maximum: 2 } } }] }), undefined);
});

test("reward attribution: partial credit is conserved across unlike objects; delayed contradictory facts stay bounded", () => {
  const targets: RewardTarget[] = ["memory", "prompt", "workflow"].map(kind => ({ kind, id: "asset", version: "1" }));
  const use = { ...draft("shared"), targets };
  let state = register(emptyBoardState(), use);
  const first = outcome(use, 0);
  const apply = (feedback: RewardFeedback) => {
    const result = reduce(state, { type: "record_reward_feedback", commandId: feedback.id, issuedAt: "2", feedback });
    assert.ok(result.ok); state = result.state;
  };
  apply(first);
  apply({ ...outcome(use, 1), id: "later-user", origin: "user", observedAt: 1_000_000 });
  for (const signal of rewardView(rewardRecordsOf(state)).signals) {
    assert.ok(signal.adjustments.reduce((n, item) => n + Math.abs(item.signedCredit), 0) <= 2);
    for (const item of signal.adjustments) assert.ok(item.after.mean >= -1 && item.after.mean <= 1);
  }
});
