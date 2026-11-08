import { contentHashOf } from "../../../../../control/hash.js";
import type { LearningAssetVersion } from "../../../../../control/contracts.js";
import type { BoardState } from "../../../../../control/state.js";

/** Pure archive integrity/lifecycle check shared by domain and IO owners. */
export function assetAvailable(state: BoardState, asset: LearningAssetVersion): boolean {
  const proposal = state.proposals.find(item => item.proposalId === asset.createdFromProposalId);
  return asset.schemaVersion === 1 && contentHashOf(asset.content) === asset.contentHash && proposal !== undefined
    && proposal.scope === asset.scope && proposal.assetKind === asset.kind
    && !["rejected", "suspended", "rolled_back", "retired"].includes(proposal.lifecycle)
    && !state.tombstones.some(item => (item.entityType === "asset" && item.entityId === asset.versionId)
      || (item.entityType === "proposal" && item.entityId === asset.createdFromProposalId));
}
