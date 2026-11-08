import type { RewardExposure, RewardFeedback, RewardRecords } from "../../../../../reward/contracts.js";
import { sameMetricDefinition } from "../../../../../reward/measurement.js";
import { READ_STRATEGY_COST_METRIC, READ_STRATEGY_DECISION_POINT, type ReadStrategyConditions, type ReadStrategyPath } from "./contracts.js";
import { parseReadStrategyConditions } from "./parse.js";

export type ReadStrategyObservation = {
  readonly exposure: RewardExposure;
  readonly conditions: ReadStrategyConditions;
  readonly path: ReadStrategyPath;
  readonly feedback?: RewardFeedback;
  readonly quality: "verified" | "failed" | "unknown";
  readonly cost?: number;
};

type ReadStrategyInput = Pick<ReadStrategyObservation, "exposure" | "conditions" | "path">;

/** Feedback correction replaces its old influence, using the existing Reward contract. */
export function activeReadStrategyFeedback(records: RewardRecords): readonly RewardFeedback[] {
  const replaced = new Set(records.feedbacks.flatMap(item => item.supersedes === undefined ? [] : [item.supersedes]));
  return records.feedbacks.filter(item => !replaced.has(item.id));
}

function recognized(feedback: RewardFeedback, exposure: RewardExposure, path: ReadStrategyPath): "verified" | "failed" | "unknown" {
  if (feedback.origin === "model" || feedback.outcome.kind !== "measured" || feedback.outcome.confidence <= 0
    || feedback.attribution.kind !== "linked" || !feedback.attribution.shares.some(item => item.target.kind === "tool_read_path"
      && item.target.id === path && item.target.version === "1" && item.share > 0)) return "unknown";
  const executionId = exposure.source.eventId;
  if (feedback.evidenceIds.includes(`tool-read:failed:${executionId}`)) return "failed";
  return feedback.evidenceIds.includes(`tool-read:verified:${executionId}`) ? "verified" : "unknown";
}

/** Cohort admission reads only exposure metadata, before spending the observation allowance. */
export function readStrategyInputs(records: RewardRecords, scope: string): readonly ReadStrategyInput[] {
  const inputs: ReadStrategyInput[] = [];

  for (const exposure of records.exposures) {
    if (exposure.context.scope !== scope || exposure.context.taskFamily !== READ_STRATEGY_DECISION_POINT
      || !sameMetricDefinition(exposure.context.metric, READ_STRATEGY_COST_METRIC)) continue;

    const conditions = parseReadStrategyConditions(exposure.context.environment);
    const targets = exposure.targets.filter(item => item.kind === "tool_read_path" && item.version === "1");
    const path = targets[0]?.id;
    if (conditions === undefined || targets.length !== 1 || (path !== "whole" && path !== "stream")
      || (path === "stream" && !conditions.streaming)) continue;

    inputs.push({ exposure, conditions, path });
  }

  return inputs.sort((left, right) => left.exposure.id.localeCompare(right.exposure.id));
}

/** Cost sensors alone report completed, never verified. Only linked external check evidence qualifies. */
export function readStrategyObservations(records: RewardRecords, scope: string): readonly ReadStrategyObservation[] {
  const byExposure = new Map<string, RewardFeedback[]>();

  for (const item of activeReadStrategyFeedback(records)) {
    const group = byExposure.get(item.exposureId) ?? [];
    group.push(item);
    byExposure.set(item.exposureId, group);
  }

  const observations: ReadStrategyObservation[] = [];

  for (const { exposure, conditions, path } of readStrategyInputs(records, scope)) {
    const feedback = (byExposure.get(exposure.id) ?? []).filter(item => recognized(item, exposure, path) !== "unknown")
      // Different origins cannot silently overrule each other. A failure remains
      // authoritative until corrected through that origin's supersedes chain.
      .sort((left, right) => Number(recognized(right, exposure, path) === "failed") - Number(recognized(left, exposure, path) === "failed")
        || right.observedAt - left.observedAt
        || left.id.localeCompare(right.id))[0];
    const quality = feedback === undefined ? "unknown" : recognized(feedback, exposure, path);

    observations.push({ exposure, conditions, path, quality,
      ...(feedback === undefined ? {} : { feedback }),
      ...(quality === "verified" && feedback?.outcome.kind === "measured" ? { cost: feedback.outcome.value } : {}) });
  }

  return observations;
}
