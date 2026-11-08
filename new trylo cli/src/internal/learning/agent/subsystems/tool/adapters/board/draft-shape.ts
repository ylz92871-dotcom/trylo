/**
 * D 侧 draft 的运行期形状守卫（外审 P1-11）：与 content 侧同一纪律——
 * 入口接受 `unknown`，谓词覆盖 mapper 消费的全部字段，无断言、无 any。
 * 校验原语复用 shared/validate（第二轮质量审计 F2：不再留本地副本）。
 */

import type {
  ToolBindingDraft,
  ToolBoardCommandDraft,
  ToolCandidate,
  ToolGapDraft,
  ToolLearningObservation,
} from "../../../../../../tooling/contract/types.js";
import { RISK_LEVELS } from "../../../../../control/contracts.js";
import { isNonEmptyString, isPlainRecord, isStringArray } from "../../../../../../integration/shared/validate.js";

export function isToolGapShape(value: unknown): value is ToolGapDraft {
  return (
    isPlainRecord(value) &&
    isNonEmptyString(value.gapId) &&
    isStringArray(value.observationIds) &&
    typeof value.repeatCount === "number" &&
    Number.isFinite(value.repeatCount)
  );
}

export function isToolCandidateShape(value: unknown): value is ToolCandidate {
  return (
    isPlainRecord(value) &&
    isNonEmptyString(value.candidateId) &&
    isNonEmptyString(value.commitOrVersion) &&
    typeof value.licenseSpdx === "string" &&
    typeof value.officialIdentity === "string" &&
    typeof value.fromOpenTree === "boolean" &&
    isStringArray(value.requiredPermissions) &&
    typeof value.supplyChainRisk === "string" &&
    (RISK_LEVELS as readonly string[]).includes(value.supplyChainRisk)
  );
}

export function isToolBindingDraftShape(value: unknown): value is ToolBindingDraft {
  return (
    isPlainRecord(value) &&
    isNonEmptyString(value.draftId) &&
    isNonEmptyString(value.packageVersionId) &&
    isNonEmptyString(value.candidateId) &&
    isNonEmptyString(value.taskFamily) &&
    isNonEmptyString(value.scope)
  );
}

export function isSubmitEvidenceDraftShape(
  value: unknown,
): value is Extract<ToolBoardCommandDraft, { kind: "submit_evidence" }> {
  return (
    isPlainRecord(value) &&
    value.kind === "submit_evidence" &&
    typeof value.evidenceId === "string" &&
    typeof value.summary === "string"
  );
}

export function isSuspendRequestShape(
  value: unknown,
): value is { kind: "request_suspend"; packageVersionId: string; reason: string } {
  return (
    isPlainRecord(value) &&
    value.kind === "request_suspend" &&
    typeof value.packageVersionId === "string" &&
    typeof value.reason === "string"
  );
}

export function isRollbackRequestShape(
  value: unknown,
): value is { kind: "request_rollback"; packageVersionId: string; reason: string } {
  return (
    isPlainRecord(value) &&
    value.kind === "request_rollback" &&
    typeof value.packageVersionId === "string" &&
    typeof value.reason === "string"
  );
}

/**
 * 成员逐个对照 canonical `ObservationKind` 联合类型（第二轮质量审计 F3）：
 * 域侧删改成员时这里在编译期报错，而不是运行时静默漂移。
 */
const OBSERVATION_KINDS: readonly ToolLearningObservation["kind"][] = [
  "tool_not_found",
  "tool_failure",
  "schema_friction",
  "platform_incompatible",
  "manual_workaround",
  "capability_mismatch",
  "success",
];

export function isToolObservationShape(value: unknown): value is ToolLearningObservation {
  return (
    isPlainRecord(value) &&
    (OBSERVATION_KINDS as readonly string[]).includes(String(value.kind)) &&
    isNonEmptyString(value.observationId) &&
    isNonEmptyString(value.taskFamily) &&
    typeof value.recordedAt === "string" &&
    (value.toolName === undefined || typeof value.toolName === "string")
  );
}
