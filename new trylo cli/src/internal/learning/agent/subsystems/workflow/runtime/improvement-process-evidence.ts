import type { WorkflowImprovement, WorkflowImprovementFeedback } from "../improvement/contracts.js";
import type { WorkflowImprovementReceipt } from "./improvement-contracts.js";
import { workflowFailure } from "../domain/trace-parse.js";
import { workflowProcessEvidenceFits } from "../improvement/validation.js";

/** The host checker owns path semantics; the runtime binds its claim to this use's actual receipts and frozen nodes. */
export function bindWorkflowProcessEvidence(feedback: WorkflowImprovementFeedback, artifact: WorkflowImprovement,
  receipts: readonly WorkflowImprovementReceipt[]) {
  const observed = feedback.processEvidence;
  if (observed === undefined || observed.kind === "unverified") return { ok: true as const, value: feedback };

  const byRef = new Map(receipts.map(item => [item.ref, item]));
  if (observed.evidenceRefs.some(ref => byRef.get(ref)?.executionId !== feedback.executionId)) {
    return workflowFailure("workflow_process_evidence_unbound", "Process evidence must bind post-adoption receipts from this actual execution");
  }

  if (!workflowProcessEvidenceFits(artifact, observed)) {
    return workflowFailure("workflow_process_evidence_unbound", "Whole-process evidence must independently account for every frozen step, including actual untaken branches");
  }

  return { ok: true as const, value: feedback };
}
