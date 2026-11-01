import { MAX_REWARD_TARGETS, REWARD_ORIGINS, targetKey } from "./contracts.js";
import type { RewardAttribution, RewardContext, RewardExposure, RewardExposureDraft, RewardFeedback, RewardMeasurement, RewardMetric, RewardSource, RewardTarget } from "./contracts.js";

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
export function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && value.trim() === value;
}
export function bounded(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
function timestamp(value: unknown): value is number {
  return bounded(value, 0, Number.MAX_SAFE_INTEGER) && Number.isSafeInteger(value);
}
export function isRewardTarget(value: unknown): value is RewardTarget {
  return object(value) && only(value, ["kind", "id", "version"]) &&
    identity(value.kind) && identity(value.id) && identity(value.version);
}
export function isRewardMetric(value: unknown): value is RewardMetric {
  return object(value) && only(value, ["id", "version", "unit", "minimum", "maximum", "preference"]) &&
    identity(value.id) && identity(value.version) && identity(value.unit) &&
    bounded(value.minimum, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) &&
    bounded(value.maximum, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) && value.maximum > value.minimum &&
    (value.preference === "higher" || value.preference === "lower");
}
function isContext(value: unknown): value is RewardContext {
  return object(value) && only(value, ["scope", "taskFamily", "environment", "metric"]) &&
    identity(value.scope) && identity(value.taskFamily) && identity(value.environment) &&
    isRewardMetric(value.metric);
}
export function isRewardSource(value: unknown): value is RewardSource {
  return object(value) && only(value, ["sessionId", "turnId", "attemptId", "eventId"]) &&
    [value.sessionId, value.turnId, value.attemptId, value.eventId].every(identity);
}
export function isExposureDraft(value: unknown): value is RewardExposureDraft {
  return object(value) && only(value, ["schemaVersion", "id", "source", "context", "targets", "occurredAt", "priorFeedbackCount"]) &&
    value.schemaVersion === 1 && identity(value.id) && isRewardSource(value.source) && isContext(value.context) &&
    timestamp(value.occurredAt) && (value.priorFeedbackCount === undefined || timestamp(value.priorFeedbackCount)) &&
    Array.isArray(value.targets) && value.targets.length > 0 &&
    value.targets.length <= MAX_REWARD_TARGETS && value.targets.every(isRewardTarget) &&
    new Set(value.targets.map(targetKey)).size === value.targets.length;
}
export function isRewardExposure(value: unknown): value is RewardExposure {
  if (!object(value)) return false;
  const { predictions, ...draft } = value;
  if (!isExposureDraft(draft) || !Array.isArray(predictions) || predictions.length !== draft.targets.length) return false;
  return predictions.every((prediction, index) => object(prediction) && only(prediction, ["target", "estimate"]) &&
    isRewardTarget(prediction.target) && targetKey(prediction.target) === targetKey(draft.targets[index]!) &&
    object(prediction.estimate) && only(prediction.estimate, ["mean", "variance"]) &&
    bounded(prediction.estimate.mean, -1, 1) && bounded(prediction.estimate.variance, Number.EPSILON, 1));
}
export function isMeasurement(value: unknown): value is RewardMeasurement {
  if (!object(value)) return false;
  if (value.kind === "unknown") return only(value, ["kind", "reason"]) &&
    ["cancelled", "denied", "unverified", "missing"].some(reason => reason === value.reason);
  return value.kind === "measured" && only(value, ["kind", "value", "confidence", "noiseVariance"]) &&
    bounded(value.value, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER) &&
    bounded(value.confidence, 0, 1) && bounded(value.noiseVariance, 0.01, 4);
}
function isAttribution(value: unknown): value is RewardAttribution {
  if (!object(value)) return false;
  if (value.kind === "unresolved" || value.kind === "external") return only(value, ["kind"]);
  if (value.kind !== "linked" || !only(value, ["kind", "shares"]) || !Array.isArray(value.shares) ||
      value.shares.length === 0 || value.shares.length > MAX_REWARD_TARGETS) return false;
  let total = 0;
  const keys = new Set<string>();
  for (const item of value.shares) {
    if (!object(item) || !only(item, ["target", "share"]) || !isRewardTarget(item.target) || !bounded(item.share, 0, 1)) return false;
    const key = targetKey(item.target);
    if (keys.has(key)) return false;
    keys.add(key);
    total += item.share;
  }
  return total <= 1;
}
export function isRewardFeedback(value: unknown): value is RewardFeedback {
  return object(value) && only(value, ["schemaVersion", "id", "exposureId", "source", "origin", "evidenceIds", "outcome", "attribution", "observedAt", "supersedes"]) &&
    value.schemaVersion === 1 && identity(value.id) && identity(value.exposureId) && isRewardSource(value.source) &&
    REWARD_ORIGINS.some(origin => origin === value.origin) && Array.isArray(value.evidenceIds) &&
    value.evidenceIds.length > 0 && value.evidenceIds.length <= 32 && value.evidenceIds.every(identity) &&
    new Set(value.evidenceIds).size === value.evidenceIds.length && isMeasurement(value.outcome) &&
    isAttribution(value.attribution) && timestamp(value.observedAt) &&
    (value.supersedes === undefined || identity(value.supersedes));
}
