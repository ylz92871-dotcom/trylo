import assert from "node:assert/strict";
import test from "node:test";
import { emptyBoardState, normalizeBoardState, type BoardState } from "../control/state.js";
import { reduce } from "../control/reducer.js";
import { rewardRecordsOf } from "../control/reward-records.js";
import { rewardView } from "./algorithm.js";
import { estimateKey } from "./contracts.js";
import type { RewardExposureDraft, RewardFeedback, RewardTarget } from "./contracts.js";

const target: RewardTarget = { kind: "method", id: "parse-file", version: "v1" };
function exposure(id = "e1", environment = "env1"): RewardExposureDraft {
  return { schemaVersion: 1, id, source: { sessionId: "s", turnId: "t", attemptId: "a", eventId: `used-${id}` },
    context: { scope: "ws", taskFamily: "parse", environment,
      metric: { id: "task.quality", version: "1", unit: "utility", minimum: -1, maximum: 1, preference: "higher" } },
    targets: [target], occurredAt: 1 };
}
function feedback(id = "f1", exposureId = "e1", value = 1): RewardFeedback {
  return { schemaVersion: 1, id, exposureId, source: { sessionId: "s", turnId: "t", attemptId: "a", eventId: `result-${id}` },
    origin: "environment", evidenceIds: [`result-${id}`], outcome: { kind: "measured", value, confidence: 1, noiseVariance: 1 },
    attribution: { kind: "linked", shares: [{ target, share: 1 }] }, observedAt: 2 };
}
function use(state: BoardState, draft = exposure()): BoardState {
  const result = reduce(state, { type: "record_reward_exposure", commandId: `use-${draft.id}`, issuedAt: "now", exposure: draft });
  assert.ok(result.ok, result.ok ? "" : result.reason);
  return result.state;
}
function observe(state: BoardState, item = feedback()): BoardState {
  const result = reduce(state, { type: "record_reward_feedback", commandId: `observe-${item.id}`, issuedAt: "now", feedback: item });
  assert.ok(result.ok, result.ok ? "" : result.reason);
  return result.state;
}
function view(state: BoardState) { return rewardView(rewardRecordsOf(state)); }

test("reward: a use freezes its prior; a real outcome changes the next use prediction", () => {
  let state = use(emptyBoardState());
  assert.equal(state.rewardExposures![0]!.predictions[0]!.estimate.mean, 0);
  state = observe(state);
  const signal = view(state).signals[0]!;
  assert.equal(signal.adjustments[0]!.after.mean, 0.5);
  state = use(state, exposure("e2"));
  assert.equal(state.rewardExposures![1]!.predictions[0]!.estimate.mean, 0.5);
  assert.equal(state.rewardExposures![0]!.predictions[0]!.estimate.mean, 0);
});

test("reward: unknown, cancellation and zero attribution never punish a method", () => {
  for (const reason of ["cancelled", "denied", "unverified", "missing"] as const) {
    const state = observe(use(emptyBoardState()), { ...feedback(), outcome: { kind: "unknown", reason } });
    assert.equal(view(state).estimates.size, 0);
    assert.equal(view(state).signals[0]!.direction, "observe");
  }
  for (const kind of ["external", "unresolved"] as const) {
    const state = observe(use(emptyBoardState()), { ...feedback("f1", "e1", -1), attribution: { kind } });
    assert.equal(view(state).estimates.size, 0);
    assert.equal(view(state).signals[0]!.investigationPressure, 1);
    assert.equal(view(state).signals[0]!.unassignedShare, 1);
  }
});

test("reward: source and noise reduce learning magnitude without changing raw result", () => {
  const base = use(emptyBoardState());
  const environment = view(observe(base)).signals[0]!.adjustments[0]!.after.mean;
  const model = view(observe(base, { ...feedback(), origin: "model" })).signals[0]!.adjustments[0]!.after.mean;
  const noisy = view(observe(base, { ...feedback(), outcome: { kind: "measured", value: 1, confidence: 1, noiseVariance: 4 } })).signals[0]!.adjustments[0]!.after.mean;
  assert.ok(model < environment && noisy < environment);
});

