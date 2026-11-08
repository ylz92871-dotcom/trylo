import type { SubmitProposalCommand } from "../../learning/control/commands.js";
import type { WorkflowDraft } from "../../learning/domains/workflow/inducer.js";
import { validateWorkflowRevision } from "../../learning/domains/workflow/inducer.js";
import { workflowFamilyKey } from "../../learning/domains/workflow/family.js";
import { shortId } from "../../learning/domains/shared/hash.js";
import { submitDraftCommand } from "../../learning/domains/shared/board-command.js";
import { scanForbiddenBody } from "../../learning/domains/shared/forbidden-scan.js";
import type { ContentProposalAdmission } from "../contract/admission.js";
import type { MappingFailure, MappingResult } from "../contract/rejection.js";
import { rejected } from "../contract/rejection.js";
import { isNonEmptyString } from "../shared/validate.js";
import { buildContentProposal, checkDraftStatus } from "./proposal.js";
import { proposalSourceFor } from "./scope.js";

/** `WorkflowDraft` → `submit_proposal`。workflow 不得改变 team 拓扑，因此该字段必须恒 false。 */
export function mapWorkflowDraft(
  draft: WorkflowDraft,
  admission: ContentProposalAdmission,
): MappingResult<readonly SubmitProposalCommand[]> {
  const statusFailure = checkDraftStatus(draft.status);
  if (statusFailure !== undefined) {
    return statusFailure;
  }

  if (draft.permissionClaim !== false) {
    return rejected("authority_claim_present", "a workflow draft must never claim permission");
  }

  if (draft.teamTopologyChanged !== false) {
    return rejected(
      "authority_claim_present",
      "a workflow draft cannot change team topology",
    );
  }

  if (!isNonEmptyString(draft.identity)) {
    return rejected("missing_scope", "workflow draft has no identity");
  }

  if (!isNonEmptyString(admission.scope)) {
    return rejected(
      "missing_scope",
      "workflow drafts carry no scope; it must be admitted explicitly",
    );
  }

  const boundaryFailure = workflowMappingBoundary(draft, admission.scope);
  if (boundaryFailure !== undefined) {
    return boundaryFailure;
  }

  const familyCoordinate = draft.taskFamily === undefined
    ? "" : `:${shortId("family", [workflowFamilyKey(draft.taskFamily)])}`;

  return buildContentProposal(
    {
      proposalId: draft.id,
      assetKind: "workflow",
      scope: admission.scope,
      candidateRef: `workflow:${draft.identity}${familyCoordinate}:${String(draft.version)}`,
      source: proposalSourceFor(draft.provenance.source),
      observationRefs: draft.provenance.observationRefs,
    },
    admission,
    { requireBaseVersion: draft.version > 1 },
  );
}

function workflowMappingBoundary(draft: WorkflowDraft, scope: string): MappingFailure | undefined {
  const invalidRevision = validateWorkflowRevision(draft);
  if (invalidRevision !== undefined) {
    return rejected("invalid_admission", invalidRevision.reason);
  }

  if (draft.taskFamily !== undefined && scope.startsWith("task_family:")
    && scope !== `task_family:${draft.taskFamily.id}`) {
    return rejected("invalid_admission", "workflow task family does not match the admitted scope");
  }

  const expected = submitDraftCommand("workflow", draft.id);
  if (draft.command.payloadId !== expected.payloadId
    || draft.command.commandId !== expected.commandId
    || draft.command.kind !== expected.kind
    || draft.command.assetKind !== expected.assetKind) {
    return rejected("invalid_admission", "workflow draft command is not bound to this version");
  }

  const forbidden = scanForbiddenBody([
    ...draft.nodes.flatMap((node) => [node.id, node.input, node.output]),
    ...draft.verificationCheckpoints.map((item) => item.check),
    ...draft.failureFallback.flatMap((item) => [item.on, item.goto]),
    ...draft.positiveRules, ...draft.negativeRules,
  ]);

  return forbidden.length === 0 ? undefined
    : rejected("permission_language_present", `workflow body contains ${forbidden.join(", ")}`);
}
