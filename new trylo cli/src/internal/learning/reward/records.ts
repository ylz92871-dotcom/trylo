import { MAX_REWARD_EXPOSURES, MAX_REWARD_FEEDBACKS, targetKey } from "./contracts.js";
import type { RewardExposureDraft, RewardFeedback, RewardRecords } from "./contracts.js";
import { sameMetricDefinition } from "./measurement.js";

export type RewardRecordFailure = "reward_capacity" | "reward_conflict" | "reward_exposure_missing" |
  "invalid_reward" | "reward_scope_mismatch" | "reward_target_missing";

/** One relational policy shared by command admission and snapshot recovery. */
export class RewardRecordIndex {
  private readonly exposures = new Map<string, RewardExposureDraft>();
  private readonly uses = new Set<string>();
  private readonly feedbackIds = new Set<string>();
  private readonly events = new Set<string>();
  private readonly metrics = new Map<string, RewardExposureDraft["context"]["metric"]>();
  private readonly latest = new Map<string, RewardFeedback>();

  expose(item: RewardExposureDraft): RewardRecordFailure | undefined {
    if (this.exposures.size >= MAX_REWARD_EXPOSURES) return "reward_capacity";
    const metricKey = JSON.stringify([item.context.metric.id, item.context.metric.version]);
    const metric = this.metrics.get(metricKey);
    const useKey = JSON.stringify([item.source.sessionId, item.source.turnId, item.source.attemptId,
      item.source.eventId, item.context.scope, item.context.taskFamily,
      item.context.environment, metricKey, item.targets.map(targetKey).sort()]);
    if (this.exposures.has(item.id) || this.uses.has(useKey) ||
        (metric !== undefined && !sameMetricDefinition(metric, item.context.metric))) return "reward_conflict";
    this.exposures.set(item.id, item);
    this.uses.add(useKey);
    this.metrics.set(metricKey, item.context.metric);
    return undefined;
  }

  feedback(item: RewardFeedback): RewardRecordFailure | undefined {
    if (this.feedbackIds.size >= MAX_REWARD_FEEDBACKS) return "reward_capacity";
    const exposure = this.exposures.get(item.exposureId);
    if (exposure === undefined) return "reward_exposure_missing";
    const { source, context } = exposure;
    if (item.outcome.kind === "measured" && (item.outcome.value < context.metric.minimum ||
        item.outcome.value > context.metric.maximum)) return "invalid_reward";
    if (source.sessionId !== item.source.sessionId || source.turnId !== item.source.turnId ||
        source.attemptId !== item.source.attemptId || item.observedAt < exposure.occurredAt) return "reward_scope_mismatch";
    if (item.attribution.kind === "linked" && item.attribution.shares.some(share =>
      !exposure.targets.some(target => targetKey(target) === targetKey(share.target)))) return "reward_target_missing";
    const originKey = JSON.stringify([item.exposureId, item.origin]);
    const eventKey = JSON.stringify([originKey, item.source.eventId]);
    if (this.feedbackIds.has(item.id) || this.events.has(eventKey)) return "reward_conflict";
    const previous = this.latest.get(originKey);
    if (item.supersedes !== previous?.id || (previous !== undefined && item.observedAt < previous.observedAt)) return "reward_conflict";
    this.feedbackIds.add(item.id);
    this.events.add(eventKey);
    this.latest.set(originKey, item);
    return undefined;
  }
}

export function indexRewardRecords(records: RewardRecords): RewardRecordIndex | undefined {
  const index = new RewardRecordIndex();
  for (const item of records.exposures) {
    if ((item.priorFeedbackCount ?? 0) > records.feedbacks.length || index.expose(item) !== undefined) return undefined;
  }
  for (const item of records.feedbacks) if (index.feedback(item) !== undefined) return undefined;
  return index;
}
