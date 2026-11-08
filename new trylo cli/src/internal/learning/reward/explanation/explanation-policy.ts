import { initialEstimate, rewardView, type RewardView } from "../algorithm.js";
import { estimateKey } from "../contracts.js";
import type { RewardEstimate, RewardExposure, RewardFeedback, RewardRecords, RewardSignal,
  RewardSource, RewardTarget } from "../contracts.js";
import type { ReportedFeedbackUnit } from "./reported-estimate.js";

/** Source admission and Board loading belong to the reader, not this pure explanation policy. */
export type RewardExposureBinding = {
  readonly unit: ReportedFeedbackUnit;
  readonly source: RewardSource;
  readonly exposureId?: string;
  readonly closeEventId?: string;
  readonly otherReason?: "denied" | "cancelled" | "unverified";
};

export type FeedbackInvestigationQuestion = {
  readonly kind: "missing_qualifying_close" | "unresolved_failure_meaning" | "revision_target" | "revision_reveal";
  readonly unitId: string;
  readonly evidenceIds: readonly string[];
  readonly feedbackIds: readonly string[];
  readonly text: string;
};

export type LegacyFeedbackHistoryEntry = {
  /** Zero-based position in the full RW1 array; never a Board sequence or a source known-at. */
  readonly feedbackArrayIndex: number;
  readonly state: "active" | "superseded";
  readonly feedback: RewardFeedback;
};

export type LegacySignalExplanation = {
  readonly basis: "current_full_reward_view_reconstruction";
  readonly signal: RewardSignal;
  readonly currentUpdates: readonly { readonly target: RewardTarget; readonly currentUpdateMeanChange: number }[];
};

export type LegacyFeedbackUnitExplanation =
  | { readonly unitId: string; readonly status: "not_recorded" | "binding_mismatch" }
  | { readonly unitId: string; readonly status: "matched"; readonly exposure: RewardExposure;
    readonly feedbackHistory: readonly LegacyFeedbackHistoryEntry[];
    readonly activeSignals: readonly LegacySignalExplanation[];
    readonly questions: readonly FeedbackInvestigationQuestion[] };

export type LegacyRevisionTargetDifference = {
  readonly target: RewardTarget;
  readonly estimateKey: string;
  readonly before: RewardEstimate;
  readonly after: RewardEstimate;
  readonly beforeBasis: "active_estimate" | "initial_default";
  readonly afterBasis: "active_estimate" | "initial_default";
  readonly meanDifference: number;
  readonly varianceDifference: number;
};

export type LegacyRevisionPrefixComparison =
  | { readonly status: "none" }
  | { readonly status: "compared"; readonly basis: "feedback_prefix_reconstruction_difference";
    readonly unitId: string; readonly source: RewardSource; readonly exposureId: string;
    readonly feedbackId: string; readonly supersedes: string; readonly feedbackArrayIndex: number;
    readonly beforeFeedbackCount: number; readonly afterFeedbackCount: number; readonly currentFeedbackCount: number;
    readonly targets: readonly LegacyRevisionTargetDifference[] };

/** This source-only question remains available when the independent Board read fails. */
export function pendingReportQuestions(bindings: readonly RewardExposureBinding[]): readonly FeedbackInvestigationQuestion[] {
  return bindings.filter(binding => binding.unit.status === "pending").map(binding => question(binding,
    "missing_qualifying_close", [], "该请求截至本次源水位未见合格关闭；缺哪条可配对的原回执或关闭事实？"));
}

/** Preserve full RW1 history before choosing which source units to display. */
export function explainLegacyFeedback(records: RewardRecords,
  bindings: readonly RewardExposureBinding[]): readonly LegacyFeedbackUnitExplanation[] {
  const view = rewardView(records);
  const activeIds = new Set(view.signals.map(signal => signal.feedbackId));
  const exposures = new Map(records.exposures.map(exposure => [exposure.id, exposure]));
  const histories = new Map<string, LegacyFeedbackHistoryEntry[]>();
  const signals = new Map<string, LegacySignalExplanation[]>();

  records.feedbacks.forEach((feedback, feedbackArrayIndex) => appendTo(histories, feedback.exposureId,
    { feedback, feedbackArrayIndex, state: activeIds.has(feedback.id) ? "active" : "superseded" }));

  for (const signal of view.signals) appendTo(signals, signal.exposureId, explainSignal(signal));

  return bindings.map(binding => {
    const exposure = binding.exposureId === undefined ? undefined : exposures.get(binding.exposureId);
    if (exposure === undefined) return { unitId: binding.unit.unitId, status: "not_recorded" };
    if (!sameSource(exposure.source, binding.source)) return { unitId: binding.unit.unitId, status: "binding_mismatch" };
    const feedbackHistory = histories.get(exposure.id) ?? [];
    return { unitId: binding.unit.unitId, status: "matched", exposure, feedbackHistory,
      activeSignals: signals.get(exposure.id) ?? [], questions: legacyQuestions(binding, feedbackHistory) };
  });
}

