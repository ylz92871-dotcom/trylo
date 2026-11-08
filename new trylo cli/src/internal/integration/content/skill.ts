import type { SubmitProposalCommand } from "../../learning/control/commands.js";
import type { SkillDraft } from "../../learning/domains/skill/inducer.js";
import type { ContentProposalAdmission } from "../contract/admission.js";
import type { MappingResult } from "../contract/rejection.js";
import { rejected } from "../contract/rejection.js";
import { isNonEmptyString } from "../shared/validate.js";
import { buildContentProposal, checkDraftStatus, checkNoAdmittedScope } from "./proposal.js";
import { projectionScope, proposalSourceFor } from "./scope.js";

/** `SkillDraft` → `submit_proposal`。新版本（version > 1）必须声明父版本资产 id。 */
export function mapSkillDraft(
  draft: SkillDraft,
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

  if (draft.permissionClaim !== false) {
    return rejected("authority_claim_present", "a skill draft must never claim permission");
  }

  if (!isNonEmptyString(draft.scope.id)) {
    return rejected("missing_scope", "skill draft has no scope id");
  }

  return buildContentProposal(
    {
      proposalId: draft.id,
      assetKind: "skill",
      scope: projectionScope(draft.scope),
      candidateRef: `skill:${draft.identity}:${String(draft.version)}`,
      source: proposalSourceFor(draft.provenance.source),
      observationRefs: draft.provenance.observationRefs,
    },
    admission,
    { requireBaseVersion: draft.version > 1 },
  );
}
