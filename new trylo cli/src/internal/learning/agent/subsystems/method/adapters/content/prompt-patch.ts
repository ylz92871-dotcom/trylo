import type { SubmitProposalCommand } from "../../../../../control/commands.js";
import type { PromptPatchDraft } from "../../legacy-prompt/builder.js";
import type { ContentProposalAdmission } from "../../../../../../integration/contract/admission.js";
import type { MappingResult } from "../../../../../../integration/contract/rejection.js";
import { rejected } from "../../../../../../integration/contract/rejection.js";
import { isNonEmptyString } from "../../../../../../integration/shared/validate.js";
import { buildContentProposal, checkDraftStatus, checkNoAdmittedScope } from "../../../../../../integration/content/proposal.js";
import { projectionScope, proposalSourceFor } from "../../../../../../integration/content/scope.js";

/**
 * `PromptPatchDraft` → `submit_proposal`。
 *
 * 推断得到的提示词改进只能成为候选：两次成功、externalPass 或 recommend_shadow
 * 都不改变它是 proposal 这一事实，是否 shadow / active 由 Board 决定。
 */
export function mapPromptPatchDraft(
  draft: PromptPatchDraft,
  admission: ContentProposalAdmission,
): MappingResult<readonly SubmitProposalCommand[]> {
  const statusFailure = checkDraftStatus(draft.status);
  if (statusFailure !== undefined) {
    return statusFailure;
  }

  const scopeAdmissionFailure = checkNoAdmittedScope(admission);
  if (scopeAdmissionFailure !== undefined) {
    return scopeAdmissionFailure;
  }

  if (draft.activationEligible !== false) {
    return rejected("not_a_draft", "a prompt patch draft is never activation eligible");
  }

  if (draft.causalObservationRefs.length !== 2) {
    return rejected(
      "insufficient_attribution",
      "prompt attribution requires exactly two causal observation refs",
    );
  }

  if (draft.targetMetric === "external_verdict" && admission.requiredVerifiers.length === 0) {
    return rejected(
      "missing_verifier",
      "targetMetric external_verdict requires at least one independent verifier",
    );
  }

  if (!isNonEmptyString(draft.scope.id)) {
    return rejected("missing_scope", "prompt patch draft has no scope id");
  }

  return buildContentProposal(
    {
      proposalId: draft.id,
      assetKind: "prompt_patch",
      scope: projectionScope(draft.scope),
      candidateRef: `prompt_patch:${draft.id}`,
      source: proposalSourceFor(draft.provenance.source),
      observationRefs: draft.causalObservationRefs,
    },
    admission,
    { requireBaseVersion: false },
  );
}
