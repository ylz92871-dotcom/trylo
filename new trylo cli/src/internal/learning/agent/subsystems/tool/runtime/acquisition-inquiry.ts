import { withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { acquisitionInquirySpecId, decodeAcquisitionInquirySpec, isAcquisitionInquiryReviewId, type AcquisitionInquiryOutcome } from "../domain/evolution/acquisition-inquiry.js";
import { toolLearningFundingClaimMatches, toolLearningFundingIdentity } from "../domain/evolution/funding-identity.js";
import { ToolLearningServiceError } from "../domain/evolution/service-error.js";
import type { BoardState } from "../../../../control/state.js";
import type { ToolPipelineServices } from "./pipeline-services.js";
import { acquisitionInquiryReviewFromBoard, type AcquisitionInquirySelection } from "./acquisition-inquiry-review.js";
import { acquisitionInquirySpecFromBoard } from "./acquisition-inquiry-reader.js";
import { inquiryLeaseFromBoard, saveInquiryLease } from "./acquisition-inquiry-lease.js";
import { finishAcquisitionInquiry, proposedAcquisitionInquiryOutcome } from "./acquisition-inquiry-result.js";
import { researchAcquisitionInquiry } from "./acquisition-inquiry-research.js";
import { monitorToolJob } from "./pipeline-monitor.js";
import { pipelineFailure, savePipelineAsset } from "./pipeline-assets.js";
import { prepareAcquisitionFundingRestart } from "./acquisition-funding-restart.js";
import { cleanupStoppedInquiryFunding } from "./acquisition-inquiry-funding-cleanup.js";

async function claimInquiry(input: AcquisitionInquirySelection & { readonly approvalId: string; readonly reviewId: string }) {
  const result = await withBoardWriter(input.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

    const selected = acquisitionInquiryReviewFromBoard(loaded.state, input);
    if (!selected.ok) return selected;

    if (selected.view.reviewId !== input.reviewId) return pipelineFailure(selected.view.reviewId === undefined ? selected.view.code ?? "inquiry_not_ready" : "stale_inquiry_review", selected.inquiryJobId);

    if (selected.outcome !== undefined && (selected.outcome.status === "proposed" || selected.view.code === "inquiry_waiting_for_new_evidence")) {
      const recovered = await finishAcquisitionInquiry(store, selected.outcome, new Date(input.now()).toISOString());
      if (!recovered.ok) return recovered;
      const cleaned = await cleanupStoppedInquiryFunding(store, { plan: selected.rootPlan, jobId: selected.inquiryJobId, attempt: selected.outcome.attempt, issuedAt: new Date(input.now()).toISOString() });
      return cleaned.ok ? { ok: true as const, completed: true as const, result: recovered } : cleaned;
    }

    if (!selected.view.ready || selected.view.reviewId !== input.reviewId) return pipelineFailure(selected.view.code ?? "stale_inquiry_review", selected.inquiryJobId);

    const at = new Date(input.now()).toISOString(), attempt = (selected.child?.attempt ?? 0) + 1;
    const funding = await prepareAcquisitionFundingRestart(store, { plan: selected.request.learningPlan, child: selected.child, issuedAt: at });
    if (!funding.ok) return funding;

    if (selected.child === undefined) {
      const queued = await store.apply({ type: "enqueue_job", commandId: `${selected.inquiryJobId}:enqueue`, issuedAt: at,
        job: { jobId: selected.inquiryJobId, domain: "tool", scope: input.scope, observationId: input.jobId, maxAttempts: 3, dedupeKey: selected.inquiryJobId } });
      if (!queued.ok) return pipelineFailure(queued.reason, queued.detail);
    } else if (selected.child.state === "waiting_evidence") {
      const queued = await store.apply({ type: "requeue_job", commandId: `${selected.inquiryJobId}:requeue:${selected.child.attempt}`, issuedAt: at,
        jobId: selected.inquiryJobId, expectedAttempt: selected.child.attempt });
      if (!queued.ok) return pipelineFailure(queued.reason, queued.detail);
    }

    const spec = decodeAcquisitionInquirySpec({ type: "tool_acquisition_inquiry_spec", schemaVersion: 1, jobId: selected.inquiryJobId, attempt,
      originalJobId: input.jobId, approvalId: input.approvalId, failureRef: input.failureRef, scope: input.scope, rootJobId: selected.rootJobId, rootPlanHash: selected.rootPlanHash });
    if (spec === undefined) return pipelineFailure("invalid_inquiry_spec", selected.inquiryJobId);

    const saved = await savePipelineAsset(store, { versionId: acquisitionInquirySpecId(spec.jobId, attempt), kind: "workflow", source: "inferred", scope: input.scope, content: spec, issuedAt: at,
      observations: [input.approvalId, input.failureRef] });
    if (!saved.ok) return saved;

    const lease = await saveInquiryLease(store, { jobId: spec.jobId, attempt, scope: input.scope, startedAt: at });
    if (!lease.ok) return lease;

    const started = await store.apply({ type: "start_job", commandId: `${spec.jobId}:start:${attempt}`, issuedAt: at, jobId: spec.jobId });
    if (!started.ok || started.idempotent) return started.ok ? pipelineFailure("inquiry_not_claimed", spec.jobId) : pipelineFailure(started.reason, started.detail);

    return { ok: true as const, completed: false as const, spec, request: selected.request, failure: selected.failure };
  });
  return "reason" in result ? pipelineFailure(result.reason, result.detail) : result;
}

