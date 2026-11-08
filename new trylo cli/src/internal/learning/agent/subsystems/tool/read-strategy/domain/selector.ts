import type { RewardRecords } from "../../../../../reward/contracts.js";
import type { ReadStrategyConditions, ReadStrategyPolicy, ReadStrategySelection } from "./contracts.js";
import { activeReadStrategyFeedback, readStrategyObservations } from "./observations.js";
import { readStrategyEnvironment } from "./parse.js";
import { induceReadStrategyRule } from "./learner.js";

/** Deterministic adoption only. The execution adapter retains its usable default path. */
export function selectReadStrategy(policy: ReadStrategyPolicy | undefined,
  input: { readonly scope: string; readonly conditions: ReadStrategyConditions }, records: RewardRecords): ReadStrategySelection {
  if (policy === undefined) return { reason: "no_policy" };

  if (policy.scope !== input.scope) return { reason: "scope_mismatch" };

  const environment = readStrategyEnvironment(input.conditions);
  const rule = policy.rules.find(item => readStrategyEnvironment(item.conditions) === environment);
  if (rule === undefined) return { reason: "condition_mismatch" };

  const active = new Set(activeReadStrategyFeedback(records).map(item => item.id));
  if (rule.feedbackIds.some(id => !active.has(id))) return { reason: "evidence_changed" };

  const observations = readStrategyObservations(records, input.scope).filter(item => readStrategyEnvironment(item.conditions) === environment);
  const cited = observations.filter(item => item.feedback !== undefined && rule.feedbackIds.includes(item.feedback.id));
  const rebuilt = induceReadStrategyRule(cited);
  if (rebuilt === undefined || rebuilt.path !== rule.path || rebuilt.feedbackIds.length !== rule.feedbackIds.length
    || rebuilt.evidenceIds.length !== rule.evidenceIds.length || rebuilt.evidenceIds.some(id => !rule.evidenceIds.includes(id))
    || rebuilt.statistics.whole.samples !== rule.statistics.whole.samples || rebuilt.statistics.stream.samples !== rule.statistics.stream.samples
    || rebuilt.statistics.whole.meanCost !== rule.statistics.whole.meanCost || rebuilt.statistics.stream.meanCost !== rule.statistics.stream.meanCost) {
    return { reason: "evidence_changed" };
  }

  const firstSupport = Math.min(...cited.filter(item => item.path === rule.path).map(item => item.feedback!.observedAt));
  const failed = observations.some(item => item.path === rule.path && item.quality === "failed" && item.feedback!.observedAt >= firstSupport);
  if (failed) return { reason: "path_failed" };

  return { path: rule.path, reason: "learned_policy" };
}
