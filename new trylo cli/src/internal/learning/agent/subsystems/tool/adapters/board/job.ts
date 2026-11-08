import type { EnqueueJobCommand } from "../../../../../control/commands.js";
import type { ToolGapDraft } from "../../../../../../tooling/contract/types.js";
import type { ToolJobAdmission } from "../../../../../../integration/contract/admission.js";
import type { MappingResult } from "../../../../../../integration/contract/rejection.js";
import { mapped, rejected } from "../../../../../../integration/contract/rejection.js";
import {
  isIso8601,
  isNonEmptyString,
  isPositiveInteger,
} from "../../../../../../integration/shared/validate.js";

/**
 * `ToolGapDraft` → `enqueue_job`。
 *
 * gap 不是资产提案：它只是“这个能力缺口值得排一个工具域任务”。canonical 的
 * `LearningJob.observationId` 只接受单个观察，而 gap 聚合了多个观察 id，因此
 * 必须由 admission 指定主观察，且该观察必须属于 gap 的观察集合——缺关联即拒绝。
 */
export function mapToolGap(
  draft: ToolGapDraft,
  admission: ToolJobAdmission,
): MappingResult<readonly EnqueueJobCommand[]> {
  if (!isNonEmptyString(admission.commandId)) {
    return rejected("missing_admission", "commandId is required");
  }

  if (!isIso8601(admission.issuedAt)) {
    return rejected("invalid_admission", "issuedAt must be a parseable ISO-8601 timestamp");
  }

  if (!isNonEmptyString(admission.jobId)) {
    return rejected("missing_admission", "jobId is required");
  }

  if (!isNonEmptyString(draft.gapId)) {
    return rejected("invalid_gap", "gapId is required");
  }

  if (draft.repeatCount <= 0) {
    return rejected("invalid_gap", "repeatCount must be positive");
  }

  if (draft.observationIds.length === 0) {
    return rejected("missing_observation_link", "a gap must reference its observations");
  }

  if (!draft.observationIds.includes(admission.observationId)) {
    return rejected(
      "missing_observation_link",
      "the admitted observationId must belong to the gap observation set",
    );
  }

  if (!isNonEmptyString(admission.scope)) {
    return rejected("missing_scope", "gap has no scope; capability and taskFamily are not scopes");
  }

  if (!isPositiveInteger(admission.maxAttempts)) {
    return rejected("invalid_admission", "maxAttempts must be a positive integer");
  }

  return mapped([
    {
      type: "enqueue_job",
      commandId: admission.commandId,
      issuedAt: admission.issuedAt,
      job: {
        jobId: admission.jobId,
        observationId: admission.observationId,
        domain: "tool",
        scope: admission.scope,
        maxAttempts: admission.maxAttempts,
        dedupeKey: `gap:${draft.gapId}`,
      },
    },
  ]);
}
