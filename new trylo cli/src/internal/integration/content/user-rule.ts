import type { SubmitProposalCommand } from "../../learning/control/commands.js";
import type { UserRuleDraft } from "../../learning/domains/user/builder.js";
import type { ContentProposalAdmission } from "../contract/admission.js";
import type { MappingResult } from "../contract/rejection.js";
import { rejected } from "../contract/rejection.js";
import { isNonEmptyString } from "../shared/validate.js";
import { buildContentProposal, checkDraftStatus, checkNoAdmittedScope } from "./proposal.js";
import { projectionScope, proposalSourceFor } from "./scope.js";

/**
 * `UserRuleDraft` → `submit_proposal`。
 *
 * 用户明确纠正也只是提案：是否走快速通道、何时 next-boundary 生效由 Board 决定。
 */
export function mapUserRuleDraft(
  draft: UserRuleDraft,
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

  if (draft.permissionClaim !== false || draft.capabilityGranted !== "never") {
    return rejected(
      "authority_claim_present",
      "a user rule draft must never carry a permission claim",
    );
  }

  if (draft.permissionLanguageDetected) {
    return rejected(
      "permission_language_present",
      "the source text mentions permissions; it must not be admitted without explicit review",
    );
  }

  if (!isNonEmptyString(draft.scope.id)) {
    return rejected("missing_scope", "user rule draft has no scope id");
  }

  return buildContentProposal(
    {
      proposalId: draft.id,
      assetKind: "user_rule",
      scope: projectionScope(draft.scope),
      candidateRef: `user_rule:${draft.id}`,
      source: proposalSourceFor(draft.provenance.source),
      observationRefs: draft.provenance.observationRefs,
    },
    admission,
    { requireBaseVersion: false },
  );
}
