import type { BoardState } from "../../../../control/state.js";
import { COLLABORATION_RESOURCE_LIMITS } from "../../../../../protocol/collaboration-resource.js";
import { isExperienceConditions } from "../experience/parse.js";
import { isCollaborationEvaluation } from "../domain/evaluation.js";
import { collaborationDependencySourceRefs } from "../domain/dependency-evidence.js";
import type { CollaborationAdjustment, CapabilityNeed, CollaborationPlan, ExperienceDraft, LearningAction } from "./contracts.js";

type Row = Record<string, unknown>;

const row = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, n: number): v is string => typeof v === "string" && !!v.trim() && v.length <= n && !v.includes("\0");
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const refs = (v: unknown, minimum = 0): v is string[] => Array.isArray(v) && v.length >= minimum && v.length <= 32 && v.every(x => text(x, 512));
const selection = (v: unknown): boolean => row(v) && (text(v.expertId, 512) && (v.version === undefined || positiveInteger(v.version))
  && Object.keys(v).every(k => ["expertId", "version"].includes(k)) || text(v.requestId, 512) && Object.keys(v).length === 1);
const adjustment = (v: unknown): v is CollaborationAdjustment => row(v) && text(v.memberId, 200)
  && ["division", "handoff", "sharing", "review", "configuration"].includes(String(v.kind)) && text(v.instruction, 1600)
  && (v.expertSelection === undefined || selection(v.expertSelection));
const need = (v: unknown): v is CapabilityNeed => row(v) && (v.owner === "tool" || v.owner === "expert")
  && text(v.memberId, 200) && text(v.instruction, 1600) && (v.expertId === undefined || v.owner === "expert" && text(v.expertId, 512));
const experience = (v: unknown): v is ExperienceDraft => row(v) && text(v.ownerRef, 512) && text(v.familyId, 200)
  && text(v.situation, 240) && refs(v.responsibilities, 1) && text(v.practice, 1200) && refs(v.sourceRefs, 1)
  && (v.parentVersion === undefined || text(v.parentVersion, 512)) && (v.conditions === undefined || isExperienceConditions(v.conditions))
  && (v.evaluation === undefined || isCollaborationEvaluation(v.evaluation))
  && (v.expertVersion === undefined || positiveInteger(v.expertVersion));
const list = <T>(v: unknown, guard: (item: unknown) => item is T, max: number): v is T[] => Array.isArray(v) && v.length <= max && v.every(guard);

export function isLearningAction(v: unknown): v is LearningAction {
  if (!row(v)) return false;

  if (v.kind === "query") return ["tool", "expert", "experience", "research"].includes(String(v.owner)) && text(v.query, COLLABORATION_RESOURCE_LIMITS.queryMaxChars);

  if (v.kind === "no_change") return text(v.reason, 1600) && refs(v.sourceRefs, 1);

  return v.kind === "propose" && text(v.familyId, 200) && text(v.title, 240) && text(v.summary, 2400)
    && refs(v.sourceRefs, 1) && list(v.adjustments, adjustment, 16) && list(v.experiences, experience, 16) && list(v.needs, need, 8)
    && v.adjustments.length + v.experiences.length + v.needs.length > 0
    && (v.evaluation === undefined || isCollaborationEvaluation(v.evaluation));
}

export function isCollaborationPlan(v: unknown): v is CollaborationPlan {
  return row(v) && v.schema === "collaboration-plan/v1" && text(v.issueId, 512) && positiveInteger(v.focusRevision)
    && text(v.familyId, 200) && text(v.title, 240) && text(v.summary, 2400) && refs(v.sourceRefs, 1)
    && list(v.adjustments, adjustment, 16) && refs(v.experienceVersionIds) && list(v.needs, need, 8)
    && (v.evaluation === undefined || isCollaborationEvaluation(v.evaluation));
}

export function collaborationPlanSourcesValid(state: BoardState, scope: string, plan: CollaborationPlan): boolean {
  const issue = state.learningIssues?.find(i => i.issueId === plan.issueId && i.scope === scope);
  if (!issue || plan.focusRevision > issue.revision) return false;

  const known = new Set(issue.reports.flatMap(r => [r.reportId, ...r.evidenceRefs]));

  for (const ref of collaborationDependencySourceRefs(state, { scope, issueId: plan.issueId, focusRevision: plan.focusRevision })) known.add(ref);

  for (const receipt of state.collaborationRuntimeReceipts ?? []) {
    if (receipt.phase === "resource_result" && receipt.scope === scope && receipt.issueId === plan.issueId) {
      known.add(receipt.receiptId);
      for (const ref of receipt.resultRefs) known.add(ref);
    }
  }

  return plan.sourceRefs.every(ref => known.has(ref)) && plan.experienceVersionIds.every(ref => state.assets.some(a => a.scope === scope && a.versionId === ref));
}

export function collaborationPlanPublicationValid(state: BoardState, scope: string, plan: CollaborationPlan): boolean {
  const issue = state.learningIssues?.find(i => i.issueId === plan.issueId && i.scope === scope);
  return issue?.decision.kind === "focused_learning" && issue.decision.revision === plan.focusRevision
    && collaborationPlanSourcesValid(state, scope, plan);
}
