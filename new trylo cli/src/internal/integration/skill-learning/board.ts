import type { BoardCommand } from "../../learning/control/commands.js";
import type { BoardStore } from "../../learning/control/store-port.js";
import type { BoardState } from "../../learning/control/state.js";
import { mapSkillDraft } from "../content/skill.js";
import { projectionScope } from "../content/scope.js";
import type { SkillCandidate, SkillExperience } from "./runtime-contract.js";
import { decodeLearnedSkillContent } from "./catalog.js";
import { sameSkillTaskFamily } from "../../learning/domains/skill/conditions.js";

export class SkillBoardError extends Error {
  constructor(readonly code: string) { super(code); }
}

export async function applySkillCommand(board: BoardStore, command: BoardCommand): Promise<void> {
  const result = await board.apply(command);
  if (!result.ok) throw new SkillBoardError(result.reason);
}

export async function loadSkillBoard(board: BoardStore): Promise<BoardState> {
  const loaded = await board.load();
  if (!loaded.ok) throw new SkillBoardError(loaded.reason);
  return loaded.state;
}

/** Resume from committed phases after interruption; content is only ever committed once. */
export async function prepareSkillTrial(board: BoardStore, candidate: SkillCandidate, issuedAt: string): Promise<void> {
  let state = await loadSkillBoard(board);
  const { draft, versionId } = candidate;
  const base = { issuedAt, proposalId: draft.id };

  if (!state.proposals.some(item => item.proposalId === draft.id)) {
    const mapped = mapSkillDraft(draft, { commandId: `${draft.id}:submit`, issuedAt, risk: "low",
      hypothesis: "Conditioned procedures supported by independent task outcomes and counterexamples",
      requiredVerifiers: ["skill-execution-replay"],
      ...(candidate.baselineVersionId === undefined ? {} : { baseVersionId: candidate.baselineVersionId }) });
    if (!mapped.ok) throw new SkillBoardError(mapped.reason);
    for (const command of mapped.value) await applySkillCommand(board, command);
  }

  if (!state.assets.some(item => item.versionId === versionId)) {
    await applySkillCommand(board, { ...base, type: "commit_asset", commandId: `${draft.id}:commit`, versionId,
      schemaVersion: 1, content: candidate.content,
      ...(candidate.baselineVersionId === undefined ? {} : { parentVersionId: candidate.baselineVersionId }) });
  }

  state = await loadSkillBoard(board);

  if (state.proposals.find(item => item.proposalId === draft.id)?.lifecycle === "draft") {
    await applySkillCommand(board, { ...base, type: "quarantine", commandId: `${draft.id}:quarantine` });
  }

  state = await loadSkillBoard(board);

  if (state.proposals.find(item => item.proposalId === draft.id)?.lifecycle === "quarantined") {
    await applySkillCommand(board, { ...base, type: "start_evaluation", commandId: `${draft.id}:evaluate` });
  }
}

/** Negative usage invalidates a trial before relearning, even when no replacement qualifies. */
export async function applySkillFeedback(board: BoardStore, experiences: readonly SkillExperience[], workspaceId: string, issuedAt: string): Promise<void> {
  for (const fact of experiences) {
    if (fact.workspaceId !== workspaceId) continue;

    const state = await loadSkillBoard(board);

    if (fact.usedSkill !== undefined) {
      const used = state.assets.find(item => item.versionId === fact.usedSkill?.versionId);
      const content = decodeLearnedSkillContent(used?.content);
      if (used === undefined || content === undefined || content.workspaceId !== workspaceId || used.contentHash !== fact.usedSkill.contentHash
        || !content.draft.variants.some(item => item.id === fact.usedSkill?.variantId && sameSkillTaskFamily(item.taskFamily, fact.episode.taskFamily))) {
        throw new SkillBoardError("feedback_binding_mismatch");
      }
    }

    if (fact.episode.outcome !== "failure" || fact.episode.correction?.scope === "task") continue;

    for (const activation of state.activations) {
      if (activation.pointer !== "active" && activation.pointer !== "shadow") continue;

      const asset = state.assets.find(item => item.versionId === activation.versionId);
      const content = decodeLearnedSkillContent(asset?.content);
      if (content === undefined || content.workspaceId !== workspaceId) continue;

      const correction = fact.episode.correction;
      const targets = correction !== undefined && content.draft.variants.some(variant =>
        (correction.scope === "family" ? variant.taskFamily.id === fact.episode.taskFamily.id : sameSkillTaskFamily(variant.taskFamily, fact.episode.taskFamily))
        && variant.supportEpisodeIds.some(id => correction.targetEpisodeIds.includes(id)));

      // Late usage describes its version; it cannot revoke an unrelated replacement.
      if (activation.versionId !== fact.usedSkill?.versionId && !targets) continue;

      const proposal = state.proposals.find(item => item.proposalId === asset?.createdFromProposalId);
      if (proposal === undefined) throw new SkillBoardError("feedback_binding_mismatch");

      const base = { commandId: `skill-feedback:${fact.episode.id}:${activation.versionId}`, issuedAt, proposalId: proposal.proposalId };

      if (proposal.lifecycle === "shadow") await applySkillCommand(board, { ...base, type: "reject", reason: fact.sourceRef });

      if (proposal.lifecycle === "active") await applySkillCommand(board, { ...base, type: "suspend", breakerReason: fact.sourceRef });
    }
  }
}

export function skillCandidateScope(candidate: SkillCandidate): string { return projectionScope(candidate.draft.scope); }
