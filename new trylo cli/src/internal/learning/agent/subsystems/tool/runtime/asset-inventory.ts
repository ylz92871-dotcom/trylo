import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { candidateToolName } from "../domain/evolution/index.js";
import { candidateFromBoard } from "./evolution-reader.js";
import { productionFromBoard } from "./production-assets.js";
import { pipelineFailure } from "./pipeline-assets.js";

export type ToolAssetSummary = {
  readonly versionId: string;
  readonly identity: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly lifecycle: string;
  readonly runtimeName?: string;
  readonly originVersionId?: string;
  readonly version?: string;
  readonly reason?: string;
};

/** Learning owns decoding its assets. This read model carries neither source code nor verification samples. */
export async function readToolAssetInventory(boardRoot: string, workspaceId: string) {
  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

  const assets = loaded.state.assets.filter(asset => asset.kind === "tool_package" && typeof asset.content === "object"
    && asset.content !== null && !Array.isArray(asset.content) && (asset.scope === workspaceId || ("workspaceId" in asset.content && asset.content.workspaceId === workspaceId)));
  if (assets.length > 2048) return pipelineFailure("tool_inventory_capacity", "more than 2048 workspace tool assets require a paginated owner projection");

  const items: ToolAssetSummary[] = [];

  for (const asset of assets) {
    const lifecycle = loaded.state.proposals.find(row => row.proposalId === asset.createdFromProposalId)?.lifecycle ?? "unknown";
    const production = productionFromBoard(loaded.state, asset.versionId, workspaceId);
    if (production.ok) {
      const plan = production.plan;
      items.push({ versionId: asset.versionId, identity: plan.candidate.identity, description: plan.candidate.description,
        capabilities: [...new Set([plan.origin.capability, ...plan.manifest.capabilities])], lifecycle,
        runtimeName: candidateToolName(plan.candidate.identity, contentHashOf(plan)), originVersionId: plan.origin.versionId, version: plan.manifest.version });
      continue;
    }

    const candidate = candidateFromBoard(loaded.state, asset.versionId);
    if (candidate.ok) {
      items.push({ versionId: asset.versionId, identity: candidate.artifact.candidate.identity, description: candidate.artifact.candidate.description,
        capabilities: [candidate.artifact.request.capability], lifecycle, reason: "candidate_requires_production_approval" });
    } else {
      items.push({ versionId: asset.versionId, identity: asset.versionId, description: "学习工具资产当前不可用于运行。", capabilities: [], lifecycle, reason: candidate.code });
    }
  }

  return { ok: true as const, items };
}
