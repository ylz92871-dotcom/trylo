import type { BoardState } from "../../../../../control/state.js";
import { READ_STRATEGY_DECISION_POINT, type ReadStrategyLearningRequest, type ReadStrategyLearningResult,
  type ReadStrategyPath, type ReadStrategyPathStatistics, type ReadStrategyRule } from "./contracts.js";
import { readStrategyInputs, readStrategyObservations, type ReadStrategyObservation } from "./observations.js";
import { isReadStrategyLearningRequest, readStrategyEnvironment } from "./parse.js";

function supported(observations: readonly ReadStrategyObservation[], path: ReadStrategyPath): readonly ReadStrategyObservation[] {
  const failedAt = Math.max(-1, ...observations.filter(item => item.path === path && item.quality === "failed")
    .map(item => item.feedback!.observedAt));
  const seen = new Set<string>();

  return observations.filter(item => {
    if (item.path !== path || item.quality !== "verified" || item.feedback!.observedAt <= failedAt) return false;
    const source = item.exposure.source;
    const execution = JSON.stringify([source.sessionId, source.turnId, source.attemptId, source.eventId]);
    if (seen.has(execution)) return false;
    seen.add(execution);
    return true;
  });
}

function statistics(observations: readonly ReadStrategyObservation[]): ReadStrategyPathStatistics {
  return { samples: observations.length, meanCost: observations.reduce((sum, item) => sum + item.cost!, 0) / observations.length };
}

export function induceReadStrategyRule(observations: readonly ReadStrategyObservation[]): ReadStrategyRule | undefined {
  const conditions = observations[0]?.conditions;
  if (conditions === undefined || !conditions.streaming) return undefined;

  const whole = supported(observations, "whole");
  const stream = supported(observations, "stream");
  if (whole.length < 2 || stream.length < 2) return undefined;

  const stats = { whole: statistics(whole), stream: statistics(stream) };
  // Equal cost keeps the existing production streaming strategy.
  const path = stats.whole.meanCost < stats.stream.meanCost ? "whole" : "stream";
  const support = [...whole, ...stream];

  return { conditions, path, statistics: stats,
    feedbackIds: support.map(item => item.feedback!.id).sort(),
    evidenceIds: [...new Set(support.flatMap(item => item.feedback!.evidenceIds))].sort() };
}

/** Pure domain entry: no execution, persistence, scheduler, permissions, or model calls. */
export function learnReadStrategy(state: BoardState, request: ReadStrategyLearningRequest): ReadStrategyLearningResult {
  if (!isReadStrategyLearningRequest(request)) {
    return { status: "disabled", reason: "invalid_request", consumed: { observations: 0 } };
  }

  const records = { exposures: state.rewardExposures ?? [], feedbacks: state.rewardFeedbacks ?? [] };
  if (readStrategyInputs(records, request.scope).length > request.budget.maxObservations) {
    return { status: "budget_exhausted", reason: "complete_comparison_exceeds_allowance", consumed: { observations: 0 } };
  }

  const observations = readStrategyObservations(records, request.scope);
  const groups = new Map<string, ReadStrategyObservation[]>();

  for (const item of observations) {
    const key = readStrategyEnvironment(item.conditions);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }

  const rules = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, group]) => {
      const rule = induceReadStrategyRule(group);
      return rule === undefined ? [] : [rule];
    });
  const consumed = { observations: observations.length };

  if (rules.length === 0) return { status: "waiting_evidence", reason: "two_verified_executions_per_path_required", consumed };

  return { status: "learned", reason: "verified_conditional_cost_comparison", consumed,
    policy: { schemaVersion: 2, owner: "tool.read-strategy", decisionPoint: READ_STRATEGY_DECISION_POINT, scope: request.scope,
      requestId: request.requestId, issuedAt: request.issuedAt, basedOnSequence: state.sequence, rules } };
}
