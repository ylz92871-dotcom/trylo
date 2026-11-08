import type { WorkflowImprovementRuntimeOptions, WorkflowImprovementOpportunityRecord } from "./improvement-contracts.js";
import { latestWorkflowImprovement, workflowImprovementHistory } from "./improvement-selection.js";
import { workflowCorrectionAllows } from "./improvement-lineage.js";
import { parseWorkflowImprovementEvidence, workflowImprovementEditScope } from "../improvement/index.js";
import type { WorkflowImprovementEvidence } from "../improvement/contracts.js";
import { workflowFailure } from "../domain/trace-parse.js";
import { projectWorkflowImprovementFeedback } from "./improvement-feedback-evidence.js";
import { workflowImprovementRecordId } from "./improvement-identities.js";

/** Freeze the research context before spending; historical observations retain their source versions. */
export async function prepareWorkflowImprovement(options: Pick<WorkflowImprovementRuntimeOptions, "store">, record: WorkflowImprovementOpportunityRecord) {
  const view = await options.store.read();
  if (!view.ok) return view;

  if (!view.value.opportunities.some(item => item.versionId === workflowImprovementRecordId(record))) {
    return workflowFailure("workflow_improvement_source_unavailable", "The saved research input is no longer available for provider dispatch");
  }

  const parent = latestWorkflowImprovement(view.value.versions, record.opportunity);
  if (parent?.versionId !== record.parentVersionId) return workflowFailure("workflow_improvement_stale_parent", "A newer problem revision owns this lineage");

  if (record.opportunity.affectedStepIds !== undefined) {
    const edit = workflowImprovementEditScope(parent?.artifact, record.opportunity.affectedStepIds);
    if (!edit.ok) return edit;
  }

  if (!workflowCorrectionAllows(view.value.versions, view.value.opportunities, record.opportunity, record.parentVersionId)) {
    return workflowFailure("workflow_correction_pending", "A later user correction must be incorporated before older research");
  }

  const history = workflowImprovementHistory(view.value, record.opportunity);
  const byRef = new Map<string, WorkflowImprovementEvidence>();
  const feedbackEvidence = projectWorkflowImprovementFeedback(history.feedback);
  if (!feedbackEvidence.ok) return feedbackEvidence;

  for (const item of [...record.evidence, ...feedbackEvidence.value]) {
    const previous = byRef.get(item.ref);
    if (previous !== undefined && (previous.kind !== item.kind || previous.summary !== item.summary || previous.executionId !== item.executionId)) {
      return workflowFailure("improvement_evidence_conflict", "A feedback reference cannot change its observed meaning");
    }
    if (previous === undefined) byRef.set(item.ref, item);
  }

  const evidence = parseWorkflowImprovementEvidence([...byRef.values()]);

  return evidence.ok ? { ok: true as const, value: { view: view.value, parent, ...history, evidence: evidence.value } } : evidence;
}
