import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import { toolLearningDecisionVersionId } from "../domain/evolution/decision-identity.js";
import { recordOf } from "../domain/evolution/parse.js";
import { assetAvailable, pipelineFailure } from "./pipeline-assets.js";
import { planForJob, resultForJob } from "./pipeline-records.js";

/** Historical decision facts carry no ability to execute. The active acquisition reader adds job-state gates. */
export function toolAcquisitionDecisionFromBoard(state: BoardState, jobId: string, scope: string, attempt?: number) {
  const job = state.jobs.find(item => item.jobId === jobId), plan = planForJob(state, jobId);
  const result = job === undefined ? undefined : resultForJob(state, jobId, attempt ?? job.attempt);
  if (job === undefined || job.scope !== scope || plan?.scope !== scope || result?.decision?.action !== "acquire" || result.decisionVersionId === undefined) {
    return pipelineFailure("acquisition_request_not_found", jobId);
  }

  const decision = result.decision, approvalId = result.decisionVersionId, frozen = state.assets.find(asset => asset.versionId === approvalId);

  // Match the stored decision, content hash and attempt before resolving its candidate.
  if (frozen === undefined || !assetAvailable(state, frozen) || frozen.kind !== "workflow" || frozen.source !== "inferred" || frozen.scope !== scope || frozen.contentHash !== contentHashOf(frozen.content) || !recordOf(frozen.content)
    || frozen.content.type !== "tool_learning_decision" || frozen.content.schemaVersion !== 1 || frozen.content.jobId !== jobId || frozen.content.attempt !== result.attempt
    || contentHashOf(frozen.content.decision) !== contentHashOf(decision)
    || frozen.content.step !== undefined && (!Number.isSafeInteger(frozen.content.step) || typeof frozen.content.step !== "number" || frozen.content.step < 1)
    || approvalId !== toolLearningDecisionVersionId({ jobId, attempt: result.attempt, decision,
      ...(frozen.content.step === undefined ? {} : { step: frozen.content.step }) })) return pipelineFailure("acquisition_decision_binding_mismatch", jobId);

  const chosen = result.search.candidates.find(candidate => candidate.platform === decision.candidate.platform
    && candidate.id === decision.candidate.id && candidate.version === decision.candidate.version);
  if (chosen === undefined) return pipelineFailure("acquisition_candidate_missing", jobId);

  return { ok: true as const, jobId, scope, capability: plan.capability, approvalId, decision, chosen, search: result.search, learningPlan: plan, attempt: result.attempt };
}