test("reward: corrections replace numeric influence, remain auditable, and survive re-projection", () => {
  let state = observe(use(emptyBoardState()), feedback("f1", "e1", -1));
  state = observe(state, { ...feedback("f2"), supersedes: "f1", observedAt: 3 });
  assert.equal(state.rewardFeedbacks!.length, 2);
  assert.equal(view(state).signals.length, 1);
  assert.equal(view(state).signals[0]!.adjustments[0]!.after.mean, 0.5);
  const restored = normalizeBoardState(JSON.parse(JSON.stringify(state)) as BoardState);
  assert.ok(restored);
  assert.deepEqual(view(restored), view(state));
});

test("reward: context, environment and target version isolate learned predictions", () => {
  const learned = observe(use(emptyBoardState()));
  for (const draft of [exposure("e2", "env2"), { ...exposure("e2"), context: { ...exposure().context, scope: "ws2" } },
    { ...exposure("e2"), targets: [{ ...target, version: "v2" }] }]) {
    const next = use(learned, draft);
    assert.equal(next.rewardExposures!.at(-1)!.predictions[0]!.estimate.mean, 0);
  }
});

test("reward: feedback needs real use, matching source, legal shares and an explicit revision", () => {
  const state = use(emptyBoardState());
  const bad: RewardFeedback[] = [feedback("f", "missing"),
    { ...feedback(), source: { ...feedback().source, turnId: "wrong" } },
    { ...feedback(), attribution: { kind: "linked", shares: [{ target: { ...target, version: "missing" }, share: 1 }] } },
    { ...feedback(), outcome: { kind: "measured", value: Number.NaN, confidence: 1, noiseVariance: 1 } },
    { ...feedback(), attribution: { kind: "linked", shares: [{ target, share: 1.1 }] } }];
  for (const item of bad) assert.equal(reduce(state, { type: "record_reward_feedback", commandId: "bad", issuedAt: "now", feedback: item }).ok, false);
  const once = observe(state);
  assert.equal(reduce(once, { type: "record_reward_feedback", commandId: "new", issuedAt: "now", feedback: feedback("f2") }).ok, false);
});

test("reward: command identity is idempotent and changing its payload is refused", () => {
  const command = { type: "record_reward_feedback" as const, commandId: "observe-f1", issuedAt: "later", feedback: feedback() };
  const state = observe(use(emptyBoardState()));
  const replay = reduce(state, command);
  assert.ok(replay.ok && replay.idempotent);
  const conflict = reduce(state, { ...command, feedback: feedback("f1", "e1", -1) });
  assert.ok(!conflict.ok && conflict.reason === "command_payload_conflict");
});

test("reward: numerical boundedness, noise monotonicity and precision closed form", () => {
  for (const value of [-1, -0.1, 0, 0.1, 1]) {
    let state = emptyBoardState();
    for (let i = 1; i <= 40; i += 1) {
      state = observe(use(state, exposure(`e${i}`)), feedback(`f${i}`, `e${i}`, value));
      const estimate = view(state).estimates.get(estimateKey(exposure().context, target))!;
      assert.ok(estimate.mean >= -1 && estimate.mean <= 1 && estimate.variance > 0);
      assert.ok(Math.abs(estimate.mean - i * value / (1 + i)) < 1e-12);
      assert.ok(Math.abs(estimate.variance - 1 / (1 + i)) < 1e-12);
    }
  }
});

test("reward: delayed credit sign describes frozen expectation, independently of current estimate movement", () => {
  for (const sign of [-1, 1]) {
    let state = use(use(emptyBoardState(), exposure("early")), exposure("later"));
    state = observe(state, feedback("later-result", "later", sign));
    state = observe(state, feedback("early-result", "early", sign * 0.2));
    const signal = view(state).signals.find(item => item.feedbackId === "early-result")!;
    const adjustment = signal.adjustments[0]!;
    assert.equal(Math.sign(adjustment.signedCredit), sign);
    assert.equal(Math.sign(adjustment.innovation), -sign);
    assert.ok(Math.abs(adjustment.after.mean - sign * 0.4) < 1e-12);
    assert.equal(signal.direction, sign > 0 ? "positive_credit" : "negative_credit");
  }
});
