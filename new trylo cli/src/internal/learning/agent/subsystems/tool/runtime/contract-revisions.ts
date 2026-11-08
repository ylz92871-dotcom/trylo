import { createBoardReader, withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { ApprovalConsumptionPort, ApprovalGrantRef } from "../../../../../ports/approval-consumption.js";
import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import { contractRevisionReviewId, contractRevisionWithdrawalReviewId, decodeApprovedToolContractRevision, decodeToolContractRevisionProposal, previewToolContractRevision,
  toolContractProposalId, toolContractRevisionId, type ApprovedToolContractRevision } from "../domain/evolution/contract-revision.js";
import { recordOf } from "../domain/evolution/parse.js";
import { assetAvailable, pipelineFailure, savePipelineAsset, type PipelineFailure } from "./pipeline-assets.js";
import { toolLearningParentFromBoard } from "./learning-parent.js";
import { approvedToolContractRevisionRecords } from "./contract-revision-reader.js";
import { decodeToolProductionPlan } from "../domain/evolution/production-plan.js";
import { productionFromBoard } from "./production-assets.js";

/** The contract of an exact learning parent, not a global mutable oracle. */
export function toolContractParentFromBoard(state: BoardState, parentVersionId: string) {
  const asset = state.assets.find(row => row.versionId === parentVersionId), production = decodeToolProductionPlan(asset?.content);
  if (production?.type === "tool_production_package") {
    const exact = productionFromBoard(state, parentVersionId, production.workspaceId);
    if (!exact.ok) return exact;
    return { ok: true as const, parentVersionId, scope: production.origin.scope, parentSamples: production.checks.evidence };
  }

  const selected = toolLearningParentFromBoard(state, parentVersionId);
  if (!selected.ok) return selected;

  if (selected.parent.versionId !== parentVersionId) return pipelineFailure("contract_parent_not_canonical", `use the exact learning parent ${selected.parent.versionId}`);

  return { ok: true as const, parentVersionId, scope: selected.parent.scope,
    parentSamples: selected.parent.kind === "npm" ? selected.parent.plan.checks.evidence : selected.parent.artifact.request.evidence };
}

export async function proposeToolContractRevision(boardRoot: string, raw: unknown, issuedAt: string,
  admission?: { readonly jobId: string; readonly attempt: number }) {
  const proposal = decodeToolContractRevisionProposal(raw);
  if (proposal === undefined) return pipelineFailure("invalid_contract_revision", "a proposal needs exact old hashes, new expected values and external references; it cannot contain approval claims");

  const saved = await withBoardWriter(boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

    if (admission !== undefined) {
      const job = loaded.state.jobs.find(item => item.jobId === admission.jobId);
      if (job?.state !== "running" || job.domain !== "tool" || job.attempt !== admission.attempt || job.scope !== proposal.scope) {
        return pipelineFailure("stale_job_result", "contract correction no longer belongs to this running scoped learning attempt");
      }
    }

    const parent = toolContractParentFromBoard(loaded.state, proposal.parentVersionId);
    if (!parent.ok) return parent;

    const preview = previewToolContractRevision({ ...parent, proposal });
    if (!preview.ok) return preview;

    const proposalId = toolContractProposalId(proposal);
    const archived = await savePipelineAsset(store, { versionId: proposalId, kind: "workflow", scope: proposal.scope,
      source: "inferred", content: proposal, issuedAt, observations: proposal.corrections.flatMap(item => item.evidenceRefs) });

    return archived.ok ? { ok: true as const, proposalId, revisionId: toolContractRevisionId(proposal), approved: false as const } : archived;
  });

  return "reason" in saved ? pipelineFailure(saved.reason, saved.detail) : saved;
}

export function contractRevisionReviewFromBoard(state: BoardState, proposalId: string, scope?: string) {
  const asset = state.assets.find(item => item.versionId === proposalId);
  const proposal = asset === undefined ? undefined : decodeToolContractRevisionProposal(asset.content);
  if (asset === undefined || proposal === undefined || asset.kind !== "workflow" || !assetAvailable(state, asset)
    || toolContractProposalId(proposal) !== proposalId || asset.scope !== proposal.scope) return pipelineFailure("contract_proposal_unavailable", "the exact proposal is missing, withdrawn or invalid");

  if (scope !== undefined && proposal.scope !== scope) return pipelineFailure("contract_revision_scope_mismatch", "the proposal belongs to a different learning workspace");

  const parent = toolContractParentFromBoard(state, proposal.parentVersionId);
  if (!parent.ok) return parent;

  const preview = previewToolContractRevision({ ...parent, proposal });
  if (!preview.ok) return preview;

  const revisionId = toolContractRevisionId(proposal);
  const approved = approvedToolContractRevisionsFromBoard(state, proposal.parentVersionId, proposal.scope,
    state.assets.some(item => item.versionId === revisionId) ? [revisionId] : []);
  if (!approved.ok) return approved;

  return { ok: true as const, proposalId, proposal, revisionId, reviewId: contractRevisionReviewId(proposal), approved: approved.revisions.length > 0,
    withdrawReviewId: contractRevisionWithdrawalReviewId(proposal, approved.revisions.length > 0),
    withdrawalEffect: "Explicit withdrawal makes dependent candidates and production versions fail lineage reads; an active derived tool may refuse use. Restore an earlier approved version through the existing production rollback command.",
    changes: proposal.corrections.map(correction => { const old = parent.parentSamples.find(sample => sample.sampleId === correction.sampleId)!;
      return { sampleId: old.sampleId, role: old.role, input: old.input, oldExpected: old.expected, newExpected: correction.expected, evidenceRefs: correction.evidenceRefs }; }) };
}

