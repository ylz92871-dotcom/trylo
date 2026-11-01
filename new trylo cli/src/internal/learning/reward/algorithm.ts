import type { RewardAdjustment, RewardEstimate, RewardFeedback, RewardExposure, RewardOrigin, RewardSignal, RewardRecords, RewardContext, RewardTarget } from "./contracts.js";
import { estimateKey, targetKey } from "./contracts.js";
import { normalizedReward } from "./measurement.js";

const SOURCE_WEIGHT: Readonly<Record<RewardOrigin, number>> = { environment: 1, user: 1, model: 0.25 };
export function initialEstimate(): RewardEstimate { return { mean: 0, variance: 1 }; }

/** Fractional-gain observation update. Not a Bellman backup or causal estimator. */
function adjust(before: RewardEstimate, frozen: RewardEstimate, feedback: RewardFeedback,
  target: RewardTarget, share: number, value: number): RewardAdjustment | undefined {
  if (feedback.outcome.kind === "unknown") return undefined;
  const outcome = feedback.outcome;
  const weight = SOURCE_WEIGHT[feedback.origin] * outcome.confidence * share;
  const gain = weight * before.variance / (before.variance + outcome.noiseVariance);
  const innovation = value - before.mean;
  return { target, predictionError: value - frozen.mean, innovation, gain,
    signedCredit: weight * (value - frozen.mean), before,
    after: { mean: (1 - gain) * before.mean + gain * value,
      variance: Math.max(Number.EPSILON, (1 - gain) * before.variance) } };
}

export type RewardView = {
  readonly estimates: ReadonlyMap<string, RewardEstimate>;
  readonly signals: readonly RewardSignal[];
};

/** Rebuild from active immutable facts. A correction removes its old numeric influence. */
export function rewardView(records: RewardRecords): RewardView {
  const exposures = new Map(records.exposures.map(exposure => [exposure.id, exposure]));
  const replaced = new Set(records.feedbacks.flatMap(item => item.supersedes === undefined ? [] : [item.supersedes]));
  const estimates = new Map<string, RewardEstimate>();
  const signals: RewardSignal[] = [];
  for (const feedback of records.feedbacks) {
    if (replaced.has(feedback.id)) continue;
    const exposure = exposures.get(feedback.exposureId);
    if (exposure === undefined) continue;
    signals.push(signalFor(exposure, feedback, estimates));
  }
  return { estimates, signals };
}

function signalFor(exposure: RewardExposure, feedback: RewardFeedback,
  estimates: Map<string, RewardEstimate>): RewardSignal {
  const adjustments: RewardAdjustment[] = [];
  const normalizedValue = feedback.outcome.kind === "measured"
    ? normalizedReward(exposure.context.metric, feedback.outcome.value) : undefined;
  let assigned = 0;
  if (feedback.attribution.kind === "linked") {
    for (const item of feedback.attribution.shares) {
      const prediction = exposure.predictions.find(entry => targetKey(entry.target) === targetKey(item.target));
      if (prediction === undefined) continue;
      assigned += item.share;
      const key = estimateKey(exposure.context, item.target);
      const update = adjust(estimates.get(key) ?? initialEstimate(), prediction.estimate, feedback, item.target, item.share, normalizedValue ?? 0);
      if (update !== undefined) { adjustments.push(update); estimates.set(key, update.after); }
    }
  }
  const measured = feedback.outcome.kind === "measured" ? feedback.outcome : undefined;
  const credit = adjustments.reduce((sum, item) => sum + item.signedCredit, 0);
  return { schemaVersion: 1, feedbackId: feedback.id, exposureId: exposure.id, context: exposure.context,
    origin: feedback.origin, source: feedback.source, evidenceIds: feedback.evidenceIds,
    outcome: feedback.outcome, adjustments, unassignedShare: 1 - assigned,
    ...(normalizedValue === undefined ? {} : { normalizedValue }),
    investigationPressure: measured === undefined ? 0 : SOURCE_WEIGHT[feedback.origin] * measured.confidence * Math.abs(normalizedValue ?? 0),
    direction: measured === undefined ? "observe" : credit > 0 ? "positive_credit" : credit < 0 ? "negative_credit" : assigned < 1 ? "investigate" : "observe" };
}

/** Called under Board ownership BEFORE the outcome exists. */
export function predictionsFor(view: RewardView, context: RewardContext,
  targets: readonly RewardTarget[]): RewardExposure["predictions"] {
  return targets.map(target => ({ target, estimate: view.estimates.get(estimateKey(context, target)) ?? initialEstimate() }));
}
