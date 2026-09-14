import { classifyUserSignal } from './evidence-grounding';
import { newId, sourceHash } from './ids';
import { withFingerprint } from './scope';
import type {
  ContextStage,
  EvidenceChannel,
  EvidenceEventType,
  EvidenceRecord,
  EvidenceScope,
  GovernanceLevel,
  ProductSurface,
  StrengthBand,
  UserDecisionEvent,
  UserDecisionTrace,
} from './types';
import {
  claimForStructuredWork,
  claimForWorkText,
  isWorkPreferenceText,
  type StructuredWorkEvent,
} from './work-signals';

const PREFERENCE_RE = /不要|别再|不要只|希望你|我更|以后|今后|每次|默认|直接干|先 plan|先规划|少审核|减少审核|重复审核|别搞复杂|生产级|收口|不要问|先说结论|背景优先|依据展开|先看结构|先出一版|完整草稿/i;
const TASK_REQUIREMENT_RE = /这次|当前任务|这个任务/;
const CORRECTION_RE = /你理解错|不是这个意思|我说的是|改成|纠正|你搞错/i;
const DISLIKE_PROCESS_RE = /别写那么长|少说过程|不要长篇|别解释那么多|只要结论|不要过程|别列步骤/i;
const CORE_VERIFY_RE = /核心|runtime|生产|最终验证|smoke|必须检查|全链/i;

export function channelForProduct(product: UserDecisionTrace['product'], cognition: boolean): EvidenceChannel {
  if (cognition) return 'cognition';
  return product === 'work' ? 'work' : 'interaction';
}

export function strengthBand(input: {
  readonly eventType: EvidenceEventType;
  readonly stage: ContextStage;
  readonly governance: GovernanceLevel;
  readonly semantic: number;
  readonly relevance: number;
}): StrengthBand {
  if (input.governance === 4 || input.eventType === 'authoritative_correction') return 'authoritative';
  if (input.governance === 3) return 'strong';
  if (
    (input.stage === 'post_execution' || input.stage === 'post_outcome')
    && input.semantic >= 0.8
    && input.relevance >= 0.7
  ) {
    return 'strong';
  }
  if (input.semantic >= 0.75 && input.relevance >= 0.6) return 'medium';
  return 'weak';
}

export function governanceForEvent(type: EvidenceEventType, cognitionLocked = false): GovernanceLevel {
  if (type === 'authoritative_correction') return 4;
  if (type === 'cognition_confirmation') return 3;
  if (cognitionLocked) return 4;
  if (
    type === 'correction'
    || type === 'explicit_statement'
    || type === 'outcome_feedback'
    || type === 'cognition_answer'
    || type === 'override'
    || type === 'intervention'
  ) {
    return 2;
  }
  return 1;
}

function userSourced(event: UserDecisionEvent): boolean {
  return event.actor === 'user';
}

function eventTypeFrom(event: UserDecisionEvent): EvidenceEventType | null {
  if (event.type === 'user_message') {
    const text = event.text ?? '';
    if (CORRECTION_RE.test(text)) return 'correction';
    if (PREFERENCE_RE.test(text) || DISLIKE_PROCESS_RE.test(text) || isWorkPreferenceText(text)) {
      return 'explicit_statement';
    }
    if (TASK_REQUIREMENT_RE.test(text) && /必须|应该|优先/.test(text)) return 'explicit_statement';
    return null;
  }
  if (event.type === 'steer') return 'intervention';
  if (event.type === 'stop') return 'intervention';
  if (
    event.type === 'agent_decision'
    || event.type === 'execution_result'
  ) {
    return null;
  }
  return event.type;
}

