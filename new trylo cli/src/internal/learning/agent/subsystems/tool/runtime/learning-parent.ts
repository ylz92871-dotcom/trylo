import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import { decodeToolEvolutionArtifact, isToolEvolutionVersionId, type ToolEvolutionArtifact } from "../domain/evolution/artifact.js";
import type { NpmToolProductionPlan } from "../domain/evolution/npm-production-plan.js";
import { decodeToolProductionPlan } from "../domain/evolution/production-plan.js";
import { pipelineFailure, type PipelineFailure } from "./pipeline-assets.js";
import { productionFromBoard } from "./production-assets.js";
import { recordOf } from "../domain/evolution/parse.js";
import { validGeneratedContractLineage } from "./generated-contract-lineage.js";

export type ToolLearningParent = {
  readonly versionId: string;
  readonly scope: string;
  readonly capability: string;
  readonly identity: string;
} & (
  | { readonly kind: "generated"; readonly artifact: ToolEvolutionArtifact }
  | { readonly kind: "npm"; readonly plan: NpmToolProductionPlan }
);

/** Read-only learning history, never an executable candidate or active mount.
 * Suspended/rolled-back tools remain repairable; explicit rejection, retirement and tombstones
 * exclude them. Trials and production execution keep their separate availability readers.
 * npm parents retain their exact production interface/adapter identity, not merely an install ID. */
export function toolLearningParentFromBoard(state: BoardState, versionId: string): PipelineFailure | { readonly ok: true; readonly parent: ToolLearningParent } {
  const asset = state.assets.find(item => item.versionId === versionId);
  const proposal = state.proposals.find(item => item.proposalId === asset?.createdFromProposalId);
  if (asset === undefined || asset.kind !== "tool_package" || asset.schemaVersion !== 1 || asset.contentHash !== contentHashOf(asset.content)
    || proposal === undefined || proposal.domain !== "tool" || proposal.assetKind !== asset.kind || proposal.scope !== asset.scope
    || proposal.source !== asset.source || proposal.candidateRef !== versionId || ["rejected", "retired"].includes(proposal.lifecycle)
    || state.tombstones.some(row => row.entityId === asset.versionId || row.entityId === proposal.proposalId)) {
    return pipelineFailure("learning_parent_unavailable", "the requested immutable tool parent is unavailable");
  }

  const production = decodeToolProductionPlan(asset.content);
  if (production !== undefined) {
    const selected = productionFromBoard(state, versionId, production.workspaceId);
    if (!selected.ok) return selected;
    if (production.type === "npm_tool_production_package") return { ok: true, parent: { kind: "npm", versionId,
      scope: production.origin.scope, capability: production.origin.capability, identity: production.candidate.identity, plan: production } };
    return toolLearningParentFromBoard(state, production.origin.versionId);
  }

  if (!recordOf(asset.content) || asset.content.type !== "tool_evolution_candidate") return pipelineFailure("invalid_learning_parent", versionId);

  const { type: _type, ...body } = asset.content;
  const artifact = decodeToolEvolutionArtifact(body);
  if (artifact === undefined || !isToolEvolutionVersionId(versionId, artifact) || asset.scope !== artifact.request.scope
    || proposal.proposalId !== `proposal_${versionId}` || proposal.source !== "inferred" || proposal.risk !== "high"
    || contentHashOf(proposal.requiredVerifiers) !== contentHashOf(["tool_validation_pipeline"])
    || contentHashOf(proposal.requestedAuthorities) !== contentHashOf(["modify", "activate"])
    || !validGeneratedContractLineage(state, artifact)) return pipelineFailure("invalid_learning_parent", versionId);

  return { ok: true, parent: { kind: "generated", versionId, scope: artifact.request.scope,
    capability: artifact.request.capability, identity: artifact.candidate.identity, artifact } };
}

/** These IDs connect assessments to the exact candidate and its production interfaces.
 * Different npm adaptations of the same installation intentionally remain separate lineages. */
export function toolLearningFeedbackVersions(state: BoardState, versionId: string): readonly string[] {
  const versions = new Set([versionId]);
  const selected = state.assets.find(item => item.versionId === versionId);
  const production = selected === undefined ? undefined : decodeToolProductionPlan(selected.content);
  if (production?.type === "npm_tool_production_package") return [...versions];

  for (const asset of state.assets) {
    if (asset.kind !== "tool_package") continue;
    const plan = decodeToolProductionPlan(asset.content);
    if (plan?.type === "tool_production_package" && plan.origin.versionId === versionId
      && contentHashOf(plan) === asset.contentHash && toolLearningParentFromBoard(state, asset.versionId).ok) versions.add(asset.versionId);
  }

  return [...versions];
}
