import type { WorkflowImprovementFeedback, WorkflowImprovementEvidence } from "../improvement/contracts.js";
import { parseWorkflowImprovementEvidence } from "../improvement/index.js";
import { workflowImprovementRecordId } from "./improvement-identities.js";
import { contentHashOf } from "../../../../control/hash.js";

function feedbackSummary(item: WorkflowImprovementFeedback, observation: string): string {
  const proof = item.processEvidence;
  const processObservation = proof === undefined || proof.kind === "unverified" ? { kind: "unverified" as const }
    : { kind: proof.kind, source: "independent_host", checkerRef: proof.checkerRef,
      checkedStepIds: proof.checkedStepIds, skippedStepIds: proof.kind === "complete" ? proof.skippedStepIds : [],
      proofFingerprint: contentHashOf(proof) };
  const facts = { observation, versionId: item.versionId, useId: item.useId, exposure: item.exposure,
    independentQuality: item.quality, userJudgment: item.userAssessment?.judgment ?? "none",
    taskContextFingerprint: contentHashOf(item.task) };
  const full = JSON.stringify({ ...facts, task: item.task, processObservation,
    modelReportedStepIdsAreNotProcessProof: true, selfReportedExplanation: item.explanation.slice(0, 2000),
    explanationAbbreviated: item.explanation.length > 2000 });
  if (full.length <= 4096) return full;

  // Large original task/condition contracts remain in the referenced immutable record, never partially asserted here.
  return JSON.stringify({ ...facts, taskContextAbbreviated: true,
    processObservation: proof === undefined || proof.kind === "unverified" ? { kind: "unverified" }
      : { kind: proof.kind, source: "independent_host", checkedStepCount: proof.checkedStepIds.length,
        skippedStepCount: proof.kind === "complete" ? proof.skippedStepIds.length : 0,
        stepIdsAbbreviated: true, proofFingerprint: contentHashOf(proof) },
    modelReportedStepIdsAreNotProcessProof: true,
    fullTaskAndProcessEvidence: "Retained in the referenced feedback/version; this bounded context does not establish omitted premises.",
    selfReportedExplanation: item.explanation.slice(0, 512), explanationAbbreviated: item.explanation.length > 512 });
}

/** Board feedback is a distinct observation with its real task context, never a fabricated tool receipt. */
export function projectWorkflowImprovementFeedback(feedback: readonly WorkflowImprovementFeedback[], limit = 16) {
  const evidence: WorkflowImprovementEvidence[] = feedback.slice(-Math.min(limit, 16)).map(item => {
    const kind: WorkflowImprovementEvidence["kind"] = item.userAssessment?.judgment === "harmed" ? "user_correction"
      : item.quality === "failed" ? "quality_failure" : "context";
    return { ref: item.feedbackId, kind, executionId: item.executionId,
      sourceVersionId: workflowImprovementRecordId({ type: "workflow_improvement_feedback", schemaVersion: 1, feedback: item }),
      summary: feedbackSummary(item, kind === "user_correction" ? "The operator user judged this adoption harmful; no specific repair is asserted."
          : kind === "quality_failure" ? "Independent host assessment admitted a quality failure; the workflow's causal responsibility remains unproven."
            : "Stored exposure or model report; not a new tool success, independent verdict or causal benefit.") };
  });
  return evidence.length === 0 ? { ok: true as const, value: evidence } : parseWorkflowImprovementEvidence(evidence);
}
