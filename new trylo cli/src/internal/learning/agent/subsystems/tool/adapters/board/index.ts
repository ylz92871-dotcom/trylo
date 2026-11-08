import type { BoardCommand } from "../../../../../control/commands.js";
import type { VerificationAuthorityReader } from "../../../../../verification-authority/contracts.js";
import type { ToolCommandAdmission } from "../../../../../../integration/contract/admission.js";
import { admitToolEvidence } from "../../../../../../integration/contract/gateway.js";
import type { MappingResult } from "../../../../../../integration/contract/rejection.js";
import { rejected } from "../../../../../../integration/contract/rejection.js";
import { isPlainRecord } from "../../../../../../integration/shared/validate.js";
import {
  isRollbackRequestShape,
  isSubmitEvidenceDraftShape,
  isSuspendRequestShape,
  isToolBindingDraftShape,
  isToolCandidateShape,
  isToolGapShape,
} from "./draft-shape.js";
import { mapToolBinding } from "./binding.js";
import { mapToolGap } from "./job.js";
import { mapToolRollback, mapToolSuspend } from "./lifecycle.js";
import { mapToolCandidate } from "./package.js";

/**
 * D 的 `ToolBoardCommandDraft` → Board command 的入口。
 *
 * 运行期输入可能来自 JSON 或旧版本（外审 P1-11）：入口真正接受 `unknown`，
 * 先用形状守卫一次性收窄（candidate/gap/binding 是嵌套载荷，守卫应用于载荷），
 * 再交给各 kind 的 mapper 做语义裁决；未知 kind / 非对象输入一律 fail closed，
 * 绝不抛异常。
 *
 * WP-F 变化：`submit_evidence` 不再有本地的自证路径。它必须经由注入的
 * Verification Authority reader 走可信准入 gateway；没有注入端口时该分支
 * 返回 `verification_authority_unavailable`，**不**降级为相信调用方。
 * 因此入口从同步变为异步——I/O 事实本来就不该伪装成纯函数。
 */
export async function mapToolCommandDraft(
  draft: unknown,
  admission: ToolCommandAdmission,
  authority?: VerificationAuthorityReader,
): Promise<MappingResult<readonly BoardCommand[]>> {
  if (!isPlainRecord(draft)) {
    return rejected("unknown_source_kind", "draft is not an object");
  }
  switch (draft.kind) {
    case "submit_gap":
      return mapGapDraft(draft, admission);
    case "submit_candidate":
      return mapCandidateDraft(draft, admission);
    case "submit_binding_draft":
      return mapBindingDraft(draft, admission);
    case "submit_evidence":
      return mapEvidenceDraft(draft, admission, authority);
    case "request_suspend":
      return mapSuspendDraft(draft, admission);
    case "request_rollback":
      return mapRollbackDraft(draft, admission);
    default:
      return rejected("unknown_source_kind", `unknown tool draft kind ${String(draft.kind)}`);
  }
}

/**
 * 各 kind 的分支处理：先按载荷形状收窄，再确认 admission 类型匹配，最后交给
 * 该 kind 的 mapper。拆开的理由是 §10 单函数长度纪律——`mapToolCommandDraft`
 * 曾因 6 个内联分支超 60 行。顺序即失败码优先级，不要重排。
 */

function mapGapDraft(
  draft: Record<string, unknown>,
  admission: ToolCommandAdmission,
): MappingResult<readonly BoardCommand[]> {
  if (!isToolGapShape(draft.gap)) {
    return rejected("invalid_gap", "submit_gap payload is malformed");
  }

  if (!("jobId" in admission)) {
    return rejected("invalid_admission", "submit_gap requires a job admission");
  }

  return mapToolGap(draft.gap, admission);
}

function mapCandidateDraft(
  draft: Record<string, unknown>,
  admission: ToolCommandAdmission,
): MappingResult<readonly BoardCommand[]> {
  if (!isToolCandidateShape(draft.candidate)) {
    return rejected("invalid_admission", "submit_candidate payload is malformed");
  }

  if (!("requestedAuthorities" in admission)) {
    return rejected("invalid_admission", "submit_candidate requires a package admission");
  }

  return mapToolCandidate(draft.candidate, admission);
}

function mapBindingDraft(
  draft: Record<string, unknown>,
  admission: ToolCommandAdmission,
): MappingResult<readonly BoardCommand[]> {
  if (!isToolBindingDraftShape(draft.draft)) {
    return rejected("invalid_admission", "submit_binding_draft payload is malformed");
  }

  if (!("risk" in admission)) {
    return rejected("invalid_admission", "submit_binding_draft requires a binding admission");
  }

  return mapToolBinding(draft.draft, admission);
}

function mapEvidenceDraft(
  draft: Record<string, unknown>,
  admission: ToolCommandAdmission,
  authority: VerificationAuthorityReader | undefined,
): Promise<MappingResult<readonly BoardCommand[]>> {
  if (!isSubmitEvidenceDraftShape(draft)) {
    return Promise.resolve(rejected("invalid_admission", "submit_evidence draft is malformed"));
  }

  if (!("receiptRef" in admission)) {
    return Promise.resolve(
      rejected(
        "invalid_admission",
        "submit_evidence requires an evidence admission carrying a receipt reference",
      ),
    );
  }

  return admitToolEvidence(authority, draft, admission);
}

function mapSuspendDraft(
  draft: Record<string, unknown>,
  admission: ToolCommandAdmission,
): MappingResult<readonly BoardCommand[]> {
  if (!isSuspendRequestShape(draft)) {
    return rejected("invalid_admission", "request_suspend draft is malformed");
  }

  if ("requireBoardPreviousVersion" in admission || !("packageVersionId" in admission)) {
    return rejected("invalid_admission", "request_suspend requires a suspend admission");
  }

  return mapToolSuspend(draft, admission);
}

function mapRollbackDraft(
  draft: Record<string, unknown>,
  admission: ToolCommandAdmission,
): MappingResult<readonly BoardCommand[]> {
  if (!isRollbackRequestShape(draft)) {
    return rejected("invalid_admission", "request_rollback draft is malformed");
  }

  if (!("requireBoardPreviousVersion" in admission)) {
    return rejected("invalid_admission", "request_rollback requires a rollback admission");
  }

  return mapToolRollback(draft, admission);
}

export { mapToolBinding } from "./binding.js";
export { mapToolGap } from "./job.js";
export { mapToolRollback, mapToolSuspend } from "./lifecycle.js";
export { mapToolCandidate } from "./package.js";
export { mapToolObservation } from "./observation.js";
