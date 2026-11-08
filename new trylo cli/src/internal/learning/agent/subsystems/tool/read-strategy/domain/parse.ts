import { bounded, identity, object, only } from "../../../../../reward/validate.js";
import { READ_STRATEGY_COST_METRIC, READ_STRATEGY_DECISION_POINT,
  type ReadStrategyConditions, type ReadStrategyLearningRequest, type ReadStrategyPathStatistics, type ReadStrategyPolicy, type ReadStrategyRule } from "./contracts.js";

export function isReadStrategyConditions(value: unknown): value is ReadStrategyConditions {
  return object(value) && only(value, ["schemaVersion", "fileSize", "range", "streaming"])
    && value.schemaVersion === 1 && (value.fileSize === "small" || value.fileSize === "large")
    && (value.range === "bounded" || value.range === "all") && typeof value.streaming === "boolean";
}

function decodeJson(value: string): unknown {
  try { return JSON.parse(value); }
  catch { return undefined; } // Invalid persisted content is ineligible, never partially repaired.
}

/** Canonical tuple spelling prevents object key order from creating different niches. */
export function readStrategyEnvironment(conditions: ReadStrategyConditions): string {
  return JSON.stringify({ schemaVersion: 1, fileSize: conditions.fileSize, range: conditions.range, streaming: conditions.streaming });
}

export function parseReadStrategyConditions(value: string): ReadStrategyConditions | undefined {
  const decoded = decodeJson(value);
  return isReadStrategyConditions(decoded) ? decoded : undefined;
}

export function isReadStrategyLearningRequest(value: unknown): value is ReadStrategyLearningRequest {
  return object(value) && only(value, ["domain", "scope", "requestId", "issuedAt", "budget"])
    && value.domain === "tool" && identity(value.scope) && identity(value.requestId)
    && identity(value.issuedAt) && Number.isFinite(Date.parse(value.issuedAt))
    && object(value.budget) && only(value.budget, ["maxObservations"])
    && typeof value.budget.maxObservations === "number" && Number.isSafeInteger(value.budget.maxObservations)
    && value.budget.maxObservations >= 0;
}

function statistics(value: unknown): value is ReadStrategyPathStatistics {
  return object(value) && only(value, ["samples", "meanCost"])
    && typeof value.samples === "number" && Number.isSafeInteger(value.samples) && value.samples >= 2
    && bounded(value.meanCost, 0, READ_STRATEGY_COST_METRIC.maximum);
}

function identities(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 16384
    && value.every(identity) && new Set(value).size === value.length;
}

function rule(value: unknown): value is ReadStrategyRule {
  return object(value) && only(value, ["conditions", "path", "evidenceIds", "feedbackIds", "statistics"])
    && isReadStrategyConditions(value.conditions) && value.conditions.streaming
    && (value.path === "whole" || value.path === "stream")
    && identities(value.evidenceIds) && identities(value.feedbackIds)
    && object(value.statistics) && only(value.statistics, ["whole", "stream"])
    && statistics(value.statistics.whole) && statistics(value.statistics.stream);
}

export function isReadStrategyPolicy(value: unknown): value is ReadStrategyPolicy {
  if (!object(value) || !only(value, ["schemaVersion", "owner", "decisionPoint", "scope", "requestId", "issuedAt", "basedOnSequence", "rules"])
    || value.schemaVersion !== 2 || value.owner !== "tool.read-strategy" || value.decisionPoint !== READ_STRATEGY_DECISION_POINT || !identity(value.scope)
    || !identity(value.requestId) || !identity(value.issuedAt) || !Number.isFinite(Date.parse(value.issuedAt))
    || typeof value.basedOnSequence !== "number" || !Number.isSafeInteger(value.basedOnSequence) || value.basedOnSequence < 0
    || !Array.isArray(value.rules) || value.rules.length === 0 || value.rules.length > 4 || !value.rules.every(rule)) return false;
  return new Set(value.rules.map(item => readStrategyEnvironment(item.conditions))).size === value.rules.length;
}

export function parseReadStrategyPolicy(content: string): ReadStrategyPolicy | undefined {
  const decoded = decodeJson(content);
  return isReadStrategyPolicy(decoded) ? decoded : undefined;
}
