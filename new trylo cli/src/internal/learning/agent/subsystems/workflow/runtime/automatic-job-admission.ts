import { contentHashOf } from "../../../../control/hash.js";
import type { LearningJob } from "../../../../control/contracts.js";
import type { WorkflowLearningResult } from "../domain/trace-contracts.js";
import { workflowFailure } from "../domain/trace-parse.js";
import { workflowJobPremises, workflowTerminalRetryId, type WorkflowAutomaticInput } from "./automatic-job-contracts.js";

type AdmissionReads = {
  job(id: string): LearningJob | undefined;
  input(id: string, attempt: number): WorkflowLearningResult<WorkflowAutomaticInput>;
  receipt(id: string, attempt: number): WorkflowLearningResult<{ readonly nextState: string } | null>;
  grant(input: WorkflowAutomaticInput, attempt: number): WorkflowLearningResult<null>;
};

/** One admission rule for writes, claims and paid-result reads. All reads use one Board snapshot. */
export function admitWorkflowJobAttempt(input: WorkflowAutomaticInput, attempt: number, reads: AdmissionReads): WorkflowLearningResult<null> {
  const visited = new Set<string>();
  let current = input, ordinal = attempt;

  while (true) {
    const key = JSON.stringify([current.jobId, ordinal]);
    if (visited.has(key)) return workflowFailure("invalid_job_retry", "cyclic retry provenance");

    visited.add(key);
    const funded = reads.grant(current, ordinal);
    if (!funded.ok) return funded;

    if (ordinal > 1) {
      const previous = reads.input(current.jobId, ordinal - 1);
      if (!previous.ok) return previous;

      const receipt = reads.receipt(current.jobId, ordinal - 1);
      if (!receipt.ok) return receipt;

      if (receipt.value?.nextState !== "waiting_evidence"
        || contentHashOf({ ...previous.value, allowance: current.allowance }) !== contentHashOf(current)) {
        return workflowFailure("invalid_job_retry", "a same-job retry needs waiting evidence and unchanged input except its fresh allowance");
      }

      current = previous.value;
      ordinal -= 1;
      continue;
    }

    const parent = current.retryOf;
    if (parent === undefined) return { ok: true, value: null };

    const job = reads.job(parent.jobId);
    if (job === undefined || job.attempt !== parent.attempt || current.allowance.maxCalls === 0
      || !["succeeded", "failed", "cancelled", "expired"].includes(job.state)
      || current.jobId !== workflowTerminalRetryId(parent.jobId, parent.attempt, current.allowance.grantId)) {
      return workflowFailure("invalid_job_retry", "a terminal retry needs its exact parent and canonical creation-grant identity");
    }

    const previous = reads.input(parent.jobId, parent.attempt);
    if (!previous.ok) return previous;

    if (contentHashOf(workflowJobPremises(previous.value)) !== contentHashOf(workflowJobPremises(current))) {
      return workflowFailure("invalid_job_retry", "retry scope, task, session, turn and source evidence cannot drift");
    }

    current = previous.value;
    ordinal = parent.attempt;
  }
}
