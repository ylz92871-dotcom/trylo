import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import { decodeToolEvolutionArtifact, isToolEvolutionVersionId } from "../domain/evolution/artifact.js";
import { createToolProductionPlan, decodeToolProductionPlan, isToolProductionLicense, toolProductionScope, toolProductionVersion } from "../domain/evolution/production-plan.js";
import { recordOf } from "../domain/evolution/parse.js";
import { validGeneratedContractLineage } from "./generated-contract-lineage.js";
import type { NpmAdaptationPredecessor } from "./npm-adaptation-types.js";

/** Historical contract/source only. This does not mount a generated tool or transfer its approval. */
export function generatedPredecessorFromBoard(state: BoardState, versionId: string, workspaceId: string): NpmAdaptationPredecessor | undefined {
  const asset = state.assets.find(row => row.versionId === versionId);
  if (asset?.kind !== "tool_package" || asset.schemaVersion !== 1 || asset.contentHash !== contentHashOf(asset.content)) return undefined;

  const production = decodeToolProductionPlan(asset.content);
  if (production?.type === "npm_tool_production_package") return undefined;

  const origin = production === undefined ? asset : state.assets.find(row => row.versionId === production.origin.versionId);
  if (origin?.kind !== "tool_package" || origin.schemaVersion !== 1 || !recordOf(origin.content)
    || origin.content.type !== "tool_evolution_candidate" || origin.contentHash !== contentHashOf(origin.content)) return undefined;

  const { type: _type, ...body } = origin.content, artifact = decodeToolEvolutionArtifact(body);
  if (artifact === undefined || !isToolEvolutionVersionId(origin.versionId, artifact) || origin.scope !== artifact.request.scope
    || !validGeneratedContractLineage(state, artifact)) return undefined;

  const proposal = state.proposals.find(row => row.proposalId === asset.createdFromProposalId);
  if (proposal?.domain !== "tool" || proposal.assetKind !== asset.kind || proposal.scope !== asset.scope || proposal.source !== asset.source
    || proposal.candidateRef !== versionId) return undefined;

  if (production !== undefined) {
    if (production.workspaceId !== workspaceId || !isToolProductionLicense(production.manifest.licenseSpdx)
      || production.origin.contentHash !== origin.contentHash || asset.scope !== toolProductionScope(production)
      || toolProductionVersion(production) !== versionId || proposal.proposalId !== `production-proposal:${versionId}`
      || proposal.risk !== "medium" || asset.source !== "user_explicit"
      || contentHashOf(proposal.requiredVerifiers) !== contentHashOf(["tool-production-checker-v1"])
      || contentHashOf(proposal.requestedAuthorities) !== contentHashOf(["tool_activation"])) return undefined;

    const rebuilt = createToolProductionPlan({ workspaceId, originVersionId: origin.versionId, artifact,
      checks: production.checks, license: production.manifest.licenseSpdx });
    if (!rebuilt.ok || contentHashOf(rebuilt.plan) !== asset.contentHash) return undefined;
  } else if (asset.scope !== artifact.request.scope || proposal.proposalId !== `proposal_${versionId}` || proposal.risk !== "high"
    || asset.source !== "inferred" || contentHashOf(proposal.requiredVerifiers) !== contentHashOf(["tool_validation_pipeline"])
    || contentHashOf(proposal.requestedAuthorities) !== contentHashOf(["modify", "activate"])) return undefined;

  const { source, ...descriptor } = artifact.candidate;

  return { versionId, contentHash: asset.contentHash, scope: artifact.request.scope, capability: artifact.request.capability,
    descriptor, checks: production?.checks ?? artifact.request, source, feedback: "Historical generated tool contract; replacing its implementation grants no activation authority" };
}
