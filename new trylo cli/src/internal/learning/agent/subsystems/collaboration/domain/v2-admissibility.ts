import type { BoardState } from "../../../../control/state.js";
import type { CollaborationPracticeDraftV2, CollaborationPracticeV2 } from "./v2-contracts.js";
import { isCollaborationPracticeV2 } from "./v2-parse.js";

/** This rejects explicit authority-changing instructions. Mechanical permissions remain the actual security boundary. */
export function authorityChangeRequested(text: string): boolean {
  const imperative = /(?:ignore|bypass|disable|skip|override|grant|expand|remove)\s+(?:(?:all|the|existing|current)\s+)*(?:permissions?|approvals?|authorization|sandbox|role restrictions)|(?:跳过|绕过|关闭|取消|忽略|放宽|扩大|授予|修改)(?:所有|现有|当前)?(?:审批|权限|授权|沙箱|角色限制|安全检查)/giu;
  for (const match of text.matchAll(imperative)) {
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 24), match.index);
    if (!/(?:do\s+not|must\s+not|never|don't|不得|不能|禁止|不可|不要)\s*$/iu.test(prefix)) return true;
  }
  return false;
}

export function lineageFailureV2(state: BoardState, scope: string, draft: CollaborationPracticeDraftV2): string | undefined {
  if (draft.actions.some(a => authorityChangeRequested(a.instruction))) return "authority_change_requested";

  const assets = state.assets.filter(a => a.scope === scope && isCollaborationPracticeV2(a.content));
  const previous = assets.filter(a => isCollaborationPracticeV2(a.content) && a.content.familyId === draft.familyId).at(-1);
  if (previous !== undefined && previous.versionId !== draft.parentVersionId) return "family_parent_required";

  if (previous === undefined && draft.parentVersionId !== undefined) return "family_parent_mismatch";

  const facts = state.collaborationV2Facts ?? [];

  for (const asset of assets) {
    if (!isCollaborationPracticeV2(asset.content)) continue;

    const p = asset.content;
    const overlaps = draft.actions.some(a => p.actions.some(b => a.operation === b.operation && a.audience === b.audience));
    const sources = [...p.sourceEventIds, ...p.sourceEpisodeIds, ...p.sourceOutcomeIds];
    const sharedBasis = [...draft.sourceEventIds, ...draft.sourceEpisodeIds, ...draft.sourceOutcomeIds].some(id => sources.includes(id));
    const protectedFamily = facts.some(f => f.kind === "correction" && f.scope === scope && f.familyId === p.familyId && f.action === "suspend"
      && !facts.some(n => n.kind === "correction" && n.action === "restore" && n.replacesCorrectionId === f.factId));
    const feedbackLinked = draft.sourceOutcomeIds.some(id => {
      const outcome = facts.find(f => f.kind === "outcome" && f.factId === id);
      return outcome?.kind === "outcome" && outcome.adoptionIds.some(adoptionId => facts.some(adoption => adoption.kind === "adoption"
        && adoption.factId === adoptionId && facts.some(exposure => exposure.kind === "exposure" && exposure.factId === adoption.exposureId && exposure.versionId === asset.versionId)));
    });
    if (draft.familyId !== p.familyId && overlaps && (sharedBasis || feedbackLinked || (protectedFamily && conditionsOverlap(draft, p)))) return "family_relabel_rejected";
  }

  return undefined;
}

function conditionsOverlap(a: CollaborationPracticeDraftV2, b: CollaborationPracticeV2): boolean {
  const x = a.conditions, y = b.conditions;
  const overlap = (left: readonly string[], right: readonly string[]) => left.length === 0 || right.length === 0 || left.some(v => right.includes(v));
  return (x.dependency === "any" || y.dependency === "any" || x.dependency === y.dependency)
    && overlap(x.taskFamilies, y.taskFamilies) && overlap(x.roles, y.roles)
    && overlap(x.coordinationModes, y.coordinationModes) && overlap(x.difficulty, y.difficulty);
}
