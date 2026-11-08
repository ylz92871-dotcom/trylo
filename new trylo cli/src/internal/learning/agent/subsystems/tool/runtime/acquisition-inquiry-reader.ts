import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import { acquisitionInquiryJobId, acquisitionInquiryOutcomeId, acquisitionInquirySpecId, decodeAcquisitionInquiryOutcome, decodeAcquisitionInquirySpec } from "../domain/evolution/acquisition-inquiry.js";
import { toolLearningDecisionVersionId } from "../domain/evolution/decision-identity.js";
import { recordOf } from "../domain/evolution/parse.js";
import { toolAcquisitionFromBoard } from "./acquisition-continuation.js";
import { toolAcquisitionFailureFromBoard } from "./acquisition-failure-reader.js";
import { assetAvailable, pipelineFailure } from "./pipeline-assets.js";
import { toolFundingOriginFromBoard } from "./tool-funding-origin.js";

export function acquisitionInquiryBindingFromBoard(state: BoardState, input: { readonly jobId: string; readonly scope: string; readonly approvalId?: string; readonly failureRef: string }) {
  const request = toolAcquisitionFromBoard(state, input.jobId, input.scope);
  if (!request.ok) return request;

  if (input.approvalId !== undefined && request.approvalId !== input.approvalId) return pipelineFailure("approval_plan_mismatch", input.jobId);

  const observed = toolAcquisitionFailureFromBoard(state, input.failureRef, input.scope);
  if (!observed.ok) return observed;

  if (observed.failure.jobId !== input.jobId || observed.failure.attempt !== request.attempt || observed.failure.decisionVersionId !== request.approvalId) {
    return pipelineFailure("acquisition_failure_binding_mismatch", input.failureRef);
  }

  const root = toolFundingOriginFromBoard(state, request.learningPlan);
  if (!root.ok) return root;

  const inquiryJobId = acquisitionInquiryJobId(input.jobId, request.approvalId), child = state.jobs.find(row => row.jobId === inquiryJobId);
  if (child !== undefined && (child.domain !== "tool" || child.scope !== input.scope || child.observationId !== input.jobId || child.maxAttempts !== 3 || child.dedupeKey !== inquiryJobId)) {
    return pipelineFailure("invalid_inquiry_binding", inquiryJobId);
  }

  return { ok: true as const, request, failure: observed.failure, rootPlan: root.rootPlan, rootJobId: root.rootJobId, rootPlanHash: root.rootPlanHash, inquiryJobId, child };
}

export function acquisitionInquirySpecFromBoard(state: BoardState, jobId: string, attempt: number, scope: string) {
  const versionId = acquisitionInquirySpecId(jobId, attempt), asset = state.assets.find(row => row.versionId === versionId);
  if (asset === undefined) return { ok: true as const, spec: undefined };
  const spec = decodeAcquisitionInquirySpec(asset.content);
  if (spec === undefined || spec.jobId !== jobId || spec.attempt !== attempt || spec.scope !== scope || !assetAvailable(state, asset)
    || asset.kind !== "workflow" || asset.source !== "inferred" || asset.scope !== scope || asset.contentHash !== contentHashOf(spec)) return pipelineFailure("invalid_inquiry_spec", versionId);
  return { ok: true as const, spec };
}

export function acquisitionInquiryOutcomeFromBoard(state: BoardState, jobId: string, attempt: number, scope: string) {
  const versionId = acquisitionInquiryOutcomeId(jobId, attempt), asset = state.assets.find(row => row.versionId === versionId);
  if (asset === undefined) return { ok: true as const, outcome: undefined };

  const outcome = decodeAcquisitionInquiryOutcome(asset.content), spec = acquisitionInquirySpecFromBoard(state, jobId, attempt, scope);
  if (!spec.ok) return spec;

  if (outcome === undefined || spec.spec === undefined || outcome.scope !== scope || outcome.jobId !== jobId || outcome.attempt !== attempt
    || !assetAvailable(state, asset) || asset.kind !== "workflow" || asset.source !== "inferred" || asset.scope !== scope || asset.contentHash !== contentHashOf(outcome)) return pipelineFailure("invalid_inquiry_outcome", versionId);

  if (outcome.decision !== undefined) {
    const decision = state.assets.find(row => row.versionId === outcome.planningDecisionVersionId);
    const raw = decision?.content;
    if (decision === undefined || !assetAvailable(state, decision) || decision.kind !== "workflow" || decision.source !== "inferred" || decision.scope !== scope
      || !recordOf(raw) || raw.type !== "tool_learning_decision" || raw.schemaVersion !== 1 || raw.jobId !== jobId || raw.attempt !== attempt || typeof raw.step !== "number"
      || !Number.isSafeInteger(raw.step) || raw.step < 1 || contentHashOf(raw.decision) !== contentHashOf(outcome.decision)
      || decision.contentHash !== contentHashOf(raw)
      || decision.versionId !== toolLearningDecisionVersionId({ jobId, attempt, step: raw.step, decision: outcome.decision })) return pipelineFailure("invalid_inquiry_decision", versionId);
  }

  return { ok: true as const, outcome };
}
