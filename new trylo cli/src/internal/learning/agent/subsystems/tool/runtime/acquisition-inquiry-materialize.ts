import type { BoardStore } from "../../../../control/store-port.js";
import { contentHashOf } from "../../../../control/hash.js";
import { recordOf } from "../domain/evolution/parse.js";
import type { AcquisitionInquiryOutcome } from "../domain/evolution/acquisition-inquiry.js";
import { planVersionId, resultVersionId, toolLearningJobId, validToolPipelineJobs, TOOL_JOB_PREFIX, MAX_TOOL_PIPELINE_JOBS } from "../domain/evolution/pipeline.js";
import { toolLearningDecisionVersionId } from "../domain/evolution/decision-identity.js";
import { toolLearningFundingIdentity } from "../domain/evolution/funding-identity.js";
import { pipelineFailure, savePipelineAsset } from "./pipeline-assets.js";
import { toolFundingOriginFromBoard } from "./tool-funding-origin.js";
import { planForJob, resultForJob } from "./pipeline-records.js";

/** Materialize only the standard review envelope. This path cannot fund, plan, acquire or execute. */
export async function materializeAcquisitionInquiryReview(store: BoardStore, outcome: AcquisitionInquiryOutcome, issuedAt: string) {
  const review = outcome.review;
  if (review === undefined || outcome.decision?.action !== "acquire" || outcome.search === undefined) return { ok: true as const, proposalOnly: true as const };

  const loaded = await store.load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

  const proof = toolFundingOriginFromBoard(loaded.state, review.plan);
  if (!proof.ok) return proof;

  const sourceDecision = loaded.state.assets.find(row => row.versionId === outcome.planningDecisionVersionId)?.content;
  const contextHash = recordOf(sourceDecision) && typeof sourceDecision.contextHash === "string" && /^[a-f0-9]{64}$/.test(sourceDecision.contextHash) ? sourceDecision.contextHash : undefined;

  if (review.jobId !== toolLearningJobId(review.plan) || review.decisionVersionId !== toolLearningDecisionVersionId({ jobId: review.jobId, attempt: 1, step: 1, decision: outcome.decision })) {
    return pipelineFailure("invalid_inquiry_review", review.jobId);
  }

  const result = { type: "tool_learning_result", schemaVersion: 1, jobId: review.jobId, attempt: 1, outcome: "waiting_approval", code: "acquisition_approval_required",
    search: outcome.search, occurredAt: review.plan.createdAt, decision: outcome.decision, decisionVersionId: review.decisionVersionId };

  for (const asset of [
    { versionId: planVersionId(review.jobId), content: review.plan },
    { versionId: review.decisionVersionId, content: { type: "tool_learning_decision", schemaVersion: 1, jobId: review.jobId, attempt: 1, step: 1, decision: outcome.decision,
      ...(contextHash === undefined ? {} : { contextHash }), sourceDecisionVersionId: outcome.planningDecisionVersionId, grantId: toolLearningFundingIdentity(proof.rootPlan).grantId } },
    { versionId: resultVersionId(review.jobId, 1), content: result },
  ]) {
    const saved = await savePipelineAsset(store, { ...asset, kind: "workflow", source: "inferred", scope: outcome.scope, issuedAt,
      observations: [outcome.specVersionId, outcome.planningDecisionVersionId!] });
    if (!saved.ok) return saved;
  }

  let current = await store.load();
  if (!current.ok) return pipelineFailure(current.reason, current.detail);

  let job = current.state.jobs.find(row => row.jobId === review.jobId);
  if (job === undefined) {
    if (!validToolPipelineJobs(current.state)) return pipelineFailure("invalid_pipeline_job", review.jobId);
    if (current.state.jobs.filter(row => row.jobId.startsWith(TOOL_JOB_PREFIX)).length >= MAX_TOOL_PIPELINE_JOBS) return pipelineFailure("pipeline_budget_exceeded", "The existing task-history limit still applies to review continuations");
    const queued = await store.apply({ type: "enqueue_job", commandId: `${review.jobId}:enqueue`, issuedAt,
      job: { jobId: review.jobId, observationId: review.plan.trigger.evidenceRefs[0]!, domain: "tool", scope: outcome.scope, maxAttempts: 3,
        dedupeKey: `${outcome.scope}:${review.plan.trigger.runId}:${review.plan.trigger.proposalKey}` } });
    if (!queued.ok) return pipelineFailure(queued.reason, queued.detail);
    job = queued.state.jobs.find(row => row.jobId === review.jobId);
  }

  if (job?.state === "queued") {
    const started = await store.apply({ type: "start_job", commandId: `${review.jobId}:start:1`, issuedAt, jobId: review.jobId });
    if (!started.ok) return pipelineFailure(started.reason, started.detail);
    job = started.state.jobs.find(row => row.jobId === review.jobId);
  }

  if (job?.state === "running" && job.attempt === 1) {
    const completed = await store.apply({ type: "complete_job", commandId: `${review.jobId}:terminal:1`, issuedAt, jobId: review.jobId, next: "waiting_approval" });
    if (!completed.ok) return pipelineFailure(completed.reason, completed.detail);
  }

  current = await store.load();
  if (!current.ok) return pipelineFailure(current.reason, current.detail);

  const plan = planForJob(current.state, review.jobId), recorded = resultForJob(current.state, review.jobId, 1);
  if (plan === undefined || contentHashOf(plan) !== contentHashOf(review.plan) || recorded?.decisionVersionId !== review.decisionVersionId
    || current.state.jobs.find(row => row.jobId === review.jobId)?.state !== "waiting_approval") return pipelineFailure("invalid_inquiry_review", review.jobId);

  return { ok: true as const, reviewJobId: review.jobId, approvalId: review.decisionVersionId, next: "explicitly_review_new_acquisition" as const };
}
