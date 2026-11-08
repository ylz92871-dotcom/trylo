import { withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { ApprovalConsumptionPort, ApprovalGrantRef } from "../../../../../ports/approval-consumption.js";
import { contractRevisionReviewFromBoard } from "./contract-revisions.js";
import { pipelineFailure } from "./pipeline-assets.js";

/** User withdrawal invalidates the revision's data lineage. It does not move an
 * activation pointer; dependent use can refuse until the user rolls back through
 * the existing production owner. Ordinary negative feedback cannot call this. */
export async function withdrawToolContractRevision(input: { readonly boardRoot: string; readonly proposalId: string; readonly scope: string;
  readonly withdrawReviewId: string; readonly permission: ApprovalConsumptionPort; readonly token: ApprovalGrantRef; readonly issuedAt: string }) {
  const saved = await withBoardWriter(input.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

    const review = contractRevisionReviewFromBoard(loaded.state, input.proposalId, input.scope);
    if (!review.ok) return review;

    if (input.withdrawReviewId !== review.withdrawReviewId) return pipelineFailure("contract_withdrawal_review_stale", "review the withdrawal effect and its exact withdrawal review ID; an approval ID cannot authorize withdrawal");

    const asset = loaded.state.assets.find(item => item.versionId === input.proposalId);
    const proposalId = asset?.createdFromProposalId;
    if (asset === undefined || proposalId === undefined) return pipelineFailure("contract_proposal_unavailable", "the exact correction proposal is unavailable");

    const consumed = await input.permission.consume({ token: input.token, action: "modify", candidateId: review.withdrawReviewId,
      packageVersionId: review.proposal.parentVersionId, scope: input.scope, now: input.issuedAt });
    if (!consumed.ok) return consumed;

    const rejected = await store.apply({ type: "reject", commandId: `contract-withdrawal:${consumed.value.grantId}`, issuedAt: input.issuedAt,
      proposalId, reason: "explicit_user_contract_revision_withdrawal" });

    return rejected.ok ? { ok: true as const, proposalId: input.proposalId, revisionId: review.revisionId, state: "withdrawn" as const,
      effect: review.withdrawalEffect } : { ok: false as const, code: "contract_revision_withdrawal_persistence_failed", approvalGrantId: consumed.value.grantId,
        message: `Permission was consumed but withdrawal was not committed (${rejected.reason}); inspect the Board before fresh explicit retry.` };
  });
  return "reason" in saved ? pipelineFailure(saved.reason, saved.detail) : saved;
}
