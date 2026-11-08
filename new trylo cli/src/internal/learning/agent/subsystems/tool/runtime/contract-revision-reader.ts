import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import { decodeApprovedToolContractRevision, toolContractProposalId, type ApprovedToolContractRevision } from "../domain/evolution/contract-revision.js";
import { recordOf } from "../domain/evolution/parse.js";
import { assetAvailable, pipelineFailure, type PipelineFailure } from "./pipeline-assets.js";

/** Read approval records without importing a parent/production owner. Callers
 * retain ownership of resolving exact parent bytes and applying the contract.
 * Shape checks are additional to, never a replacement for, Permission consumption
 * at the sole approved-record writer in contract-revisions.ts. */
export function approvedToolContractRevisionRecords(state: BoardState, parentVersionId: string, scope: string,
  refs?: readonly string[]): PipelineFailure | { readonly ok: true; readonly revisions: readonly ApprovedToolContractRevision[] } {
  if (refs !== undefined && (refs.length > 8 || new Set(refs).size !== refs.length)) return pipelineFailure("contract_revision_refs_invalid", "revision references must be unique and bounded to eight");

  const chosen = refs ?? state.assets.filter(asset => asset.scope === scope && recordOf(asset.content)
    && asset.content.type === "tool_contract_revision_approved" && recordOf(asset.content.proposal)
    && asset.content.proposal.parentVersionId === parentVersionId).flatMap(asset => {
      const revision = decodeApprovedToolContractRevision(asset.content);
      const proposalId = revision === undefined ? undefined : toolContractProposalId(revision.proposal);
      return withdrawn(state, asset.versionId) || (proposalId !== undefined && withdrawn(state, proposalId)) ? [] : [asset.versionId];
    });
  if (chosen.length > 32) return pipelineFailure("contract_revision_capacity", "select applicable approved revisions explicitly before further learning");

  const revisions: ApprovedToolContractRevision[] = [];

  for (const ref of chosen) {
    const asset = state.assets.find(item => item.versionId === ref);
    const revision = asset === undefined ? undefined : decodeApprovedToolContractRevision(asset.content);
    const proposal = revision === undefined ? undefined : state.assets.find(item => item.versionId === toolContractProposalId(revision.proposal));
    if (asset === undefined || revision === undefined || asset.kind !== "workflow" || asset.source !== "user_explicit" || !assetAvailable(state, asset)
      || asset.versionId !== revision.revisionId || asset.scope !== scope || revision.proposal.parentVersionId !== parentVersionId
      || revision.proposal.scope !== scope || proposal === undefined || proposal.kind !== "workflow" || proposal.scope !== scope
      || !assetAvailable(state, proposal) || contentHashOf(proposal.content) !== contentHashOf(revision.proposal)) {
      return pipelineFailure("contract_revision_not_approved", "a correction lacks its exact immutable proposal, consumed approval binding or available Board lifecycle");
    }

    revisions.push(revision);
  }

  return { ok: true, revisions };
}

/** Explicitly withdrawn records are omitted from discovery, while selecting one
 * by ref still fails closed. Corrupt/missing records are never treated as withdrawal. */
function withdrawn(state: BoardState, versionId: string): boolean {
  const asset = state.assets.find(item => item.versionId === versionId);
  if (asset === undefined) return false;
  const proposal = state.proposals.find(item => item.proposalId === asset.createdFromProposalId);
  return proposal !== undefined && ["rejected", "suspended", "rolled_back", "retired"].includes(proposal.lifecycle)
    || state.tombstones.some(item => (item.entityType === "asset" && item.entityId === versionId)
      || (item.entityType === "proposal" && item.entityId === asset.createdFromProposalId));
}
