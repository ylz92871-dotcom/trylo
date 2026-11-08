import type { WorkflowOpportunity, WorkflowProcessTask, WorkflowImprovementReputation } from "../improvement/contracts.js";
import { improvementApplies, workflowImprovementReputation, workflowProcessMatches } from "../improvement/index.js";
import type { WorkflowImprovementBoardView } from "./improvement-contracts.js";
import { workflowImprovementLineage, workflowCorrectionAllows } from "./improvement-lineage.js";

export const WORKFLOW_IMPROVEMENT_SELECTION_POLICY = "workflow:lineage-condition-reputation-selector:v1";

export { latestWorkflowImprovement, workflowImprovementLineage } from "./improvement-lineage.js";

export function workflowImprovementHeads(view: WorkflowImprovementBoardView) {
  const heads = new Map<string, WorkflowImprovementBoardView["versions"][number]>();
  for (const item of view.versions) if (item.status !== "unsettled") heads.set(workflowImprovementLineage(item.artifact.opportunity), item);
  return [...heads.values()];
}

export function selectWorkflowImprovement(view: WorkflowImprovementBoardView, task: WorkflowProcessTask,
  selection: { readonly versionId?: string; readonly issueKey?: string }) {
  const candidates = workflowImprovementHeads(view).flatMap((head, order) => {
    if (selection.issueKey !== undefined && head.artifact.opportunity.issueKey !== selection.issueKey) return [];

    if (!workflowProcessMatches(head.artifact.opportunity.task, task) || !improvementApplies(head.artifact, task)) return [];

    let current: typeof head | undefined = head;
    const seen = new Set<string>();

    while (current !== undefined && !seen.has(current.versionId)) {
      seen.add(current.versionId);

      if (!workflowCorrectionAllows(view.versions, view.opportunities, current.artifact.opportunity, current.artifact.parentVersionId)) return [];

      const reputation = workflowImprovementReputation(current.artifact, view.feedback, current.versionId, task);
      const reliableAncestor = current.versionId === head.versionId || reputation.processQualityPasses > 0 || reputation.standing === "user_supported";
      if (current.status === "eligible" && improvementApplies(current.artifact, task) && reputation.standing !== "needs_revision" && reliableAncestor) {
        return selection.versionId !== undefined && selection.versionId !== current.versionId ? []
          : [{ ...current, reputation, order, ...(current.versionId === head.versionId ? {} : { fallbackFromVersionId: head.versionId }) }];
      }

      const parentId: string | undefined = current.artifact.parentVersionId;

      current = view.versions.find(item => item.versionId === parentId
        && workflowImprovementLineage(item.artifact.opportunity) === workflowImprovementLineage(head.artifact.opportunity));
    }

    return [];
  });
  return candidates.sort((left, right) => reputationPriority(right.reputation) - reputationPriority(left.reputation) || right.order - left.order)[0];
}

function reputationPriority(reputation: WorkflowImprovementReputation): number {
  if (reputation.standing === "supported") return 5;
  if (reputation.standing === "user_supported") return 4;
  if (reputation.processQualityPasses > 0) return 3;
  return reputation.standing === "trial" ? 2 : 1;
}

export function workflowImprovementHistory(view: WorkflowImprovementBoardView, opportunity: WorkflowOpportunity) {
  const history = view.versions.filter(item => workflowProcessMatches(item.artifact.opportunity.task, opportunity.task)
    && (item.artifact.opportunity.issueKey === opportunity.issueKey || view.feedback.some(feedback => feedback.versionId === item.versionId
      && (feedback.quality === "failed" || feedback.userAssessment?.judgment === "harmed"))));
  const ids = new Set(history.map(item => item.versionId));
  return { history: history.slice(-4), feedback: view.feedback.filter(item => ids.has(item.versionId)).slice(-16) };
}