function claimFor(
  type: EvidenceEventType,
  text: string,
  structured?: Readonly<Record<string, unknown>>,
): string | null {
  const trimmed = text.trim();
  const workStructured = claimForStructuredWork(
    (structured ?? {}) as StructuredWorkEvent,
    trimmed,
  );
  if (workStructured) return workStructured;
  if (!trimmed && type !== 'approval' && type !== 'rejection' && type !== 'override' && type !== 'choice') {
    return null;
  }
  if (type === 'approval') {
    return trimmed.length >= 4
      ? `用户批准了当前工程决策：${trimmed.slice(0, 160)}`
      : '用户批准了当前工程决策。';
  }
  if (type === 'rejection') {
    return trimmed.length >= 4
      ? `用户拒绝了当前工程决策：${trimmed.slice(0, 160)}`
      : '用户拒绝了当前工程决策。';
  }
  if (type === 'choice' && trimmed) {
    return `用户在当前任务中做了选择：${trimmed.slice(0, 180)}`;
  }
  if (CORRECTION_RE.test(text)) {
    return `用户明确纠正当前理解：${text.slice(0, 180)}`;
  }
  const workClaim = claimForWorkText(text);
  if (workClaim) return workClaim;
  if (CORE_VERIFY_RE.test(text) && /审核|review|验证|检查/i.test(text)) {
    return '用户在核心路径上仍要求保留高价值验证，而不是取消验证本身。';
  }
  if (/重复审核|少审核|减少审核|同质/i.test(text)) {
    return '用户倾向减少重复、低收益的审核。';
  }
  if (DISLIKE_PROCESS_RE.test(text)) {
    return '用户对低信息密度的过程性叙述接受度较低。';
  }
  if (/直接干|直接做|别先计划|不要先 plan/i.test(text)) {
    return '用户在当前任务语境下倾向直接执行，而不是先写长计划。';
  }
  if (/先规划|先 plan|先讲清|先设计/i.test(text)) {
    return '用户要求先形成方案或边界，再执行。';
  }
  if (/别搞复杂|不要新 subsystem|复用现有/i.test(text)) {
    return '用户在当前非核心功能中倾向避免新增架构层。';
  }
  if (type === 'intervention' || type === 'override' || type === 'rollback') {
    return `用户在执行过程中进行了干预：${text.slice(0, 160)}`;
  }
  if (TASK_REQUIREMENT_RE.test(text) && /必须|应该|优先/.test(text) && !PREFERENCE_RE.test(text) && !isWorkPreferenceText(text)) {
    return `当前任务要求：${text.slice(0, 180)}`;
  }
  if (PREFERENCE_RE.test(text)) {
    return `用户表达了工程协作偏好：${text.slice(0, 180)}`;
  }
  return null;
}

export function extractEvidenceFromTrace(
  trace: UserDecisionTrace,
  scope: EvidenceScope,
  now = Date.now(),
): readonly EvidenceRecord[] {
  const out: EvidenceRecord[] = [];
  for (const event of trace.userEvents) {
    if (!userSourced(event)) continue;
    const eventType = eventTypeFrom(event);
    if (!eventType) continue;
    const text = (event.text ?? '').trim();
    if (!text && eventType !== 'rejection' && eventType !== 'override' && eventType !== 'approval' && eventType !== 'choice') continue;
    const claim = claimFor(eventType, text, event.structured);
    if (!claim) continue;
    const governance = governanceForEvent(eventType);
    const semantic = eventType === 'choice' || eventType === 'approval' ? 0.55 : 0.9;
    const relevance = /吃|电影|音乐|天气/.test(text) ? 0.05 : 0.86;
    if (relevance < 0.2) continue;
    const stage = event.stage;
    const taskStage = stage === 'abstract'
      ? 'explore' as const
      : stage === 'task_context'
        ? 'plan' as const
        : stage === 'post_plan'
          ? 'produce' as const
          : stage === 'post_execution'
            ? 'review' as const
            : 'deliver' as const;
    const signal = classifyUserSignal(text, eventType);
    out.push({
      id: newId('ev', now),
      userId: trace.userId,
      source: {
        sessionId: trace.sessionId,
        taskId: trace.taskId,
        turnIds: [trace.turnId],
        actionIds: [event.id],
        sourceHash: sourceHash([trace.id, event.id, text]),
        traceId: trace.id,
      },
      origin: {
        channel: channelForProduct(trace.product, eventType.startsWith('cognition')),
        eventType,
        stage,
      },
      rawObservation: { text: text || eventType, structured: event.structured },
      inference: {
        claim,
        semanticConfidence: semantic,
        engineeringRelevance: relevance,
      },
      context: withFingerprint({ ...scope, taskStage, product: scope.product ?? trace.product }),
      strength: {
        contextInformedness: stage,
        band: strengthBand({
          eventType,
          stage,
          governance,
          semantic,
          relevance,
        }),
      },
      governance: { level: governance, userLocked: governance === 4 },
      durability: signal.durability,
      signalKind: signal.signalKind,
      createdAt: now,
    });
  }
  return out;
}

