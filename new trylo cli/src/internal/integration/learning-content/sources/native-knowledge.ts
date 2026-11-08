import type { BoardState } from "../../../learning/control/state.js";
import type { ContentRecord } from "../records.js";
import { isCollaborationExperienceContent, selectExperience,
  type PrepareExperienceInput } from "../../../learning/agent/subsystems/collaboration/index.js";

/** Trusted retrieval context. An inspection is source review, never an adoption authorization. */
export interface NativeKnowledgeAccess {
  readonly collaboration?: PrepareExperienceInput;
  readonly inspectionIssueIds?: readonly string[];
}

function inspecting(board: BoardState, scope: string, issueId: string | undefined, access: NativeKnowledgeAccess): boolean {
  return issueId !== undefined && access.inspectionIssueIds?.includes(issueId) === true
    && board.learningIssues?.some(issue => issue.scope === scope && issue.issueId === issueId) === true;
}

function collaborationAsset(board: BoardState, versionId: string) {
  const asset = board.assets.find(item => item.versionId === versionId);
  return asset !== undefined && isCollaborationExperienceContent(asset.content) ? asset : undefined;
}

/** Use the original owner/context/liveness/provenance selector. Scope and lexical
 * relevance cannot broadcast a member's or expert's experience to another owner. */
export function canReadNativeAsset(board: BoardState, scope: string, versionId: string, access: NativeKnowledgeAccess = {}): boolean {
  const asset = board.assets.find(item => item.versionId === versionId);
  if (asset === undefined) return false;

  const content = asset.content;
  if (!isCollaborationExperienceContent(content)) {
    return !(typeof content === "object" && content !== null && "schema" in content && content.schema === "collaboration-experience/v1");
  }

  if (asset.scope !== scope || board.tombstones.some(item => item.entityId === asset.versionId || item.entityId === asset.createdFromProposalId)) return false;

  if (inspecting(board, scope, content.issueId, access)) return true;

  if (access.collaboration === undefined) return false;

  return selectExperience(board, scope, access.collaboration).versionIds.includes(asset.versionId);
}

/** Derived public model prose retains the access boundary of the source material it
 * contains. No owner is inferred from arbitrary context text or a model's claim. */
export function canReadNativeContentRecord(board: BoardState, scope: string, record: ContentRecord,
  access: NativeKnowledgeAccess = {}): boolean {
  if (record.packet.scope !== scope) return false;

  const refs = [...record.packet.answers.flatMap(item => item.artifactRefs), ...record.packet.materials.flatMap(item => item.links.artifactRefs)];
  const restricted = [...new Set(refs.filter(ref => collaborationAsset(board, ref.id) !== undefined).map(ref => ref.id))];
  if (restricted.some(ref => !canReadNativeAsset(board, scope, ref, access))) return false;

  const hasCollaborationMaterial = record.packet.domain === "collaboration" || record.packet.materials.some(item => item.subsystem === "collaboration");
  if (!hasCollaborationMaterial) return true;

  return inspecting(board, scope, record.packet.focus?.issueId, access) || restricted.length > 0;
}

export { nativeMethodKnowledgeCandidates, explicitNativeMethodMaterials, readNativeKnowledgeMaterial } from "./native-knowledge-method.js";