export async function reviewToolContractRevision(boardRoot: string, proposalId: string, scope?: string) {
  const loaded = await createBoardReader(boardRoot).load();
  return loaded.ok ? contractRevisionReviewFromBoard(loaded.state, proposalId, scope) : pipelineFailure(loaded.reason, loaded.detail);
}

/** Only a trusted user-command host supplies a grant reference. Learning can
 * propose corrections but this function cannot issue, invent or self-approve one. */
export async function approveToolContractRevision(input: { readonly boardRoot: string; readonly proposalId: string; readonly scope: string;
  readonly reviewId: string; readonly permission: ApprovalConsumptionPort; readonly token: ApprovalGrantRef; readonly issuedAt: string }) {
  const saved = await withBoardWriter(input.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

    const review = contractRevisionReviewFromBoard(loaded.state, input.proposalId, input.scope);
    if (!review.ok) return review;

    if (review.reviewId !== input.reviewId) return pipelineFailure("contract_revision_review_stale", "review the exact old and new expected values before approval");

    if (review.approved) return { ok: true as const, revisionId: review.revisionId, duplicate: true };

    const consumed = await input.permission.consume({ token: input.token, action: "modify", candidateId: review.reviewId,
      packageVersionId: review.proposal.parentVersionId, scope: review.proposal.scope, now: input.issuedAt });
    if (!consumed.ok) return consumed;

    const content = decodeApprovedToolContractRevision({ type: "tool_contract_revision_approved", schemaVersion: 1,
      revisionId: review.revisionId, proposal: review.proposal, approval: consumed.value });
    if (content === undefined) return pipelineFailure("contract_revision_approval_invalid", "the consumed receipt does not bind this contract correction");

    const archived = await savePipelineAsset(store, { versionId: content.revisionId, kind: "workflow", scope: content.proposal.scope,
      source: "user_explicit", issuedAt: input.issuedAt, content, observations: [review.proposalId] });

    return archived.ok ? { ok: true as const, revisionId: content.revisionId, duplicate: false }
      : { ok: false as const, code: "contract_revision_approval_persistence_failed", approvalGrantId: consumed.value.grantId,
        message: `Permission was consumed but the approval archive did not complete (${archived.code}); inspect the Board and obtain fresh explicit approval before retrying.` };
  });
  return "reason" in saved ? pipelineFailure(saved.reason, saved.detail) : saved;
}

/** Approved data is read through the same Board lifecycle and immutable binding
 * checks on every preparation. Omitted refs list candidates; [] means no revision. */
export function approvedToolContractRevisionsFromBoard(state: BoardState, parentVersionId: string, scope: string,
  refs?: readonly string[]): PipelineFailure | { readonly ok: true; readonly revisions: readonly ApprovedToolContractRevision[] } {
  const parent = toolContractParentFromBoard(state, parentVersionId);
  if (!parent.ok) return parent;

  if (parent.scope !== scope) return pipelineFailure("contract_revision_scope_mismatch", "revision references must belong to this parent workspace");

  const records = approvedToolContractRevisionRecords(state, parentVersionId, scope, refs);
  if (!records.ok) return records;

  for (const revision of records.revisions) {
    const preview = previewToolContractRevision({ ...parent, proposal: revision.proposal });
    if (!preview.ok) return preview;
  }

  return records;
}

export async function listToolContractRevisions(boardRoot: string, parentVersionId: string, scope?: string) {
  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

  const parent = toolContractParentFromBoard(loaded.state, parentVersionId);
  if (!parent.ok) return parent;

  if (scope !== undefined && parent.scope !== scope) return pipelineFailure("contract_revision_scope_mismatch", "the parent belongs to another workspace");

  const approved = approvedToolContractRevisionsFromBoard(loaded.state, parentVersionId, parent.scope);
  if (!approved.ok) return approved;

  const proposals = loaded.state.assets.filter(asset => asset.scope === parent.scope && assetAvailable(loaded.state, asset)
    && recordOf(asset.content) && asset.content.type === "tool_contract_revision_proposal" && asset.content.parentVersionId === parentVersionId)
    .map(asset => contractRevisionReviewFromBoard(loaded.state, asset.versionId, parent.scope));

  return { ok: true as const, parentVersionId, scope: parent.scope, parentContractHash: contentHashOf(parent.parentSamples),
    parentSamples: parent.parentSamples, proposals, approved: approved.revisions };
}
