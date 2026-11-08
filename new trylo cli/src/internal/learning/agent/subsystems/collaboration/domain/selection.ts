import type { BoardState } from "../../../../control/state.js";
import { isCollaborationPractice } from "./parse.js";
import { practiceSourcesValid } from "./practice.js";
import type { CollaborationContext, CollaborationCorrection, CollaborationFact, CollaborationPractice, CollaborationSelection, HandoffField } from "./contracts.js";

export function correctionApplies(correction: CollaborationCorrection, context: CollaborationContext): boolean {
  if (correction.scope !== context.scope) return false;
  switch (correction.appliesTo.kind) {
    case "once": return correction.appliesTo.taskId === context.taskId;
    case "class": return correction.appliesTo.dependency === context.dependency && correction.appliesTo.role === context.role;
    case "longterm": return true;
  }
}

/** No prompt keyword matching: transfer requires the actual dependency precondition. */
export function selectPractice(state: BoardState, context: CollaborationContext, maxPromptChars: number): CollaborationSelection {
  if (context.dependency !== "artifact") return { kind: "skip", reason: "dependency_not_applicable" };

  const facts = state.collaborationFacts ?? [];
  const candidates = state.assets.filter(asset => asset.scope === context.scope && isCollaborationPractice(asset.content)
    && state.proposals.some(proposal => proposal.proposalId === asset.createdFromProposalId
      && proposal.domain === "collaboration" && proposal.lifecycle === "evaluating")
    && !state.tombstones.some(item => item.entityId === asset.versionId || item.entityId === asset.createdFromProposalId));
  let skipped = "no_applicable_practice";

  for (const asset of candidates.slice().reverse()) {
    if (!isCollaborationPractice(asset.content) || asset.createdFromProposalId === undefined) continue;

    const practice = asset.content;
    if (!practiceSourcesValid(state, practice, context.scope)) continue;

    const corrections = facts.filter((fact): fact is CollaborationCorrection => fact.kind === "correction"
      && state.assets.some(target => target.versionId === fact.targetVersionId && target.scope === asset.scope
        && isCollaborationPractice(target.content) && target.content.problem === practice.problem)
      && correctionApplies(fact, context));
    if (corrections.some(item => item.action === "skip")) {
      skipped = "explicit_correction";
      continue;
    }

    if (hasCoordinationFailure(state, asset.versionId, practice)) {
      skipped = "negative_feedback";
      continue;
    }

    const fields = new Set<HandoffField>(practice.requiredFields);

    if (corrections.some(item => item.action === "require_evidence")) fields.add("evidence");

    const guidance = compileGuidance([...fields]);
    if (guidance.length > maxPromptChars) {
      skipped = "prompt_budget_exceeded";
      continue;
    }

    return { kind: "selected", versionId: asset.versionId, proposalId: asset.createdFromProposalId, guidance, context,
      correctionIds: corrections.map(item => item.factId) };
  }

  return { kind: "skip", reason: skipped };
}

function hasCoordinationFailure(state: BoardState, versionId: string, practice: CollaborationPractice): boolean {
  const facts = state.collaborationFacts ?? [];
  const asset = state.assets.find(item => item.versionId === versionId);
  const exposures = facts.filter((fact): fact is Extract<CollaborationFact, { kind: "fielding" }> =>
    fact.kind === "fielding" && fact.scope === asset?.scope);

  return facts.some(fact => fact.kind === "outcome" && fact.result.source !== "member_report" && fact.result.check === "failed"
    && fact.result.capability === "sufficient" && fact.result.reworkCount > 0 && fact.result.missingFields.length > 0
    && exposures.some(exposure => exposure.factId === fact.fieldingId && (exposure.versionId === versionId
      || fact.result.missingFields.some(field => !practice.requiredFields.includes(field)))));
}

export function compileGuidance(fields: readonly HandoffField[]): string {
  const labels: Record<HandoffField, string> = {
    artifacts: "可定位的产物路径和版本", evidence: "独立验收依据与尚未验证之处",
    pending: "尚待完成的事项和接手分工", blockers: "已知阻塞与需要同步的条件",
  };
  return `协作学习试用：本轮已声明依赖产物，适用前提已经成立。即使未收到交接包，也须在开始依赖工作前核对${fields.map(field => labels[field]).join("、")}。缺失时先向交接者索取并等待所需信息；收到前不猜测、不按默认值制作依赖产物、不重复制作已有产物。已有证据仍须按原验收标准独立复核；本建议不改变成员分工、权限或执行状态。`;
}
