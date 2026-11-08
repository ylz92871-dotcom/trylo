import assert from "node:assert/strict";
import test from "node:test";
import type { RewardExposure, RewardFeedback, RewardRecords, RewardTarget } from "../contracts.js";
import { explainLatestLegacyRevision, explainLegacyFeedback, pendingReportQuestions,
  type RewardExposureBinding } from "./explanation-policy.js";

const target: RewardTarget = { kind: "tool", id: "diagnose", version: "env1" };

function exposure(id: string, sessionId: string, frozenMean = 0, frozenVariance = 1): RewardExposure {
  return { schemaVersion: 1, id, source: { sessionId, turnId: "turn", attemptId: "attempt", eventId: `use-${id}` },
    context: { scope: "workspace", taskFamily: "diagnostic", environment: "env1",
      metric: { id: "execution.tool_result", version: "1", unit: "status", minimum: -1, maximum: 1, preference: "higher" } },
    targets: [target], occurredAt: 1, predictions: [{ target, estimate: { mean: frozenMean, variance: frozenVariance } }] };
}

function feedback(id: string, used: RewardExposure, value: number,
  origin: RewardFeedback["origin"] = "user", supersedes?: string): RewardFeedback {
  return { schemaVersion: 1, id, exposureId: used.id, source: { ...used.source, eventId: `result-${id}` }, origin,
    evidenceIds: [`result-${id}`], outcome: { kind: "measured", value, confidence: 1, noiseVariance: 1 },
    attribution: { kind: "linked", shares: [{ target, share: 1 }] }, observedAt: 2,
    ...(supersedes === undefined ? {} : { supersedes }) };
}

function binding(used: RewardExposure, status: "success" | "failure", registeredAt: number): RewardExposureBinding {
  return { unit: { unitId: used.id, registeredAt, status, revealedAt: registeredAt + 1 }, source: used.source,
    exposureId: used.id, closeEventId: `close-${used.id}` };
}

function near(actual: number, expected: number): void { assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`); }

test("feedback explanation preserves other sessions' full RW1 history before display selection", () => {
  const prior = exposure("prior", "other-session");
  const selected = exposure("selected", "selected-session", 0.5, 0.5);
  const records: RewardRecords = { exposures: [prior, selected],
    feedbacks: [feedback("prior-positive", prior, 1), feedback("selected-positive", selected, 1)] };
  const before = JSON.stringify(records);
  const result = explainLegacyFeedback(records, [binding(selected, "success", 3)])[0]!;

  assert.equal(result.status, "matched");

  if (result.status !== "matched") return;

  assert.equal(result.feedbackHistory[0]!.feedbackArrayIndex, 1);
  const active = result.activeSignals[0]!;
  const adjustment = active.signal.adjustments[0]!;

  near(adjustment.before.mean, 0.5);
  near(adjustment.gain, 1 / 3);
  near(adjustment.after.mean, 2 / 3);
  near(adjustment.predictionError, 0.5);
  near(active.currentUpdates[0]!.currentUpdateMeanChange, 1 / 6);
  assert.equal(active.basis, "current_full_reward_view_reconstruction");
  assert.equal(JSON.stringify(records), before);
});

test("source questions and one revision prefix difference preserve reports, heads and original known-at roles", () => {
  const a = exposure("A", "session");
  const b = exposure("B", "session");
  const aOld = feedback("a-old", a, -1);
  const bRaw: RewardFeedback = { ...feedback("b-raw", b, -1, "environment"), attribution: { kind: "unresolved" } };
  const bUser = feedback("b-user", b, 1);
  const aNew = feedback("a-new", a, 0.5, "user", aOld.id);
  const records: RewardRecords = { exposures: [a, b], feedbacks: [aOld, bRaw, bUser, aNew] };
  const pending: RewardExposureBinding = { unit: { unitId: "C", registeredAt: 5, status: "pending" },
    source: { sessionId: "session", turnId: "turn", attemptId: "attempt", eventId: "use-C" } };
  const bindings = [binding(a, "success", 1), binding(b, "failure", 3), pending];
  const before = JSON.stringify({ records, bindings });

  assert.deepEqual(pendingReportQuestions(bindings).map(item => [item.unitId, item.kind]), [["C", "missing_qualifying_close"]]);
  const result = explainLegacyFeedback(records, bindings);
  const aResult = result[0]!;
  const bResult = result[1]!;

  assert.equal(aResult.status, "matched");
  assert.equal(bResult.status, "matched");
  assert.deepEqual(result[2], { unitId: "C", status: "not_recorded" });

  if (aResult.status !== "matched" || bResult.status !== "matched") return;

  assert.deepEqual(aResult.feedbackHistory.map(item => [item.feedback.id, item.feedbackArrayIndex, item.state]),
    [["a-old", 0, "superseded"], ["a-new", 3, "active"]]);
  assert.deepEqual(aResult.questions.map(item => item.kind), ["revision_target", "revision_reveal"]);
  assert.deepEqual(bResult.questions.map(item => item.kind), ["unresolved_failure_meaning"]);
  near(aResult.activeSignals[0]!.signal.adjustments[0]!.innovation, 0);
  near(aResult.activeSignals[0]!.currentUpdates[0]!.currentUpdateMeanChange, 0);
  assert.equal(aResult.activeSignals[0]!.signal.adjustments[0]!.predictionError, 0.5);
  assert.equal(bResult.activeSignals.find(item => item.signal.feedbackId === "b-raw")!.signal.adjustments.length, 0);
  const revision = explainLatestLegacyRevision(records, bindings);

  assert.equal(revision.status, "compared");

  if (revision.status !== "compared") return;

  assert.equal(revision.basis, "feedback_prefix_reconstruction_difference");
  assert.equal(revision.feedbackId, "a-new");
  assert.equal(revision.supersedes, "a-old");
  assert.deepEqual([revision.beforeFeedbackCount, revision.afterFeedbackCount, revision.currentFeedbackCount], [3, 4, 4]);
  near(revision.targets[0]!.before.mean, 0);
  near(revision.targets[0]!.after.mean, 0.5);
  near(revision.targets[0]!.meanDifference, 0.5);
  assert.equal("quality" in aResult, false);
  assert.equal(JSON.stringify({ records, bindings }), before);
});
