import { workflowConditionKey, workflowFamilyKey } from "../domain/family.js";
import type { WorkflowImprovement, WorkflowOpportunity } from "../improvement/contracts.js";
import { workflowProcessKey } from "../improvement/index.js";

export function workflowImprovementLineage(opportunity: WorkflowOpportunity): string {
  return JSON.stringify([opportunity.task.scope, opportunity.task.process === undefined ? workflowFamilyKey(opportunity.task.taskFamily) : workflowProcessKey(opportunity.task.process),
    opportunity.issueKey, workflowConditionKey(opportunity.task.conditions)]);
}

export function latestWorkflowImprovement<T extends { readonly versionId: string; readonly artifact: WorkflowImprovement; readonly status: "eligible" | "blocked" | "unsettled" }>(
  versions: readonly T[], opportunity: WorkflowOpportunity): T | undefined {
  const lineage = workflowImprovementLineage(opportunity);
  return [...versions].reverse().find(item => item.status !== "unsettled" && workflowImprovementLineage(item.artifact.opportunity) === lineage);
}

/** A pending correction is a floor even if its researcher failed before publishing. */
export function workflowCorrectionAllows(
  versions: readonly { readonly versionId: string; readonly artifact: WorkflowImprovement }[],
  opportunities: readonly { readonly record: { readonly opportunity: WorkflowOpportunity } }[],
  opportunity: WorkflowOpportunity, parentVersionId?: string,
): boolean {
  const lineage = workflowImprovementLineage(opportunity);
  const floor = [...opportunities].reverse().find(item => item.record.opportunity.trigger === "user_correction"
    && workflowImprovementLineage(item.record.opportunity) === lineage)?.record.opportunity;
  if (floor === undefined || floor.opportunityId === opportunity.opportunityId) return true;

  const seen = new Set<string>();
  let current = versions.find(item => item.versionId === parentVersionId);

  while (current !== undefined && !seen.has(current.versionId)) {
    seen.add(current.versionId);
    if (current.artifact.opportunity.opportunityId === floor.opportunityId) return true;
    current = versions.find(item => item.versionId === current!.artifact.parentVersionId);
  }

  return false;
}
