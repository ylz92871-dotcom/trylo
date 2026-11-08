import type { BoardStore } from "../../../../control/store-port.js";
import { toolLearningJobId, type ToolLearningPlan } from "../domain/evolution/pipeline.js";
import { acquisitionInquiryOutcomeId, acquisitionInquirySpecId, decodeAcquisitionInquiryOutcome, type AcquisitionInquiryOutcome, type AcquisitionInquirySpec } from "../domain/evolution/acquisition-inquiry.js";
import { toolLearningDecisionVersionId } from "../domain/evolution/decision-identity.js";
import type { ToolLearningDecision } from "../domain/evolution/learning-plan.js";
import type { ToolDiscoverySummary } from "../domain/evolution/discovery.js";
import { pipelineFailure, savePipelineAsset } from "./pipeline-assets.js";
import { acquisitionInquiryOutcomeFromBoard } from "./acquisition-inquiry-reader.js";
import { materializeAcquisitionInquiryReview } from "./acquisition-inquiry-materialize.js";
import { toolAcquisitionChoiceStillBlocked, type ToolAcquisitionFailure } from "../domain/evolution/acquisition-failure.js";

export function proposedAcquisitionInquiryOutcome(input: { readonly spec: AcquisitionInquirySpec; readonly plan: ToolLearningPlan;
  readonly decision: ToolLearningDecision; readonly decisionVersionId: string; readonly search: ToolDiscoverySummary; readonly occurredAt: string; readonly failure: ToolAcquisitionFailure }) {
  const { spec } = input, rootOrigin = { rootJobId: spec.rootJobId, rootPlanHash: spec.rootPlanHash, inquiryJobId: spec.jobId,
    inquiryAttempt: spec.attempt, outcomeVersionId: acquisitionInquiryOutcomeId(spec.jobId, spec.attempt) };

  if (input.decision.action === "acquire" && toolAcquisitionChoiceStillBlocked(input.failure, input.decision.candidate)) {
    return decodeAcquisitionInquiryOutcome({ type: "tool_acquisition_inquiry_result", schemaVersion: 1, jobId: spec.jobId, attempt: spec.attempt,
      specVersionId: acquisitionInquirySpecId(spec.jobId, spec.attempt), scope: spec.scope, status: "waiting_evidence", code: "same_candidate_unresolved",
      planningDecisionVersionId: input.decisionVersionId, decision: input.decision, search: input.search });
  }

  const plan: ToolLearningPlan = { ...input.plan, createdAt: input.occurredAt,
    trigger: { ...input.plan.trigger, proposalKey: `acquisition-review:${spec.jobId}:${spec.attempt}`,
      evidenceRefs: [...new Set([...input.plan.trigger.evidenceRefs, spec.failureRef, input.decisionVersionId])] }, fundingOrigin: rootOrigin };
  const reviewJobId = toolLearningJobId(plan);

  return decodeAcquisitionInquiryOutcome({ type: "tool_acquisition_inquiry_result", schemaVersion: 1, jobId: spec.jobId, attempt: spec.attempt,
    specVersionId: acquisitionInquirySpecId(spec.jobId, spec.attempt), scope: spec.scope, status: "proposed", code: "inquiry_proposal_pending_review",
    planningDecisionVersionId: input.decisionVersionId, decision: input.decision, search: input.search,
    ...(input.decision.action !== "acquire" ? {} : { review: { plan, jobId: reviewJobId,
      decisionVersionId: toolLearningDecisionVersionId({ jobId: reviewJobId, attempt: 1, step: 1, decision: input.decision }) } }) });
}

/** Outcome first, then the recoverable standard review envelope, then terminal child state. */
export async function finishAcquisitionInquiry(store: BoardStore, outcome: AcquisitionInquiryOutcome, issuedAt: string) {
  if (decodeAcquisitionInquiryOutcome(outcome) === undefined) return pipelineFailure("invalid_inquiry_outcome", outcome.jobId);

  const loaded = await store.load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

  const prior = acquisitionInquiryOutcomeFromBoard(loaded.state, outcome.jobId, outcome.attempt, outcome.scope);
  if (!prior.ok) return prior;

  const child = loaded.state.jobs.find(row => row.jobId === outcome.jobId);

  if (prior.outcome === undefined) {
    if (child?.state !== "running" || child.attempt !== outcome.attempt) return pipelineFailure("stale_job_result", outcome.jobId);
    const saved = await savePipelineAsset(store, { versionId: acquisitionInquiryOutcomeId(outcome.jobId, outcome.attempt), kind: "workflow", source: "inferred", scope: outcome.scope,
      content: outcome, issuedAt, observations: [outcome.specVersionId] });
    if (!saved.ok) return saved;
  }

  const frozen = prior.outcome ?? outcome;
  const materialized = await materializeAcquisitionInquiryReview(store, frozen, issuedAt);
  if (!materialized.ok) return materialized;

  const fresh = await store.load();
  if (!fresh.ok) return pipelineFailure(fresh.reason, fresh.detail);

  const current = fresh.state.jobs.find(row => row.jobId === outcome.jobId);
  if (current?.state === "running" && current.attempt === outcome.attempt) {
    const ended = await store.apply({ type: "complete_job", commandId: `${outcome.jobId}:terminal:${outcome.attempt}`, issuedAt, jobId: outcome.jobId,
      next: frozen.status === "proposed" ? "waiting_approval" : "waiting_evidence" });
    if (!ended.ok) return pipelineFailure(ended.reason, ended.detail);
  }

  return { ok: true as const, inquiryJobId: outcome.jobId, attempt: outcome.attempt, code: frozen.code, status: frozen.status,
    ...("reviewJobId" in materialized ? { reviewJobId: materialized.reviewJobId, approvalId: materialized.approvalId } : {}),
    next: frozen.review !== undefined ? "review_new_decision" as const : "wait_for_new_evidence" as const };
}
