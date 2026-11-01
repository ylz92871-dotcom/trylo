import { contentHashOf } from "../../learning/control/hash.js";
import type { BoardCommand } from "../../learning/control/commands.js";
import type { AssetKind, LearningAssetVersion } from "../../learning/control/contracts.js";
import type { BoardState } from "../../learning/control/state.js";
import type { BoardStore } from "../../learning/control/store-port.js";

export type PipelineFailure = { readonly ok: false; readonly code: string; readonly message: string };
export function pipelineFailure(code: string, message: string): PipelineFailure { return { ok: false, code, message }; }

/** Data artifacts share Board persistence, but have no active pointer or authority request. */
export async function savePipelineAsset(store: BoardStore, input: {
  readonly versionId: string; readonly kind: AssetKind; readonly content: unknown; readonly scope: string;
  readonly source: "user_explicit" | "inferred"; readonly issuedAt: string; readonly observations?: readonly string[];
}) {
  const loaded = await store.load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
  const existing = loaded.state.assets.find(asset => asset.versionId === input.versionId);
  if (existing !== undefined) return assetAvailable(loaded.state, existing) && existing.scope === input.scope
    && existing.kind === input.kind && existing.contentHash === contentHashOf(input.content)
    ? { ok: true as const, versionId: input.versionId } : pipelineFailure("pipeline_asset_conflict", input.versionId);
  const proposalId = `proposal:${input.versionId}`;
  const base = { issuedAt: input.issuedAt };
  const commands: readonly BoardCommand[] = [
    { ...base, type: "submit_proposal", commandId: `${proposalId}:submit`, proposal: { proposalId, scope: input.scope,
      domain: "tool", assetKind: input.kind, candidateRef: input.versionId, hypothesis: "Bounded tool learning pipeline data",
      observationRefs: input.observations ?? [], risk: "low", requiredVerifiers: [], requestedAuthorities: [], source: input.source } },
    { ...base, type: "quarantine", commandId: `${proposalId}:quarantine`, proposalId },
    { ...base, type: "start_evaluation", commandId: `${proposalId}:evaluate`, proposalId },
    { ...base, type: "commit_asset", commandId: `${proposalId}:commit`, proposalId, versionId: input.versionId,
      schemaVersion: 1, content: input.content },
  ];
  for (const command of commands) {
    const applied = await store.apply(command);
    if (!applied.ok) return pipelineFailure(applied.reason, applied.detail);
  }
  return { ok: true as const, versionId: input.versionId };
}

export function assetAvailable(state: BoardState, asset: LearningAssetVersion): boolean {
  const proposal = state.proposals.find(item => item.proposalId === asset.createdFromProposalId);
  return asset.schemaVersion === 1 && contentHashOf(asset.content) === asset.contentHash && proposal !== undefined
    && proposal.scope === asset.scope && proposal.assetKind === asset.kind
    && !["rejected", "suspended", "rolled_back", "retired"].includes(proposal.lifecycle)
    && !state.tombstones.some(item => (item.entityType === "asset" && item.entityId === asset.versionId)
      || (item.entityType === "proposal" && item.entityId === asset.createdFromProposalId));
}
