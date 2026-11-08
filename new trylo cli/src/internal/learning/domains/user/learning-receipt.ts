import { shortId } from "../shared/hash.js";
import {
  type BehaviorCommitment,
  type LearningReceipt,
  type ReceiptReason,
  type UserEvidence,
} from "./contracts.js";

export type CreateReceiptInput = {
  readonly commitment: BehaviorCommitment;
  readonly evidence: readonly UserEvidence[];
  readonly existing?: readonly LearningReceipt[];
  readonly reason: ReceiptReason;
  readonly now?: number;
};

/**
 * 学习收据：让人看见范围、变化、撤销。shadow 状态只能说
 * "已记录尚未用于执行"，不许暗示已经生效。同一承诺同版本同原因
 * 只出一张（dedupeKey），调用方传入 existing 做跨批去重。
 */
export function createLearningReceipt(input: CreateReceiptInput): LearningReceipt | null {
  const dedupeKey = [input.commitment.id, String(input.commitment.version), input.reason].join("::");
  if ((input.existing ?? []).some((item) => item.dedupeKey === dedupeKey)) {
    return null;
  }

  const now = input.now ?? Date.now();
  const behavior = input.commitment.behaviorDelta.adaptedBehavior;

  return {
    id: shortId("receipt", [dedupeKey]),
    commitmentId: input.commitment.id,
    commitmentVersion: input.commitment.version,
    dedupeKey,
    reason: input.reason,
    scopeLabel: scopeLabelFor(input.commitment),
    effectSummary: behavior,
    revokeActions: ["this_time_only", "change_scope", "pause", "retract"],
    message:
      input.commitment.state === "active"
        ? `以后将这样做：${behavior}`
        : `已记录，尚未用于执行：${behavior}`,
    createdAt: now,
  };
}

function scopeLabelFor(commitment: BehaviorCommitment): string {
  const product = commitment.conditions.find((condition) => condition.startsWith("product=")) ?? "product=unknown";
  return product === "product=work" ? "Work · 当前范围" : product === "product=code" ? "Code · 当前范围" : "通用范围";
}

export type AppendReceiptsInput = {
  readonly before: readonly BehaviorCommitment[];
  readonly after: readonly BehaviorCommitment[];
  readonly evidence: readonly UserEvidence[];
  readonly existing?: readonly LearningReceipt[];
  readonly now?: number;
};

/** 为新增承诺批量补收据：reason 由状态与版本推导，调用方不许手填。 */
export function appendReceiptsForNewCommitments(input: AppendReceiptsInput): readonly LearningReceipt[] {
  const now = input.now ?? Date.now();
  let receipts = [...(input.existing ?? [])];
  const beforeIds = new Set(input.before.map((item) => item.id));

  for (const commitment of input.after) {
    if (beforeIds.has(commitment.id) || commitment.state === "superseded") {
      continue;
    }

    const receipt = createLearningReceipt({
      commitment,
      evidence: input.evidence,
      existing: receipts,
      reason:
        commitment.state === "trial"
          ? "trial_started"
          : commitment.version > 1
            ? "behavior_changed"
            : "created",
      now,
    });
    if (receipt !== null) {
      receipts = [...receipts, receipt];
    }
  }

  return receipts;
}
