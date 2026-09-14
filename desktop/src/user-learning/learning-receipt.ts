import { newId } from './ids';
import type { BehaviorCommitment, EvidenceRecord, LearningReceipt } from './types';

export type LearningReceiptReason = LearningReceipt['reason'];

function messageFor(commitment: BehaviorCommitment): string {
  const behavior = commitment.behaviorDelta.adaptedBehavior;
  return commitment.state === 'active'
    ? `以后将这样做：${behavior}`
    : `已记录，尚未用于执行：${behavior}`;
}

function scopeLabel(commitment: BehaviorCommitment): string {
  const product = commitment.scope.product === 'work' ? 'Work' : 'Code';
  return commitment.scope.projectId ? `${product} · 当前项目` : `${product} · 通用范围`;
}

export function createLearningReceipt(input: {
  readonly commitment: BehaviorCommitment;
  readonly evidence: readonly EvidenceRecord[];
  readonly existing: readonly LearningReceipt[];
  readonly reason: LearningReceiptReason;
  readonly product?: LearningReceipt['product'];
  readonly conversationId?: string;
  readonly now: number;
}): LearningReceipt | null {
  const dedupeKey = `${input.commitment.id}::${input.commitment.version}::${input.reason}`;
  if (input.existing.some((item) => item.dedupeKey === dedupeKey)) return null;
  const sources = input.evidence.filter((item) => input.commitment.provenanceEvidenceIds.includes(item.id));
  const first = sources[0];
  const product = input.product ?? input.commitment.scope.product;
  if (!product) return null;
  return {
    id: newId('receipt', input.now),
    commitmentId: input.commitment.id,
    commitmentVersion: input.commitment.version,
    dedupeKey,
    reason: input.reason,
    product,
    conversationId: input.conversationId ?? first?.source.sessionId,
    message: messageFor(input.commitment),
    sourceSummary: first?.rawObservation.text.slice(0, 160) || '来自已确认的协作偏好',
    scopeLabel: scopeLabel(input.commitment),
    effectiveFrom: input.now,
    state: 'pending',
    actions: ['this_time_only', 'change_scope', 'pause', 'retract'],
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function appendReceiptsForNewCommitments(input: {
  readonly before: readonly BehaviorCommitment[];
  readonly after: readonly BehaviorCommitment[];
  readonly evidence: readonly EvidenceRecord[];
  readonly existing: readonly LearningReceipt[];
  readonly now: number;
}): readonly LearningReceipt[] {
  let receipts = [...input.existing];
  const beforeIds = new Set(input.before.map((item) => item.id));
  for (const commitment of input.after) {
    if (beforeIds.has(commitment.id) || commitment.state === 'superseded') continue;
    const receipt = createLearningReceipt({
      commitment,
      evidence: input.evidence,
      existing: receipts,
      reason: commitment.state === 'trial'
        ? 'trial_started'
        : commitment.version > 1
          ? 'behavior_changed'
          : 'created',
      now: input.now,
    });
    if (receipt) receipts.push(receipt);
  }
  return receipts;
}
