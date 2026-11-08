import type { WorkflowLearningResult } from "../domain/trace-contracts.js";
import { workflowFailure } from "../domain/trace-parse.js";
import type { WorkflowImprovement, WorkflowImprovementEvidence, WorkflowImprovementProposal, WorkflowOpportunity } from "./contracts.js";
import { parseWorkflowImprovement } from "./parse.js";
import { validateImprovementRevision, workflowProcessMatches } from "./validation.js";
import { validateWorkflowScopedRevision, workflowImprovementEditScope } from "./scoped-edit.js";

/** The worker may invent better actions; it may not invent evidence or proven benefit. */
export function buildWorkflowImprovement(input: {
  readonly opportunity: WorkflowOpportunity;
  readonly evidence: readonly WorkflowImprovementEvidence[];
  readonly proposal: WorkflowImprovementProposal;
  readonly parentVersionId?: string;
  readonly parent?: WorkflowImprovement;
  readonly history?: readonly { readonly versionId: string; readonly artifact: WorkflowImprovement }[];
}): WorkflowLearningResult<WorkflowImprovement> {
  if ((input.parent === undefined) !== (input.parentVersionId === undefined)) {
    return workflowFailure("improvement_parent_missing", "a revision needs both the immutable parent and its version identity");
  }

  if (input.opportunity.affectedStepIds !== undefined) {
    const scope = workflowImprovementEditScope(input.parent, input.opportunity.affectedStepIds);
    if (!scope.ok) return scope;
  }

  const sources = [...(input.history ?? []), ...(input.parent === undefined ? [] : [{ versionId: input.parentVersionId!, artifact: input.parent }])]
    .filter(item => workflowProcessMatches(item.artifact.opportunity.task, input.opportunity.task));
  const available = new Map<string, WorkflowImprovementEvidence>();
  const historical = sources.flatMap(item => item.artifact.evidence.map(fact => ({ ...fact, sourceVersionId: fact.sourceVersionId ?? item.versionId })));

  for (const fact of [...historical, ...input.evidence]) {
    const previous = available.get(fact.ref);
    if (previous !== undefined && (previous.kind !== fact.kind || previous.summary !== fact.summary || previous.executionId !== fact.executionId)) {
      return workflowFailure("improvement_evidence_conflict", "an immutable evidence reference cannot change its observed meaning");
    }
    if (previous === undefined) available.set(fact.ref, fact);
  }

  const referenced = new Set([...input.opportunity.evidenceRefs, ...input.proposal.diagnosis.supportingRefs,
    ...input.proposal.diagnosis.counterEvidenceRefs, ...input.proposal.changes.flatMap(change => change.evidenceRefs)]);
  const evidence = [...available.values()].filter(fact => referenced.has(fact.ref));
  const parsed = parseWorkflowImprovement({ schemaVersion: 1, type: "workflow_improvement", claim: "proposed_improvement",
    opportunity: input.opportunity, proposal: input.proposal, evidence,
    ...(input.parentVersionId === undefined ? {} : { parentVersionId: input.parentVersionId }) });
  if (!parsed.ok) return parsed;

  if (parsed.value.opportunity.affectedStepIds !== undefined) {
    const scoped = validateWorkflowScopedRevision(parsed.value.proposal, input.parent!, parsed.value.opportunity.affectedStepIds);
    if (!scoped.ok) return scoped;
  }

  return input.parent === undefined ? parsed : validateImprovementRevision(parsed.value, input.parent);
}
