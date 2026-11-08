import type { RollbackCommand, SuspendCommand } from "../../../../../control/commands.js";
import type { ToolBoardCommandDraft } from "../../../../../../tooling/contract/types.js";
import type {
  ToolRollbackAdmission,
  ToolSuspendAdmission,
} from "../../../../../../integration/contract/admission.js";
import type { MappingFailure, MappingResult } from "../../../../../../integration/contract/rejection.js";
import { mapped, rejected } from "../../../../../../integration/contract/rejection.js";
import { isIso8601, isNonEmptyString } from "../../../../../../integration/shared/validate.js";

type SuspendDraft = Extract<ToolBoardCommandDraft, { kind: "request_suspend" }>;

type RollbackDraft = Extract<ToolBoardCommandDraft, { kind: "request_rollback" }>;

/**
 * D 的 `request_suspend` → `suspend`。
 *
 * `packageVersionId` 不能反推 proposalId，因此 proposalId 由 admission 给出；
 * 同时要求 admission 复核一遍 packageVersionId，避免“命令说的是 A 版本、
 * admission 说的是 B 版本”的错位。D 自己不改状态，只提交请求。
 */
export function mapToolSuspend(
  draft: SuspendDraft,
  admission: ToolSuspendAdmission,
): MappingResult<readonly SuspendCommand[]> {
  const failure = checkVersionRequest(draft.packageVersionId, draft.reason, admission);
  if (failure !== undefined) {
    return failure;
  }

  return mapped([
    {
      type: "suspend",
      commandId: admission.commandId,
      issuedAt: admission.issuedAt,
      proposalId: admission.proposalId,
      breakerReason: draft.reason,
    },
  ]);
}

/**
 * D 的 `request_rollback` → `rollback`。
 *
 * 上一个版本由 Board 持有；adapter 不猜。admission 必须显式声明
 * `requireBoardPreviousVersion: true`，避免静默“回滚到某个不确定的版本”。
 */
export function mapToolRollback(
  draft: RollbackDraft,
  admission: ToolRollbackAdmission,
): MappingResult<readonly RollbackCommand[]> {
  const failure = checkVersionRequest(draft.packageVersionId, draft.reason, admission);
  if (failure !== undefined) {
    return failure;
  }

  if (admission.requireBoardPreviousVersion !== true) {
    return rejected(
      "invalid_admission",
      "rollback must explicitly require the board-owned previous version",
    );
  }

  return mapped([
    {
      type: "rollback",
      commandId: admission.commandId,
      issuedAt: admission.issuedAt,
      proposalId: admission.proposalId,
      reason: draft.reason,
    },
  ]);
}

function checkVersionRequest(
  packageVersionId: string,
  reason: string,
  admission: ToolSuspendAdmission | ToolRollbackAdmission,
): MappingFailure | undefined {
  if (!isNonEmptyString(packageVersionId)) {
    return rejected("missing_version_link", "the request must name the package version");
  }

  if (!isNonEmptyString(reason)) {
    return rejected("missing_reason", "the request must state a reason");
  }

  if (!isNonEmptyString(admission.commandId)) {
    return rejected("missing_admission", "commandId is required");
  }

  if (!isIso8601(admission.issuedAt)) {
    return rejected("invalid_admission", "issuedAt must be a parseable ISO-8601 timestamp");
  }

  if (!isNonEmptyString(admission.proposalId)) {
    return rejected("missing_admission", "proposalId is required; packageVersionId cannot be reversed");
  }

  if (admission.packageVersionId !== packageVersionId) {
    return rejected(
      "missing_version_link",
      "the admitted packageVersionId must match the request",
    );
  }

  return undefined;
}
