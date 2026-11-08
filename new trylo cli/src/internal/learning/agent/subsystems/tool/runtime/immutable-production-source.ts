import type { BoardState } from "../../../../control/state.js";
import type { ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { decodeToolProductionPlan } from "../domain/evolution/production-plan.js";
import { generatedPredecessorFromBoard } from "./generated-predecessor.js";
import { exactPureProductionLearningParents } from "./pure-production-regression.js";

/** Immutable provenance for an already committed npm replacement. New claims
 * and construction guards use the original availability-aware reader instead.
 * No Board state, activation, receipt or Permission authority is returned. */
export function hasImmutablePureProductionSourceProof(state: BoardState, plan: ToolLearningPlan,
  versionId: string, workspaceId: string): boolean {
  const asset = state.assets.find(asset => asset.versionId === versionId);
  const raw = decodeToolProductionPlan(asset?.content);
  if (asset === undefined || raw?.type !== "tool_production_package" || raw.origin.versionId !== plan.targetVersionId) return false;

  // The existing historical owner validates the unmodified bytes, canonical
  // production/proposal/source hashes and artifact relation before any view.
  const source = generatedPredecessorFromBoard(state, versionId, workspaceId);
  if (source === undefined || source.scope !== plan.scope || source.contentHash !== asset.contentHash) return false;

  const originAsset = state.assets.find(row => row.versionId === raw.origin.versionId);
  const origin = generatedPredecessorFromBoard(state, raw.origin.versionId, workspaceId);
  if (originAsset === undefined || origin === undefined || origin.contentHash !== raw.origin.contentHash
    || origin.scope !== plan.scope || originAsset.createdFromProposalId === undefined || asset.createdFromProposalId === undefined) return false;

  const sourceIds = new Set([versionId, raw.origin.versionId]), proposalIds = new Set([asset.createdFromProposalId, originAsset.createdFromProposalId]);
  // Only P1/C1's present learning availability is irrelevant to this proof. This
  // local read projection is neither persisted nor exposed to an executor.
  // Evaluating never grants active execution; all original source/workspace,
  // feedback/use and exact-source checks still run in the existing reader.
  const historical: BoardState = { ...state,
    proposals: state.proposals.map(proposal => proposalIds.has(proposal.proposalId) ? { ...proposal, lifecycle: "evaluating" as const } : proposal),
    tombstones: state.tombstones.filter(tombstone => !sourceIds.has(tombstone.entityId) && !proposalIds.has(tombstone.entityId)) };
  const exact = exactPureProductionLearningParents(historical, plan);

  return exact.ok && exact.parents.length === 1 && exact.parents[0]!.versionId === versionId
    && exact.parents[0]!.artifactVersionId === raw.origin.versionId && exact.parents[0]!.contentHash === source.contentHash
    && exact.parents[0]!.plan.workspaceId === workspaceId;
}
