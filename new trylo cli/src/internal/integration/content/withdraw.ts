import type { TombstoneCommand } from "../../learning/control/commands.js";
import type { WithdrawCommandDraft } from "../../learning/domains/user/builder.js";
import type { WithdrawAdmission } from "../contract/admission.js";
import { WITHDRAW_TARGET_RESOLUTIONS } from "../contract/admission.js";
import type { MappingFailure, MappingResult } from "../contract/rejection.js";
import { mapped, rejected } from "../contract/rejection.js";
import { isIso8601, isNonEmptyString, isOneOf } from "../shared/validate.js";

const ENTITY_TYPES = ["proposal", "asset", "observation", "fragment"] as const;

/**
 * 撤回 draft / admission 的形状与同源校验（§10 单函数长度纪律：
 * `mapWithdrawDraft` 曾因此超 60 行）。顺序即失败码优先级，不要重排。
 */
function checkWithdrawAdmission(
  draft: WithdrawCommandDraft,
  admission: WithdrawAdmission,
): MappingFailure | undefined {
  if (draft.command.kind !== "submit_withdraw") {
    return rejected("kind_mismatch", `expected submit_withdraw got ${draft.command.kind}`);
  }

  if (draft.status !== "draft") {
    return rejected("not_a_draft", `status=${draft.status}`);
  }

  if (!isNonEmptyString(admission.commandId)) {
    return rejected("missing_admission", "commandId is required");
  }

  if (!isIso8601(admission.issuedAt)) {
    return rejected("invalid_admission", "issuedAt must be a parseable ISO-8601 timestamp");
  }

  if (!isNonEmptyString(admission.entityId)) {
    return rejected("missing_admission", "entityId is required; targetHintHash cannot be reversed");
  }

  // WP-F / 外审 R2 §3.3（原文 P1-R3）：模糊自然语言撤回若没有权威 resolver 的
  // 证明，不得映射到任意 entityId。调用方必须声明目标解析依据（用户明指的实体，
  // 或执行当时绑定的实体）；未声明即「不可解析」，在映射层就不产生 tombstone。
  // 映射层无法验证该声明为真，所以这只是第一道门——真正的存在性/终止性门在
  // Board `applyTombstone`。
  if (!isOneOf(WITHDRAW_TARGET_RESOLUTIONS, admission.targetResolution)) {
    return rejected(
      "unresolvable_withdraw_target",
      `targetResolution must be one of ${WITHDRAW_TARGET_RESOLUTIONS.join("|")}`,
    );
  }

  if (!isOneOf(ENTITY_TYPES, admission.entityType)) {
    return rejected("invalid_admission", `entityType must be one of ${ENTITY_TYPES.join("|")}`);
  }

  if (!isNonEmptyString(admission.reason)) {
    return rejected("missing_admission", "withdraw reason must be explicit");
  }

  if (admission.payloadId !== draft.command.payloadId) {
    return rejected(
      "invalid_admission",
      "the withdraw admission does not match the draft payload; the target must resolve from this draft",
    );
  }

  if (admission.assetKind !== draft.command.assetKind) {
    return rejected("invalid_admission", "the withdraw admission assetKind does not match the draft");
  }

  return undefined;
}

/**
 * 撤回 → `tombstone`。
 *
 * Board canonical 里没有 `withdraw` 命令；删除/撤回在 canonical 中表达为 tombstone，
 * 由 Board 唯一写入。draft 只带 `targetHintHash`，哈希不可逆，因此实体 id 与类型
 * 必须由 admission envelope 显式给出——禁止用哈希去"猜"实体。
 *
 * 外审 P1-1：admission 必须绑定到它所撤回的那条 draft——`payloadId` 与
 * `assetKind` 是 draft.command 的回显，不一致即拒绝。这样一条撤回 draft
 * 无法被用来 tombstone 无关实体（实体解析仍由调用方做，但必须与 draft 同源）。
 */
export function mapWithdrawDraft(
  draft: WithdrawCommandDraft,
  admission: WithdrawAdmission,
): MappingResult<readonly TombstoneCommand[]> {
  const invalid = checkWithdrawAdmission(draft, admission);
  if (invalid !== undefined) {
    return invalid;
  }

  return mapped([
    {
      type: "tombstone",
      commandId: admission.commandId,
      issuedAt: admission.issuedAt,
      entityId: admission.entityId,
      entityType: admission.entityType,
      reason: admission.reason,
    },
  ]);
}
