import { sourceHash } from './ids';
import type {
  EvidenceDurability,
  EvidenceEventType,
  EvidenceRecord,
  EvidenceScope,
  GovernanceLevel,
  UserDecisionEvent,
  UserDecisionTrace,
  UserSignalKind,
} from './types';

export interface EvidenceCandidate {
  readonly candidateId: string;
  readonly traceId: string;
  readonly proposedClaim: string;
  readonly proposedEventId: string;
  readonly proposedRawSpan?: { readonly start: number; readonly end: number };
  readonly proposedScope?: Partial<EvidenceScope>;
  readonly extractor: 'deterministic' | 'llm';
  readonly extractorVersion: string;
  readonly proposedEventType?: EvidenceEventType;
  readonly proposedGovernance?: GovernanceLevel;
  readonly proposedRaw?: string;
  readonly semanticConfidence?: number;
  readonly engineeringRelevance?: number;
}

export interface EvidenceGroundingDecision {
  readonly accepted: boolean;
  readonly reasonCode:
    | 'grounded_user_event'
    | 'actor_not_user'
    | 'source_event_missing'
    | 'raw_span_mismatch'
    | 'unsupported_scope'
    | 'duplicate_source'
    | 'product_irrelevant'
    | 'sensitive_data'
    | 'invalid_governance';
  readonly evidence?: EvidenceRecord;
}

function userEvent(trace: UserDecisionTrace, eventId: string): UserDecisionEvent | undefined {
  return trace.userEvents.find((event) => event.id === eventId);
}

function spanMatches(text: string, span?: { start: number; end: number }, raw?: string): boolean {
  if (!span) {
    return !raw || text.includes(raw) || raw.includes(text.slice(0, Math.min(text.length, raw.length)));
  }
  if (span.start < 0 || span.end > text.length || span.end < span.start) return false;
  const sliced = text.slice(span.start, span.end);
  return !raw || sliced === raw || text.includes(raw);
}

export function groundEvidenceCandidate(
  candidate: EvidenceCandidate,
  trace: UserDecisionTrace,
  scope: EvidenceScope,
  now: number,
  seen: Set<string>,
): EvidenceGroundingDecision {
  const event = userEvent(trace, candidate.proposedEventId);
  if (!event) return { accepted: false, reasonCode: 'source_event_missing' };
  if (event.actor !== 'user') return { accepted: false, reasonCode: 'actor_not_user' };
  const observation = (event.text ?? '').trim();
  if (!observation) return { accepted: false, reasonCode: 'raw_span_mismatch' };
  const proposedRaw = (candidate.proposedRaw ?? '').trim();
  const execution = (trace.executionResult ?? '').trim();
  if (proposedRaw && execution && proposedRaw === execution) {
    return { accepted: false, reasonCode: 'actor_not_user' };
  }
  if (proposedRaw && !spanMatches(observation, candidate.proposedRawSpan, proposedRaw) && proposedRaw !== observation) {
    return { accepted: false, reasonCode: 'raw_span_mismatch' };
  }
  const spanKey = candidate.proposedRawSpan
    ? `${candidate.proposedRawSpan.start}:${candidate.proposedRawSpan.end}`
    : 'full';
  const dedupe = sourceHash([trace.id, event.id, spanKey, observation]);
  if (seen.has(dedupe)) return { accepted: false, reasonCode: 'duplicate_source' };
  seen.add(dedupe);
  const eventType: EvidenceEventType = event.type === 'user_message'
    ? 'explicit_statement'
    : event.type === 'steer' || event.type === 'stop'
      ? 'intervention'
      : (event.type as EvidenceEventType);
  const governance: GovernanceLevel = eventType === 'authoritative_correction' ? 4 : 2;
  const evidence: EvidenceRecord = {
    id: candidate.candidateId,
    userId: trace.userId,
    source: {
      sessionId: trace.sessionId,
      taskId: trace.taskId,
      turnIds: [trace.turnId],
      actionIds: [event.id],
      sourceHash: dedupe,
      traceId: trace.id,
    },
    origin: {
      channel: trace.product === 'work' ? 'work' : 'interaction',
      eventType,
      stage: event.stage,
    },
    rawObservation: { text: observation },
    inference: {
      claim: candidate.proposedClaim,
      semanticConfidence: Math.min(1, Math.max(0, candidate.semanticConfidence ?? 0.7)),
      engineeringRelevance: Math.min(1, Math.max(0, candidate.engineeringRelevance ?? 0.7)),
    },
    context: {
      ...scope,
      product: scope.product ?? trace.product,
      projectId: scope.projectId,
      workspaceId: scope.workspaceId,
      level: 'project',
    },
    strength: {
      contextInformedness: event.stage,
      band: governance >= 3 ? 'strong' : 'medium',
    },
    governance: { level: governance, userLocked: false },
    createdAt: now,
  };
  return { accepted: true, reasonCode: 'grounded_user_event', evidence };
}

