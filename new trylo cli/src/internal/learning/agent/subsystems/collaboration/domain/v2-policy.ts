import { contentHashOf } from "../../../../control/hash.js";
import type { BoardState } from "../../../../control/state.js";
import type { CollaborationAudience, CollaborationCorrectionV2, CollaborationPracticeV2, CollaborationSelectionV2, CollaborationV2Context, CollaborationV2Fact } from "./v2-contracts.js";
import { isCollaborationPracticeV2 } from "./v2-parse.js";
import { collaborationEvidenceClosureV2 } from "./v2-evidence.js";

export function practiceV2SourcesValid(state: BoardState, scope: string, practice: CollaborationPracticeV2): boolean {
  const facts = state.collaborationV2Facts ?? [];
  const { schema: _schema, status: _status, sourceWindowHash: _hash, cycleId: _cycle, ...draft } = practice;

  if (!facts.some(f => f.kind === "analysis" && f.cycleId === practice.cycleId && f.scope === scope
    && f.sourceWindowHash === practice.sourceWindowHash && f.result.status === "proposed"
    && f.result.proposals.some(proposed => contentHashOf(proposed) === contentHashOf(draft)))) return false;

  if (!practice.sourceEventIds.every(id => facts.some(f => f.kind === "event" && f.factId === id && f.scope === scope))
    || !practice.sourceEpisodeIds.every(id => facts.some(f => f.kind === "episode" && f.factId === id && f.scope === scope))
    || !practice.sourceOutcomeIds.every(id => facts.some(f => f.kind === "outcome" && f.factId === id && f.scope === scope))) return false;

  const closure = collaborationEvidenceClosureV2(facts.filter(f => f.scope === scope), [...practice.sourceEventIds, ...practice.sourceEpisodeIds, ...practice.sourceOutcomeIds]);
  if (!closure.some(f => f.kind === "event" && f.source !== "peer_report")) return false;

  const refs = new Set(closure.filter(f => f.kind === "event" || f.kind === "episode" || f.kind === "outcome").map(f => f.factId));

  return practice.alternatives.every(item => item.evidenceRefs.every(ref => refs.has(ref)))
    && (practice.parentVersionId === undefined || state.assets.some(asset => asset.versionId === practice.parentVersionId
      && asset.scope === scope && isCollaborationPracticeV2(asset.content) && asset.content.familyId === practice.familyId));
}

export function v2ConditionMatches(practice: CollaborationPracticeV2, context: CollaborationV2Context): boolean {
  const c = practice.conditions;
  return (c.dependency === "any" || c.dependency === context.dependency)
    && (c.taskFamilies.length === 0 || c.taskFamilies.includes(context.taskFamily))
    && (c.roles.length === 0 || c.roles.includes(context.role))
    && (c.coordinationModes.length === 0 || c.coordinationModes.includes(context.coordinationMode))
    && (c.difficulty.length === 0 || c.difficulty.includes(context.difficulty)) && context.members.length >= c.minimumMembers;
}

export function selectCollaborationActionsV2(state: BoardState, context: CollaborationV2Context,
  audience: CollaborationAudience, maxPromptChars: number): CollaborationSelectionV2 {
  const candidates = liveCollaborationVersionsV2(state, context.scope);
  let reason = "no_applicable_practice";

  for (const asset of candidates.slice().reverse()) {
    if (!isCollaborationPracticeV2(asset.content) || asset.createdFromProposalId === undefined) continue;

    const practice = asset.content;
    if (!practiceV2SourcesValid(state, context.scope, practice)) continue;

    if (!v2ConditionMatches(practice, context)) {
      reason = "conditions_not_met";
      continue;
    }

    if (isSuspended(state.collaborationV2Facts ?? [], practice.familyId, context)) {
      reason = "explicit_correction";
      continue;
    }

    if (hasNegativeOutcome(state.collaborationV2Facts ?? [], asset.versionId)) {
      reason = "negative_outcome";
      continue;
    }

    const actions = practice.actions.filter(action => action.audience === audience);
    if (actions.length === 0) continue;

    const instructions = actions.map(action => `[learning_action_id=${action.actionId}; operation=${action.operation}] ${action.instruction}`).join("\n");
    const premise = context.dependency === "artifact" ? "本轮已声明依赖产物；交接包缺失不会使这项前提消失。" : "";
    const guidance = `协作学习试用：本轮上下文（unknown 表示未知，不能用来证明已知条件）：依赖=${context.dependency}；任务族=${context.taskFamily}；配合方式=${context.coordinationMode}；成员数=${context.members.length}。${premise}\n${instructions}\n当前用户明令优先；试用建议可因实际条件不符而忽略并反馈。采用某项做法时，在对应的原有协作操作中带上该 learning_action_id；只报告意图不算执行。现有权限、冻结成员及执行状态仍由原设施负责。`;
    if (guidance.length > maxPromptChars) {
      reason = "prompt_budget_exceeded";
      continue;
    }

    const contentHash = contentHashOf(guidance);
    const selectionId = `collaboration-selection:${contentHashOf({ versionId: asset.versionId, context, audience, contentHash })}`;

    return { kind: "selected", selectionId, versionId: asset.versionId, proposalId: asset.createdFromProposalId,
      familyId: practice.familyId, actions, guidance, contentHash, context, audience };
  }

  return { kind: "skip", reason };
}

/** Canonical visibility policy shared by runtime selection and user-facing status. */
export function liveCollaborationVersionsV2(state: BoardState, scope: string) {
  const newest = new Map<string, typeof state.assets[number]>();
  for (const asset of state.assets) if (asset.scope === scope && isCollaborationPracticeV2(asset.content)
    && state.proposals.some(p => p.proposalId === asset.createdFromProposalId && p.domain === "collaboration" && p.lifecycle === "evaluating")
    && !state.tombstones.some(t => t.entityId === asset.versionId || t.entityId === asset.createdFromProposalId)) newest.set(asset.content.familyId, asset);
  return [...newest.values()];
}

function isSuspended(facts: readonly CollaborationV2Fact[], familyId: string, context: CollaborationV2Context): boolean {
  return effectiveCollaborationCorrectionsV2(facts, context.scope, familyId).some(f =>
    (f.appliesTo.kind === "workspace" || (f.appliesTo.kind === "once" && f.appliesTo.taskId === context.taskId)
      || (f.appliesTo.kind === "class" && f.appliesTo.taskFamily === context.taskFamily && f.appliesTo.role === context.role)));
}

/** Effective explicit governance; applicability to a task is evaluated separately. */
export function effectiveCollaborationCorrectionsV2(facts: readonly CollaborationV2Fact[], scope: string, familyId: string): readonly CollaborationCorrectionV2[] {
  return facts.filter((f): f is CollaborationCorrectionV2 => f.kind === "correction" && f.scope === scope && f.familyId === familyId && f.action === "suspend")
    .filter(f => !facts.some(next => next.kind === "correction" && next.scope === scope && next.familyId === familyId
      && next.action === "restore" && next.replacesCorrectionId === f.factId));
}

function hasNegativeOutcome(facts: readonly CollaborationV2Fact[], versionId: string): boolean {
  const exposures = new Set(facts.filter(f => f.kind === "exposure" && f.versionId === versionId).map(f => f.factId));
  const adopted = new Set(facts.filter(f => f.kind === "adoption" && exposures.has(f.exposureId)).map(f => f.factId));
  return facts.some(f => f.kind === "outcome" && (f.source === "external_checker" || f.source === "user")
    && f.adoptionIds.some(id => adopted.has(id)) && f.metrics.delivery === "failed");
}
