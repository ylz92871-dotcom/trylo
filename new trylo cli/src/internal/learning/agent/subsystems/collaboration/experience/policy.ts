import type { LearningAssetVersion } from "../../../../control/contracts.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { BoardState } from "../../../../control/state.js";
import type { CollaborationExperienceContent, ExperienceOwner, PrepareExperienceInput, PreparedExperience } from "./contracts.js";
import { isCollaborationExperienceContent } from "./parse.js";
import { collaborationExperienceSourcesValid } from "./provenance.js";
import { renderExperience } from "./render.js";

export const COLLABORATION_EXPERIENCE_SELECTION_POLICY = "collaboration:owner-family-draft-condition-selector:v1";

export function experienceOwnerFingerprint(owner: ExperienceOwner): string {
  return `experience-owner:${contentHashOf(owner)}`;
}

export function experienceConditionsMatch(content: CollaborationExperienceContent, input: PrepareExperienceInput): boolean {
  if (experienceOwnerFingerprint(content.owner) !== experienceOwnerFingerprint(input.owner)) return false;

  if (content.expertVersion !== undefined && content.expertVersion !== input.expertVersion) return false;

  const c = content.conditions, context = input.context;

  return (c.expertDraft === undefined ? input.expertDraft === undefined : contentHashOf({ draft: c.expertDraft }) === contentHashOf({ draft: input.expertDraft }))
    && (c.useScope === undefined || contentHashOf({ scope: c.useScope }) === contentHashOf({ scope: context?.useScope }))
    && (c.surface === undefined || c.surface === context?.surface)
    && (c.taskFamily === undefined || c.taskFamily === context?.taskFamily)
    && (c.dependency === undefined || c.dependency === context?.dependency)
    && (c.responsibility === undefined || context?.responsibilities?.includes(c.responsibility) === true);
}

/** Draft authorization branches cannot replace saved experience. Within each branch, newest wins before applicability. */
export function liveExperienceAssets(state: BoardState, scope: string): readonly LearningAssetVersion[] {
  const latest = new Map<string, LearningAssetVersion>();

  for (const asset of state.assets) {
    if (asset.scope !== scope || !isCollaborationExperienceContent(asset.content)
      || !state.proposals.some(p => p.proposalId === asset.createdFromProposalId && p.domain === "collaboration" && p.lifecycle === "evaluating")
      || state.tombstones.some(t => t.entityId === asset.versionId || t.entityId === asset.createdFromProposalId)) continue;
    const draft = asset.content.sourceExpert?.draft;
    const branch = draft === undefined ? "saved" : contentHashOf({ draft, useScope: asset.content.conditions.useScope });
    latest.set(`${experienceOwnerFingerprint(asset.content.owner)}:${asset.content.familyId}:${branch}`, asset);
  }

  return [...latest.values()];
}

export function selectExperience(state: BoardState, scope: string, input: PrepareExperienceInput): PreparedExperience {
  const cards: string[] = [], versionIds: string[] = [];

  for (const asset of liveExperienceAssets(state, scope).slice().reverse()) {
    if (!isCollaborationExperienceContent(asset.content) || !experienceConditionsMatch(asset.content, input)
      || !collaborationExperienceSourcesValid(state, scope, asset.content)) continue;
    const card = renderExperience(asset.content);
    if ([...cards, card].join("\n\n").length > input.maxChars) continue;
    cards.push(card);
    versionIds.push(asset.versionId);
  }

  const text = cards.join("\n\n");

  return { text, versionIds, selectionId: `experience-selection:${contentHashOf({ scope, input, versionIds, text })}` };
}
