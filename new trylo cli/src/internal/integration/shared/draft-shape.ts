/**
 * 运行期形状守卫（外审 P1-11）。
 *
 * 集成入口声明「接收 JSON / 旧版本的不可信输入」，因此入口真正接受 `unknown`，
 * 并在这里用类型谓词把不可信输入一次性收窄为 canonical draft 形状——
 * 没有 `as` 断言，没有 `any`；谓词覆盖对应 mapper 消费的全部字段，
 * 语义规则（如 permissionClaim 必须 === false）仍由 mapper 自己裁决。
 *
 * 枚举值一律复用域侧导出的常量（第二轮质量审计 F3）：在这里重抄一份字面量，
 * 域侧新增成员时守卫会静默漂移。
 */

import type { EvaluationEvidenceDraft } from "../../evaluation/types.js";
import type { ExternalVerdict } from "../../learning/domains/shared/types.js";
import {
  ASSET_KINDS,
  EXTERNAL_VERDICT_KINDS,
  VERDICT_RESULTS,
} from "../../learning/domains/shared/types.js";
import type { PromptPatchDraft } from "../../learning/agent/subsystems/method/legacy-prompt/builder.js";
import type { SkillDraft } from "../../learning/domains/skill/inducer.js";
import type { UserRuleDraft, WithdrawCommandDraft } from "../../learning/domains/user/builder.js";
import type { WorkflowDraft } from "../../learning/domains/workflow/inducer.js";
import { isNonEmptyString, isOneOf, isPlainRecord, isStringArray } from "./validate.js";

function isScopeShape(value: unknown): boolean {
  return isPlainRecord(value) && typeof value.kind === "string" && isNonEmptyString(value.id);
}

function isProvenanceShape(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    (value.source === "user_explicit" || value.source === "inferred_from_observations") &&
    isStringArray(value.observationRefs)
  );
}

export function isUserRuleDraftShape(value: unknown): value is UserRuleDraft {
  return (
    isPlainRecord(value) &&
    value.kind === "user_rule" &&
    typeof value.status === "string" &&
    isNonEmptyString(value.id) &&
    isScopeShape(value.scope) &&
    value.permissionClaim === false &&
    value.capabilityGranted === "never" &&
    typeof value.permissionLanguageDetected === "boolean" &&
    isProvenanceShape(value.provenance)
  );
}

export function isPromptPatchDraftShape(value: unknown): value is PromptPatchDraft {
  return (
    isPlainRecord(value) &&
    value.kind === "prompt_patch" &&
    typeof value.status === "string" &&
    isNonEmptyString(value.id) &&
    typeof value.activationEligible === "boolean" &&
    typeof value.targetMetric === "string" &&
    isStringArray(value.causalObservationRefs) &&
    isScopeShape(value.scope) &&
    isProvenanceShape(value.provenance)
  );
}

export function isSkillDraftShape(value: unknown): value is SkillDraft {
  return (
    isPlainRecord(value) &&
    value.kind === "skill" &&
    typeof value.status === "string" &&
    isNonEmptyString(value.id) &&
    typeof value.version === "number" &&
    Number.isInteger(value.version) &&
    isNonEmptyString(value.identity) &&
    isScopeShape(value.scope) &&
    value.permissionClaim === false &&
    isProvenanceShape(value.provenance)
  );
}

export function isWorkflowDraftShape(value: unknown): value is WorkflowDraft {
  return (
    isPlainRecord(value) &&
    value.kind === "workflow" &&
    typeof value.status === "string" &&
    isNonEmptyString(value.id) &&
    typeof value.version === "number" &&
    Number.isInteger(value.version) &&
    isNonEmptyString(value.identity) &&
    value.permissionClaim === false &&
    value.teamTopologyChanged === false &&
    isProvenanceShape(value.provenance)
  );
}

export function isWithdrawDraftShape(value: unknown): value is WithdrawCommandDraft {
  if (!isPlainRecord(value) || value.kind !== "withdraw" || typeof value.status !== "string") {
    return false;
  }

  const command = value.command;

  return (
    isNonEmptyString(value.id) &&
    isPlainRecord(command) &&
    typeof command.commandId === "string" &&
    command.kind === "submit_withdraw" &&
    (ASSET_KINDS as readonly string[]).includes(String(command.assetKind)) &&
    isNonEmptyString(command.payloadId)
  );
}

function isExternalAnchorShape(value: unknown): value is ExternalVerdict {
  return (
    isPlainRecord(value) &&
    isOneOf(EXTERNAL_VERDICT_KINDS, value.kind) &&
    isOneOf(VERDICT_RESULTS, value.result) &&
    isNonEmptyString(value.ref) &&
    typeof value.selfGenerated === "boolean"
  );
}

export function isEvaluationEvidenceDraftShape(value: unknown): value is EvaluationEvidenceDraft {
  return (
    isPlainRecord(value) &&
    isNonEmptyString(value.proposalId) &&
    isNonEmptyString(value.baselineRef) &&
    isNonEmptyString(value.candidateRef) &&
    isPlainRecord(value.replay) &&
    typeof value.replay.compared === "boolean" &&
    Array.isArray(value.externalAnchors) &&
    value.externalAnchors.every(isExternalAnchorShape) &&
    Array.isArray(value.weakSignals) &&
    isStringArray(value.notes) &&
    (value.verdict === "recommend_shadow" ||
      value.verdict === "reject" ||
      value.verdict === "insufficient_sample" ||
      value.verdict === "no_external_pass" ||
      value.verdict === "critical_regression") &&
    typeof value.externalPass === "boolean" &&
    isNonEmptyString(value.generatorRoleId) &&
    isNonEmptyString(value.evaluatorRoleId) &&
    value.commandKind === "submit_evidence"
  );
}
