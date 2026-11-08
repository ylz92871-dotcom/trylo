import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import { isCollaborationExperienceContent } from "./parse.js";
import { isCollaborationPlan } from "../orchestration/parse.js";

/** Management reads the whole immutable content; discovery cards remain bounded runtime inputs. */
export function collaborationArchiveFromBoard(state: BoardState, scope: string) {
  const assets = [];

  for (const asset of state.assets) {
    if (asset.scope !== scope || asset.kind !== "workflow") continue;

    if (state.tombstones.some(item => item.entityId === asset.versionId || item.entityId === asset.createdFromProposalId)) continue;

    const content = asset.content;
    const ownedIdentity = asset.versionId.startsWith("collaboration-experience-version:") || asset.versionId.startsWith("collaboration-plan-version:");

    if (!isCollaborationExperienceContent(content) && !isCollaborationPlan(content)) {
      if (ownedIdentity) return { ok: false as const, reason: "collaboration_archive_corrupt" };
      continue;
    }

    const kind = isCollaborationExperienceContent(content) ? "experience" : "plan";
    if (asset.contentHash !== contentHashOf(content)
      || asset.versionId !== `collaboration-${kind}-version:${contentHashOf({ scope, content })}`) {
      return { ok: false as const, reason: "collaboration_archive_corrupt" };
    }

    assets.push({ ...asset, content });
  }

  return { ok: true as const, assets };
}
