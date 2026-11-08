import type { LearningObservation } from "../../../../../control/contracts.js";
import {
  EXTERNAL_VERDICTS,
  PRIVACY_CLASSES,
  TURN_OUTCOMES,
} from "../../../../../control/contracts.js";
import type { ToolObservationAdmission } from "../../../../../../integration/contract/admission.js";
import type { MappingResult } from "../../../../../../integration/contract/rejection.js";
import { mapped, rejected } from "../../../../../../integration/contract/rejection.js";
import { isToolObservationShape } from "./draft-shape.js";
import { isIso8601, isNonEmptyString, isNonEmptyStringArray, isOneOf } from "../../../../../../integration/shared/validate.js";

/**
 * `ToolLearningObservation` → canonical `LearningObservation`。
 *
 * 观察不是 command：Board canonical 里没有“记录观察”的命令，观察由 Board 的
 * 入库路径写入。本 adapter 只产出 canonical 对象本身，不写任何状态。
 *
 * `kind` 是观察类型，不是 turn outcome，因此 outcome 必须由 admission 显式给出；
 * `notes` 是自由文本，不映射为 `reason`（既是避免把自由文本当结构化字段，也是隐私考虑）。
 */
export function mapToolObservation(
  draft: unknown,
  admission: ToolObservationAdmission,
): MappingResult<LearningObservation> {
  if (!isToolObservationShape(draft)) {
    return rejected("invalid_observation", "tool observation draft is malformed");
  }

  if (!isIso8601(draft.recordedAt)) {
    return rejected("invalid_timestamp", "recordedAt must be a parseable ISO-8601 timestamp");
  }

  if (!isNonEmptyString(admission.scope)) {
    return rejected("missing_scope", "tool observations carry no scope; it must be admitted");
  }

  if (!isOneOf(TURN_OUTCOMES, admission.outcome)) {
    return rejected(
      "invalid_admission",
      `outcome must be one of ${TURN_OUTCOMES.join("|")}`,
    );
  }

  if (!isNonEmptyStringArray(admission.causalRefs)) {
    return rejected(
      "missing_causal_refs",
      "learning only consumes observations with causal references",
    );
  }

  if (!isOneOf(PRIVACY_CLASSES, admission.privacyClass)) {
    return rejected(
      "invalid_admission",
      `privacyClass must be one of ${PRIVACY_CLASSES.join("|")}`,
    );
  }

  if (admission.verdict !== undefined && !isOneOf(EXTERNAL_VERDICTS, admission.verdict)) {
    return rejected("invalid_admission", "verdict must be pass, fail or partial");
  }

  if (draft.kind === "success" && admission.outcome === "failed") {
    return rejected("observation_contradiction", "kind success cannot carry a failed outcome");
  }

  if (draft.kind === "tool_failure" && admission.outcome === "completed") {
    return rejected("observation_contradiction", "kind tool_failure cannot carry a completed outcome");
  }

  const observation: LearningObservation = {
    observationId: draft.observationId,
    scope: admission.scope,
    taskFamily: draft.taskFamily,
    assetRefs: draft.toolName === undefined ? {} : { tool: draft.toolName },
    outcome: admission.outcome,
    causalRefs: [...admission.causalRefs],
    privacyClass: admission.privacyClass,
    occurredAt: draft.recordedAt,
    ...(admission.verdict === undefined ? {} : { verdict: admission.verdict }),
  };

  return mapped(observation);
}
