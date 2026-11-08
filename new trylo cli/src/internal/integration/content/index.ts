import type { BoardCommand } from "../../learning/control/commands.js";
import type { ContentAdmission } from "../contract/admission.js";
import type { MappingResult } from "../contract/rejection.js";
import { rejected } from "../contract/rejection.js";
import { isPlainRecord } from "../shared/validate.js";
import {
  isPromptPatchDraftShape,
  isSkillDraftShape,
  isUserRuleDraftShape,
  isWithdrawDraftShape,
  isWorkflowDraftShape,
} from "../shared/draft-shape.js";
import { mapPromptPatchDraft } from "../../learning/agent/subsystems/method/adapters/content/prompt-patch.js";
import { mapSkillDraft } from "./skill.js";
import { mapUserRuleDraft } from "./user-rule.js";
import { mapWithdrawDraft } from "./withdraw.js";
import { mapWorkflowDraft } from "./workflow.js";

/**
 * C 包 draft → Board command 的唯一入口。
 *
 * 运行期输入可能来自 JSON 或旧版本（外审 P1-11）：入口真正接受 `unknown`，
 * 先用形状守卫一次性收窄，再交给各域 mapper 做语义裁决；
 * 未知 kind / 非对象输入一律 fail closed，不做任何"看起来像"的猜测，绝不抛异常。
 */
export function mapContentDraft(
  draft: unknown,
  admission: ContentAdmission,
): MappingResult<readonly BoardCommand[]> {
  if (!isPlainRecord(draft)) {
    return rejected("unknown_source_kind", "draft is not an object");
  }

  if (draft.kind === "withdraw") {
    if (!isWithdrawDraftShape(draft)) {
      return rejected("unknown_source_kind", "withdraw draft is malformed");
    }

    if (!("entityId" in admission)) {
      return rejected("invalid_admission", "withdraw requires a withdraw admission");
    }

    return mapWithdrawDraft(draft, admission);
  }

  if ("entityId" in admission) {
    return rejected("invalid_admission", "proposal drafts require a proposal admission");
  }

  switch (draft.kind) {
    case "user_rule":
      if (!isUserRuleDraftShape(draft)) {
        return rejected("unknown_source_kind", "user_rule draft is malformed");
      }
      return mapUserRuleDraft(draft, admission);
    case "prompt_patch":
      if (!isPromptPatchDraftShape(draft)) {
        return rejected("unknown_source_kind", "prompt_patch draft is malformed");
      }
      return mapPromptPatchDraft(draft, admission);
    case "skill":
      if (!isSkillDraftShape(draft)) {
        return rejected("unknown_source_kind", "skill draft is malformed");
      }
      return mapSkillDraft(draft, admission);
    case "workflow":
      if (!isWorkflowDraftShape(draft)) {
        return rejected("unknown_source_kind", "workflow draft is malformed");
      }
      return mapWorkflowDraft(draft, admission);
    default:
      return rejected("unknown_source_kind", `unknown content draft kind ${String(draft.kind)}`);
  }
}

export { mapPromptPatchDraft } from "../../learning/agent/subsystems/method/adapters/content/prompt-patch.js";
export { mapSkillDraft } from "./skill.js";
export { mapUserRuleDraft } from "./user-rule.js";
export { mapWithdrawDraft } from "./withdraw.js";
export { mapWorkflowDraft } from "./workflow.js";
export { domainForAssetKind, projectionScope, proposalSourceFor } from "./scope.js";
