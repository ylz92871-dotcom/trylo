import { newId, sourceHash } from './ids';
import type {
  OutcomeObservation,
  PolicyDecision,
  UserDecisionEvent,
  UserDecisionTrace,
  UserLearningSnapshot,
} from './types';

export interface OutcomeEvaluation {
  readonly observations: readonly OutcomeObservation[];
  readonly pauseCommitmentIds: readonly string[];
  readonly expireTrialIds: readonly string[];
}

const HELPFUL = /(?:这样|这么)(?:更好|很好|就对了)|以后(?:就)?这样|符合预期|正是我要的|保持这样/i;
const UNHELPFUL = /不对|不是这样|恢复(?:以前|原来)|别再这样|这样不好|没帮助|反而更麻烦|撤销这个偏好/i;

function correctionKey(event: UserDecisionEvent): string | undefined {
  if (!event.text?.trim()) return undefined;
  const normalized = event.text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').slice(0, 180);
  return normalized ? sourceHash([normalized]) : undefined;
}

function signalFor(
  event: UserDecisionEvent,
  priorCorrectionKeys: ReadonlySet<string>,
): Pick<OutcomeObservation, 'signal' | 'attribution' | 'correctionKey'> | null {
  const text = event.text ?? '';
  const key = correctionKey(event);
  if (event.type === 'rollback') return { signal: 'rollback', attribution: 'direct', correctionKey: key };
  if (HELPFUL.test(text)) return { signal: 'explicit_helpful', attribution: 'direct', correctionKey: key };
  if (UNHELPFUL.test(text)) return { signal: 'explicit_unhelpful', attribution: 'direct', correctionKey: key };
  if (event.type === 'manual_edit') return { signal: 'material_rework', attribution: 'partial', correctionKey: key };
  if (event.type === 'correction' || event.type === 'authoritative_correction' || event.type === 'override') {
    return key && priorCorrectionKeys.has(key)
      ? { signal: 'repeated_correction', attribution: 'direct', correctionKey: key }
      : { signal: 'material_rework', attribution: 'partial', correctionKey: key };
  }
  return null;
}

/**
 * Maps post-send trace events onto commitments that were actually injected.
 * It never reads assistant prose and never creates supporting Evidence.
 */
export function evaluateTraceOutcome(input: {
  readonly snapshot: UserLearningSnapshot;
  readonly trace: UserDecisionTrace;
  readonly decision?: PolicyDecision;
  readonly now: number;
}): OutcomeEvaluation {
  const appliedIds = input.decision?.appliedCommitmentIds ?? [];
  const opportunityByCommitment = new Map(appliedIds.map((id, index) => [
    id,
    input.decision?.opportunityKeys[index] ?? `unknown::${input.trace.product}::${input.trace.projectId}`,
  ]));
  const observations: OutcomeObservation[] = [];

  for (const commitmentId of appliedIds) {
    const priorKeys = new Set(input.snapshot.outcomeObservations
      .filter((item) => item.commitmentId === commitmentId && item.correctionKey)
      .map((item) => item.correctionKey!));
    for (const event of input.trace.userEvents) {
      // The opening user_message is task intent, not outcome feedback about
      // the policy being applied to that same task.
      if (event.type === 'user_message' || event.actor !== 'user') continue;
      const mapped = signalFor(event, priorKeys);
      if (!mapped) continue;
      observations.push({
        id: newId('outcome', input.now),
        commitmentId,
        policyDecisionId: input.decision!.id,
        traceId: input.trace.id,
        eventId: event.id,
        opportunityKey: opportunityByCommitment.get(commitmentId)!,
        ...mapped,
        createdAt: input.now,
      });
      if (mapped.correctionKey) priorKeys.add(mapped.correctionKey);
    }
    if (input.trace.outcome === 'completed') {
      observations.push({
        id: newId('outcome', input.now),
        commitmentId,
        policyDecisionId: input.decision!.id,
        traceId: input.trace.id,
        opportunityKey: opportunityByCommitment.get(commitmentId)!,
        signal: 'task_completed',
        attribution: 'unknown',
        createdAt: input.now,
      });
    }
  }

  const pauseCommitmentIds = appliedIds.filter((commitmentId) => {
    const relevant = observations.filter((item) => item.commitmentId === commitmentId);
    if (relevant.some((item) => item.signal === 'explicit_unhelpful' || item.signal === 'rollback')) return true;
    const priorRepeats = input.snapshot.outcomeObservations.filter((item) => (
      item.commitmentId === commitmentId && item.signal === 'repeated_correction'
    )).length;
    return priorRepeats + relevant.filter((item) => item.signal === 'repeated_correction').length >= 2;
  });
  const expireTrialIds = input.snapshot.behaviorCommitments
    .filter((item) => (
      item.state === 'trial'
      && item.expiresAt !== undefined
      && item.expiresAt <= input.now
      && (!item.scope.product || item.scope.product === input.trace.product)
      && (!item.scope.projectId || item.scope.projectId === input.trace.projectId)
    ))
    .map((item) => item.id);
  return { observations, pauseCommitmentIds, expireTrialIds };
}
