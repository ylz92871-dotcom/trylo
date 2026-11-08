import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import { decodeToolEvolutionArtifact, isToolEvolutionVersionId, type ToolEvolutionArtifact } from "../domain/evolution/artifact.js";
import { preserveOrReviseToolSamples } from "../domain/evolution/contract-revision.js";
import { recordOf } from "../domain/evolution/parse.js";
import { approvedToolContractRevisionRecords } from "./contract-revision-reader.js";

/** Revision authority is rechecked when executable data is read, including an
 * inherited correction. Historical parents are provenance, not active bindings. */
export function validGeneratedContractLineage(state: BoardState, artifact: ToolEvolutionArtifact): boolean {
  let current = artifact;
  const visited = new Set<string>();

  for (let depth = 0; depth < 256; depth++) {
    const refs = current.request.contractRevisionRefs ?? [], prior = current.request.prior;
    if (prior === undefined) return refs.length === 0;

    if (visited.has(prior.versionId)) return false;

    visited.add(prior.versionId);
    const parent = archivedParent(state, prior.versionId);

    // Legacy requests did not require durable parent artifacts. They cannot
    // claim new contract-correction authority through this compatibility path.
    if (parent === undefined) return refs.length === 0;

    if (refs.length > 0) {
      if (current.request.operation !== "improve" || parent.candidate.source !== prior.source
        || parent.request.scope !== current.request.scope || parent.request.capability !== current.request.capability) return false;
      const approved = approvedToolContractRevisionRecords(state, prior.versionId, current.request.scope, refs);
      if (!approved.ok || !preserveOrReviseToolSamples({ parentVersionId: prior.versionId, scope: current.request.scope,
        parentSamples: parent.request.evidence, proposedSamples: current.request.evidence, revisions: approved.revisions }).ok) return false;
    }

    current = parent;
  }

  return false;
}

function archivedParent(state: BoardState, versionId: string): ToolEvolutionArtifact | undefined {
  const asset = state.assets.find(row => row.versionId === versionId);
  if (asset?.kind !== "tool_package" || asset.schemaVersion !== 1 || !recordOf(asset.content)
    || asset.content.type !== "tool_evolution_candidate" || asset.contentHash !== contentHashOf(asset.content)) return undefined;
  const { type: _type, ...body } = asset.content;
  const artifact = decodeToolEvolutionArtifact(body);
  return artifact !== undefined && isToolEvolutionVersionId(versionId, artifact) && asset.scope === artifact.request.scope ? artifact : undefined;
}