export function groundEvidenceCandidates(
  candidates: readonly EvidenceCandidate[],
  trace: UserDecisionTrace,
  scope: EvidenceScope,
  now: number,
): readonly EvidenceRecord[] {
  const seen = new Set<string>();
  const out: EvidenceRecord[] = [];
  for (const candidate of candidates) {
    const decision = groundEvidenceCandidate(candidate, trace, scope, now, seen);
    if (decision.accepted && decision.evidence) out.push(decision.evidence);
  }
  return out;
}

export function classifyUserSignal(text: string, eventType: EvidenceEventType): {
  readonly durability: EvidenceDurability;
  readonly signalKind: UserSignalKind;
} {
  if (eventType === 'authoritative_correction') {
    return { durability: 'authoritative_long_term', signalKind: 'correction' };
  }
  if (eventType === 'cognition_answer' || eventType === 'cognition_confirmation') {
    return { durability: 'long_term_candidate', signalKind: 'cognition_answer' };
  }
  if (eventType === 'stop' as EvidenceEventType || eventType === 'intervention' || eventType === 'rollback') {
    return { durability: 'task_local', signalKind: 'task_override' };
  }
  const taskLocal = /这次|当前任务|这个任务|先把这|先修这/.test(text);
  const collaboration = /不要反复|少审核|减少审核|重复审核|同目的|别写那么长|不要长篇|别搞复杂|普通\s*UI|核心\s*(路径|runtime)|直接干|先 plan|先规划|只要结论|先说结论|背景优先|依据展开|PPT|报告|汇报|周报|自己点|浏览器|太花|重做|先看结构|先出一版|完整草稿/.test(text);
  if (collaboration) {
    return { durability: 'long_term_candidate', signalKind: 'collaboration_preference' };
  }
  if (taskLocal) {
    return { durability: 'task_local', signalKind: 'task_requirement' };
  }
  return { durability: 'session_local', signalKind: 'task_requirement' };
}

export function eligibleForLongTerm(items: readonly EvidenceRecord[]): boolean {
  if (items.length === 0) return false;
  const taskLocal = items.filter((item) => (
    item.durability === 'task_local'
    || item.signalKind === 'task_requirement'
    || item.signalKind === 'task_override'
  ));
  if (taskLocal.length === items.length) return false;
  const rest = items.filter((item) => !taskLocal.includes(item));
  if (rest.some((item) => item.durability === 'authoritative_long_term' || item.governance.level >= 4)) {
    return true;
  }
  if (rest.some((item) => item.origin.channel === 'cognition' || item.signalKind === 'cognition_answer' || item.signalKind === 'collaboration_preference')) {
    return true;
  }
  if (rest.some((item) => item.durability === 'long_term_candidate')) return true;
  if (rest.length >= 2) return true;
  return rest.some((item) => !item.durability && !item.signalKind);
}