export function acquisitionInquiryClaimActive(state: BoardState, input: AcquisitionInquirySelection & { readonly inquiryJobId: string; readonly attempt: number }): boolean {
  const selected = acquisitionInquiryReviewFromBoard(state, input);
  if (!selected.ok) return false;

  const child = selected.child;
  if (child?.state !== "running" || child.jobId !== input.inquiryJobId || child.attempt !== input.attempt
    || ["acquisition_already_installed", "acquisition_adaptation_requires_inspection", "acquisition_stop_unconfirmed"].includes(selected.view.code ?? "")) return false;

  const spec = acquisitionInquirySpecFromBoard(state, child.jobId, child.attempt, input.scope);
  if (!spec.ok || spec.spec?.failureRef !== input.failureRef) return false;

  const grant = state.centralLearningGrants?.find(row => row.grantId === toolLearningFundingIdentity(selected.rootPlan).grantId);
  if (grant?.status !== "open") return false;

  if (grant.claim !== undefined) return toolLearningFundingClaimMatches(selected.rootPlan, child.jobId, child.attempt, grant.claim) && Date.parse(grant.claim.expiresAt) > input.now();

  const lease = inquiryLeaseFromBoard(state, child.jobId, child.attempt, input.scope);

  return lease.ok && lease.expiresAt !== undefined && Date.parse(lease.expiresAt) > input.now();
}

export async function runAcquisitionInquiry(input: AcquisitionInquirySelection & { readonly approvalId: string; readonly reviewId: string;
  readonly signal: AbortSignal; readonly services: (continuationJobId: string) => Promise<ToolPipelineServices> }) {
  if (!isAcquisitionInquiryReviewId(input.reviewId)) return pipelineFailure("invalid_inquiry_review", input.jobId);

  if (input.signal.aborted) return pipelineFailure("cancelled", "The inquiry was cancelled before claiming work");

  const claim = await claimInquiry(input);
  if (!claim.ok) return claim;
  if (claim.completed) return claim.result;

  const { spec } = claim, monitor = monitorToolJob({ boardRoot: input.boardRoot, jobId: spec.jobId, attempt: spec.attempt, signal: input.signal,
    claimActive: state => acquisitionInquiryClaimActive(state, { ...input, inquiryJobId: spec.jobId, attempt: spec.attempt }) });
  let services: ToolPipelineServices | undefined, outcome: AcquisitionInquiryOutcome;

  try {
    services = await input.services(spec.jobId);
    const researched = await researchAcquisitionInquiry({ ...input, plan: claim.request.learningPlan, jobId: spec.jobId, attempt: spec.attempt,
      search: claim.request.search, services, signal: monitor.signal });
    const proposal = researched.ok ? proposedAcquisitionInquiryOutcome({ spec, plan: claim.request.learningPlan, decision: researched.decision,
      decisionVersionId: researched.decisionVersionId, search: researched.search, occurredAt: researched.occurredAt, failure: claim.failure }) : undefined;

    outcome = proposal ?? { type: "tool_acquisition_inquiry_result", schemaVersion: 1, jobId: spec.jobId, attempt: spec.attempt,
      specVersionId: acquisitionInquirySpecId(spec.jobId, spec.attempt), scope: spec.scope, status: "waiting_evidence", code: researched.ok ? "invalid_inquiry_proposal" : researched.code };
  } catch (error) {
    outcome = { type: "tool_acquisition_inquiry_result", schemaVersion: 1, jobId: spec.jobId, attempt: spec.attempt,
      specVersionId: acquisitionInquirySpecId(spec.jobId, spec.attempt), scope: spec.scope, status: "waiting_evidence",
      code: monitor.signal.aborted ? "cancelled" : error instanceof ToolLearningServiceError ? error.code : "inquiry_service_unavailable" };
  } finally {
    monitor.close();
  }

  try { await services?.releaseAllowance?.(); }
  catch { return pipelineFailure("inquiry_cleanup_unconfirmed", "The original inquiry owner has not confirmed worker/funding closeout; inspect the exact running attempt"); }

  const saved = await withBoardWriter(input.boardRoot, store => finishAcquisitionInquiry(store, outcome, new Date(input.now()).toISOString()));

  return "reason" in saved ? pipelineFailure(saved.reason, saved.detail) : saved;
}