/** At most one arrival-prefix comparison, not a published estimate or a causal revision effect. */
export function explainLatestLegacyRevision(records: RewardRecords,
  bindings: readonly RewardExposureBinding[]): LegacyRevisionPrefixComparison {
  const exposures = new Map(records.exposures.map(exposure => [exposure.id, exposure]));
  const matched = new Map<string, { exposure: RewardExposure; binding: RewardExposureBinding }>();

  for (const binding of bindings) {
    const exposure = binding.exposureId === undefined ? undefined : exposures.get(binding.exposureId);
    if (exposure !== undefined && sameSource(exposure.source, binding.source)) matched.set(exposure.id, { exposure, binding });
  }

  for (let index = records.feedbacks.length - 1; index >= 0; index -= 1) {
    const feedback = records.feedbacks[index]!;
    const match = matched.get(feedback.exposureId);
    if (feedback.supersedes === undefined || match === undefined) continue;

    // Full exposures retain their original frozen predictions. These slices are not Board snapshots:
    // future exposure watermarks may exceed a slice, so do not re-admit them with indexRewardRecords.
    const before = rewardView({ exposures: records.exposures, feedbacks: records.feedbacks.slice(0, index) });
    const after = rewardView({ exposures: records.exposures, feedbacks: records.feedbacks.slice(0, index + 1) });

    return { status: "compared", basis: "feedback_prefix_reconstruction_difference", unitId: match.binding.unit.unitId,
      source: match.binding.source, exposureId: match.exposure.id, feedbackId: feedback.id, supersedes: feedback.supersedes,
      feedbackArrayIndex: index, beforeFeedbackCount: index, afterFeedbackCount: index + 1,
      currentFeedbackCount: records.feedbacks.length,
      targets: match.exposure.targets.map(target => targetDifference(match.exposure, target, before, after)) };
  }

  return { status: "none" };
}

function explainSignal(signal: RewardSignal): LegacySignalExplanation {
  return { basis: "current_full_reward_view_reconstruction", signal,
    currentUpdates: signal.adjustments.map(adjustment => ({ target: adjustment.target,
      currentUpdateMeanChange: adjustment.after.mean - adjustment.before.mean })) };
}

function legacyQuestions(binding: RewardExposureBinding,
  history: readonly LegacyFeedbackHistoryEntry[]): readonly FeedbackInvestigationQuestion[] {
  const questions: FeedbackInvestigationQuestion[] = [];
  const unresolved = history.filter(entry => entry.state === "active" && entry.feedback.attribution.kind === "unresolved");
  if (binding.unit.status === "failure" && unresolved.length > 0) questions.push(question(binding,
    "unresolved_failure_meaning", unresolved.map(entry => entry.feedback),
    "该失败状态是否就是预期诊断结果；哪个原任务目标或验收事实支持其好坏含义与责任判断？"));

  const revisions = history.filter(entry => entry.feedback.supersedes !== undefined).map(entry => entry.feedback);
  if (revisions.length > 0) {
    questions.push(question(binding, "revision_target", revisions,
      "本次修订沿用哪个原目标或验收版本，还是提出了新要求？现有修订字段未证明其角色。"));
    questions.push(question(binding, "revision_reveal", revisions,
      "若沿用同一目标，修正值由哪份原始记录即可确定，还是由哪条后到事实才确定；实际何时可见？"));
  }

  return questions;
}

function question(binding: RewardExposureBinding, kind: FeedbackInvestigationQuestion["kind"],
  feedbacks: readonly RewardFeedback[], text: string): FeedbackInvestigationQuestion {
  return { kind, unitId: binding.unit.unitId, feedbackIds: feedbacks.map(feedback => feedback.id), text,
    evidenceIds: [...new Set([binding.source.eventId, ...(binding.closeEventId === undefined ? [] : [binding.closeEventId]),
      ...feedbacks.flatMap(feedback => feedback.evidenceIds)])] };
}

function targetDifference(exposure: RewardExposure, target: RewardTarget,
  beforeView: RewardView, afterView: RewardView): LegacyRevisionTargetDifference {
  const key = estimateKey(exposure.context, target);
  const beforeEstimate = beforeView.estimates.get(key);
  const afterEstimate = afterView.estimates.get(key);
  const before = beforeEstimate ?? initialEstimate();
  const after = afterEstimate ?? initialEstimate();

  return { target, estimateKey: key, before, after,
    beforeBasis: beforeEstimate === undefined ? "initial_default" : "active_estimate",
    afterBasis: afterEstimate === undefined ? "initial_default" : "active_estimate",
    meanDifference: after.mean - before.mean, varianceDifference: after.variance - before.variance };
}

function sameSource(left: RewardSource, right: RewardSource): boolean {
  return left.sessionId === right.sessionId && left.turnId === right.turnId &&
    left.attemptId === right.attemptId && left.eventId === right.eventId;
}

function appendTo<T>(groups: Map<string, T[]>, key: string, value: T): void {
  const group = groups.get(key) ?? [];
  group.push(value);
  groups.set(key, group);
}