export function ingestCognitionEvidence(input: {
  readonly userId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly claim: string;
  readonly scope: EvidenceScope;
  readonly eventType?: Extract<EvidenceEventType, 'cognition_answer' | 'cognition_confirmation' | 'authoritative_correction'>;
  readonly now?: number;
}): EvidenceRecord {
  const now = input.now ?? Date.now();
  const eventType = input.eventType ?? 'cognition_answer';
  const governance = governanceForEvent(eventType);
  return {
    id: newId('ev', now),
    userId: input.userId,
    source: {
      sessionId: input.sessionId,
      taskId: input.sessionId,
      turnIds: [input.sessionId],
      actionIds: [],
      sourceHash: sourceHash(['cognition', input.sessionId, input.text]),
      traceId: input.sessionId,
    },
    origin: { channel: 'cognition', eventType, stage: 'task_context' },
    rawObservation: { text: input.text },
    inference: {
      claim: input.claim,
      semanticConfidence: 0.94,
      engineeringRelevance: 0.9,
    },
    context: input.scope,
    strength: {
      contextInformedness: 'task_context',
      band: strengthBand({
        eventType,
        stage: 'task_context',
        governance,
        semantic: 0.94,
        relevance: 0.9,
      }),
    },
    governance: { level: governance, userLocked: governance === 4 },
    durability: classifyUserSignal(input.text, eventType).durability,
    signalKind: eventType === 'cognition_answer' || eventType === 'cognition_confirmation'
      ? 'cognition_answer'
      : eventType === 'authoritative_correction' ? 'correction' : 'impact_resolution',
    createdAt: now,
  };
}

/** PR-5 (§4.4): Ingest a late Work event (praise/promote/template) that lands
 *  AFTER the trace is closed. The `lastWorkTraceId` is passed in; the event
 *  is written as a NEW Evidence row with its own sourceHash (H2: incremental,
 *  never re-extracts the trace). The trace's scope is reconstructed from the
 *  stored trace record.
 *
 *  Idempotency (§4.4): the sourceHash is derived from the STABLE event
 *  identity (`traceId + eventType + text + dedupKey`) — never from the wall
 *  clock — so a duplicate delivery (double-click, repeated terminal) hashes
 *  identically and the caller can dedupe on it. `dedupKey` is optional; when
 *  absent the other three fields still pin the identity (one promote of the
 *  same wording per trace = one Evidence).
 *
 *  Returns null when the trace is not found (trace was already cleaned up). */
export function ingestLateWorkEvent(input: {
  readonly userId: string;
  readonly traceId: string;
  readonly trace: { readonly sessionId: string; readonly taskId: string; readonly turnId: string; readonly product: ProductSurface; readonly workspaceId: string; readonly projectId: string };
  readonly eventType: EvidenceEventType;
  readonly text: string;
  readonly claim: string;
  readonly structured?: Record<string, unknown>;
  /** Stable caller-supplied identity for dedup (e.g. the UI action id).
   *  Absent ⇒ identity is traceId+eventType+text. */
  readonly dedupKey?: string;
  readonly now?: number;
}): EvidenceRecord | null {
  const now = input.now ?? Date.now();
  const governance = governanceForEvent(input.eventType);
  const semantic = 0.9;
  const relevance = 0.86;
  const stage: ContextStage = 'post_outcome';
  const sourceHashVal = sourceHash([
    'late-work',
    input.traceId,
    input.eventType,
    input.text,
    input.dedupKey ?? '',
  ]);
  return {
    id: newId('ev', now),
    userId: input.userId,
    source: {
      sessionId: input.trace.sessionId,
      taskId: input.trace.taskId,
      turnIds: [input.trace.turnId],
      actionIds: [],
      sourceHash: sourceHashVal,
      traceId: input.traceId,
    },
    origin: { channel: 'work', eventType: input.eventType, stage },
    rawObservation: { text: input.text, structured: input.structured },
    inference: {
      claim: input.claim,
      semanticConfidence: semantic,
      engineeringRelevance: relevance,
    },
    context: {
      workspaceId: input.trace.workspaceId,
      projectId: input.trace.projectId,
      product: input.trace.product,
      scopeTags: [input.trace.product],
      level: 'project',
    },
    strength: {
      contextInformedness: stage,
      band: strengthBand({
        eventType: input.eventType,
        stage,
        governance,
        semantic,
        relevance,
      }),
    },
    governance: { level: governance, userLocked: governance === 4 },
    durability: 'task_local',
    signalKind: 'task_requirement',
    createdAt: now,
  };
}
