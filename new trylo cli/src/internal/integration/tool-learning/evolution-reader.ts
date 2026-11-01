import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import type { BoardState } from "../../learning/control/state.js";
import { canonicalJson, sha256Hex } from "../../learning/control/hash.js";
import { decodeToolEvolutionArtifact, isToolEvolutionVersionId, type ToolEvolutionArtifact } from "../../learning/domains/tool/evolution/artifact.js";
import { keysAre, recordOf } from "../../learning/domains/tool/evolution/parse.js";

export type EvolutionReadFailure = { readonly ok: false; readonly code: string; readonly message: string };
export type EvolutionCandidateRead = EvolutionReadFailure | {
  readonly ok: true; readonly versionId: string; readonly proposalId: string; readonly artifact: ToolEvolutionArtifact;
};

export async function readToolEvolutionCandidate(boardRoot: string, versionId: string): Promise<EvolutionCandidateRead> {
  const loaded = await createBoardReader(boardRoot).load();
  return loaded.ok ? candidateFromBoard(loaded.state, versionId) : { ok: false, code: loaded.reason, message: loaded.detail };
}

/** This is the only executable-candidate read boundary; inventory alone grants no execution. */
export function candidateFromBoard(state: BoardState, versionId: string): EvolutionCandidateRead {
  const asset = state.assets.find(item => item.versionId === versionId);
  if (asset === undefined) return { ok: false, code: "candidate_not_found", message: "candidate version is absent" };
  const proposal = state.proposals.find(item => item.proposalId === asset.createdFromProposalId);
  if (proposal === undefined || state.tombstones.some(item => item.entityId === versionId || item.entityId === proposal.proposalId)
    || ["rejected", "suspended", "rolled_back", "retired"].includes(proposal.lifecycle)) {
    return { ok: false, code: "candidate_unavailable", message: "candidate is not available for an explicit trial" };
  }
  const content = asset.content;
  if (asset.kind !== "tool_package" || asset.schemaVersion !== 1 || !recordOf(content)
    || !keysAre(content, ["type", "schemaVersion", "request", "candidate", "verification", "generatedAt"])
    || content.type !== "tool_evolution_candidate") return invalid();
  const { type: _type, ...body } = content;
  const artifact = decodeToolEvolutionArtifact(body);
  if (artifact === undefined || asset.contentHash !== sha256Hex(canonicalJson(content)) || !isToolEvolutionVersionId(versionId, artifact)
    || asset.scope !== artifact.request.scope || proposal.scope !== artifact.request.scope) return invalid();
  return { ok: true, versionId, proposalId: proposal.proposalId, artifact };
}

function invalid(): EvolutionReadFailure { return { ok: false, code: "invalid_artifact", message: "archived candidate failed schema, content, scope or verification binding checks" }; }
