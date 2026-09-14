import type { UserLearningSnapshot } from './types';

export interface LearningMetrics {
  readonly comparableOpportunities: number;
  readonly repeatedExplanations: number;
  readonly repeatedExplanationRate: number | null;
  readonly materialReworkRate: number | null;
  readonly overrideRate: number | null;
  readonly unnecessaryAskRate: number | null;
  readonly crossScopeContaminationCount: number;
}

function rate(numerator: number, denominator: number, comparable: number): number | null {
  return comparable < 5 || denominator === 0 ? null : numerator / denominator;
}

/** Local-only aggregation. No raw text leaves the snapshot. */
export function calculateLearningMetrics(snapshot: UserLearningSnapshot): LearningMetrics {
  const outcomes = snapshot.outcomeObservations ?? [];
  const comparable = new Set(outcomes
    .filter((item) => item.signal === 'task_completed')
    .map((item) => `${item.policyDecisionId}::${item.commitmentId}::${item.opportunityKey}`));
  const comparableOpportunities = comparable.size;
  const repeatedExplanations = outcomes.filter((item) => item.signal === 'repeated_correction').length;
  const materialRework = outcomes.filter((item) => item.signal === 'material_rework').length;
  const overrides = outcomes.filter((item) => (
    item.signal === 'explicit_unhelpful' || item.signal === 'rollback'
  )).length;
  const asks = snapshot.cognitionAskLog ?? [];
  const unnecessaryAsks = asks.filter((item) => (
    item.outcome === 'dismissed' || item.outcome === 'ignored' || item.outcome === 'ignored_demoted'
  )).length;
  const crossScopeContaminationCount = outcomes.filter((item) => {
    if (item.signal !== 'explicit_unhelpful' && item.signal !== 'rollback') return false;
    const trace = snapshot.traces.find((candidate) => candidate.id === item.traceId);
    const commitment = snapshot.behaviorCommitments.find((candidate) => candidate.id === item.commitmentId);
    if (!trace || !commitment) return false;
    return Boolean(
      commitment.scope.product && commitment.scope.product !== trace.product
      || commitment.scope.projectId && commitment.scope.projectId !== trace.projectId,
    );
  }).length;
  return {
    comparableOpportunities,
    repeatedExplanations,
    repeatedExplanationRate: rate(repeatedExplanations, comparableOpportunities, comparableOpportunities),
    materialReworkRate: rate(materialRework, comparableOpportunities, comparableOpportunities),
    overrideRate: rate(overrides, comparableOpportunities, comparableOpportunities),
    unnecessaryAskRate: rate(unnecessaryAsks, asks.length, comparableOpportunities),
    crossScopeContaminationCount,
  };
}
