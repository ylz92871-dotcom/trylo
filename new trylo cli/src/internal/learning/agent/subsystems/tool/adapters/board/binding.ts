import type { SubmitProposalCommand } from "../../../../../control/commands.js";
import type { ToolBindingDraft } from "../../../../../../tooling/contract/types.js";
import type { ToolBindingAdmission } from "../../../../../../integration/contract/admission.js";
import type { MappingResult } from "../../../../../../integration/contract/rejection.js";
import { rejected } from "../../../../../../integration/contract/rejection.js";
import { isNonEmptyString, isNonEmptyStringArray } from "../../../../../../integration/shared/validate.js";
import { buildSubmitProposal } from "../../../../../../integration/content/proposal.js";

const TOOL_VERIFIER = "tool_validation_pipeline";

/**
 * `ToolBindingDraft` → `submit_proposal`（`tool_binding`）。
 *
 * 绑定只是“这个 scope/任务族选择哪个工具版本”，不是权限：
 * `requestedAuthorities` 恒为空数组，envelope 也不提供该字段。
 * 版本可追溯性由 `candidateRef` 承载；是否真的激活由 Board 决定。
 */
export function mapToolBinding(
  draft: ToolBindingDraft,
  admission: ToolBindingAdmission,
): MappingResult<readonly SubmitProposalCommand[]> {
  if (!isNonEmptyString(draft.packageVersionId)) {
    return rejected("missing_version_link", "binding must reference a package version");
  }

  if (!isNonEmptyString(draft.candidateId)) {
    return rejected("missing_version_link", "binding must reference its candidate");
  }

  if (!isNonEmptyString(draft.taskFamily)) {
    return rejected("missing_task_family", "binding must name the task family it applies to");
  }

  if (!isNonEmptyString(draft.scope)) {
    return rejected("missing_scope", "binding scope is required");
  }

  if (!isNonEmptyStringArray(admission.observationRefs)) {
    return rejected(
      "missing_observation_link",
      "a binding proposal must trace back to at least one observation",
    );
  }

  return buildSubmitProposal(
    {
      proposalId: `tool_binding:${draft.draftId}`,
      assetKind: "tool_binding",
      scope: draft.scope,
      candidateRef: `tool_binding:${draft.packageVersionId}`,
      source: "inferred",
      observationRefs: admission.observationRefs,
    },
    {
      commandId: admission.commandId,
      issuedAt: admission.issuedAt,
      risk: admission.risk,
      hypothesis: admission.hypothesis,
      requiredVerifiers: [TOOL_VERIFIER],
    },
    { requireBaseVersion: false, requestedAuthorities: [] },
  );
}
