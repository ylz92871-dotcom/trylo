import { contentHashOf } from "../../../../../control/hash.js";
import { isJsonValue, jsonBytes, keysAre, recordOf, textOf } from "./parse.js";
import { decodeToolLearningDecision, type ToolLearningDecision } from "./learning-plan.js";
import { decodeToolLearningPlan, toolLearningJobId, type ToolLearningPlan } from "./pipeline.js";
import { decodeDiscoverySummary, type ToolDiscoverySummary } from "./discovery.js";

export function acquisitionInquiryJobId(originalJobId: string, approvalId: string) { return `tool-acquisition-inquiry_v1_${contentHashOf([originalJobId, approvalId])}`; }

export function acquisitionInquirySpecId(jobId: string, attempt: number) { return `acquisition-inquiry-spec:${jobId}:${attempt}`; }

export function acquisitionInquiryOutcomeId(jobId: string, attempt: number) { return `acquisition-inquiry-result:${jobId}:${attempt}`; }

export function acquisitionInquiryReviewId(snapshot: unknown) { return `acquisition-inquiry-review_v1_${contentHashOf(snapshot)}`; }

export function isAcquisitionInquiryReviewId(raw: unknown): raw is string { return typeof raw === "string" && /^acquisition-inquiry-review_v1_[a-f0-9]{64}$/.test(raw); }

const EXPLICIT_PROVIDER_RETRIES = new Set(["provider_configuration_unavailable", "tool_planning_timeout", "tool_planning_unavailable", "tool_planning_cancelled", "cancelled",
  "tool_planning_provider_isolation_unavailable", "tool_planning_provider_error", "tool_planning_provider_error_invalid_request", "tool_planning_provider_error_auth",
  "tool_planning_provider_error_rate_limit", "tool_planning_provider_error_unavailable", "tool_planning_provider_error_timeout", "tool_planning_provider_error_network", "tool_planning_provider_error_server"]);

/** Operator retry after confirmed closeout, not an automatic retry or new task fact. */
export function acquisitionInquiryAllowsExplicitProviderRetry(code: string): boolean { return EXPLICIT_PROVIDER_RETRIES.has(code); }

export type AcquisitionInquirySpec = { readonly type: "tool_acquisition_inquiry_spec"; readonly schemaVersion: 1;
  readonly jobId: string; readonly attempt: number; readonly originalJobId: string; readonly approvalId: string; readonly failureRef: string;
  readonly scope: string; readonly rootJobId: string; readonly rootPlanHash: string };

export type AcquisitionInquiryOutcome = { readonly type: "tool_acquisition_inquiry_result"; readonly schemaVersion: 1;
  readonly jobId: string; readonly attempt: number; readonly specVersionId: string; readonly scope: string;
  readonly status: "proposed" | "waiting_evidence"; readonly code: string; readonly planningDecisionVersionId?: string;
  readonly decision?: ToolLearningDecision; readonly search?: ToolDiscoverySummary;
  readonly review?: { readonly plan: ToolLearningPlan; readonly jobId: string; readonly decisionVersionId: string } };

export function decodeAcquisitionInquirySpec(raw: unknown): AcquisitionInquirySpec | undefined {
  if (!recordOf(raw) || !isJsonValue(raw) || !keysAre(raw, ["type", "schemaVersion", "jobId", "attempt", "originalJobId", "approvalId", "failureRef", "scope", "rootJobId", "rootPlanHash"])
    || raw.type !== "tool_acquisition_inquiry_spec" || raw.schemaVersion !== 1 || !textOf(raw.originalJobId, 160) || !/^tool-learning_v1_[a-f0-9]{64}$/.test(raw.originalJobId)
    || !textOf(raw.approvalId, 160) || !/^tool-decision_v1_[a-f0-9]{64}$/.test(raw.approvalId) || raw.jobId !== acquisitionInquiryJobId(raw.originalJobId, raw.approvalId)
    || typeof raw.attempt !== "number" || !Number.isSafeInteger(raw.attempt) || raw.attempt < 1 || raw.attempt > 3
    || !textOf(raw.failureRef, 160) || !/^tool-acquisition-failure_v1_[a-f0-9]{64}$/.test(raw.failureRef) || !textOf(raw.scope, 512)
    || !textOf(raw.rootJobId, 160) || !/^tool-learning_v1_[a-f0-9]{64}$/.test(raw.rootJobId) || !textOf(raw.rootPlanHash, 64) || !/^[a-f0-9]{64}$/.test(raw.rootPlanHash)) return undefined;
  return { type: raw.type, schemaVersion: 1, jobId: raw.jobId, attempt: raw.attempt, originalJobId: raw.originalJobId, approvalId: raw.approvalId,
    failureRef: raw.failureRef, scope: raw.scope, rootJobId: raw.rootJobId, rootPlanHash: raw.rootPlanHash };
}

export function decodeAcquisitionInquiryOutcome(raw: unknown): AcquisitionInquiryOutcome | undefined {
  if (!recordOf(raw) || !isJsonValue(raw) || jsonBytes(raw) > 393_216 || !keysAre(raw,
    ["type", "schemaVersion", "jobId", "attempt", "specVersionId", "scope", "status", "code"], ["planningDecisionVersionId", "decision", "search", "review"])
    || raw.type !== "tool_acquisition_inquiry_result" || raw.schemaVersion !== 1 || !textOf(raw.jobId, 160) || !/^tool-acquisition-inquiry_v1_[a-f0-9]{64}$/.test(raw.jobId)
    || typeof raw.attempt !== "number" || !Number.isSafeInteger(raw.attempt) || raw.attempt < 1 || raw.attempt > 3
    || raw.specVersionId !== acquisitionInquirySpecId(raw.jobId, raw.attempt) || !textOf(raw.scope, 512) || !textOf(raw.code, 160) || !/^[a-z][a-z0-9_]*$/.test(raw.code)
    || !["proposed", "waiting_evidence"].includes(String(raw.status))) return undefined;

  const decision = raw.decision === undefined ? undefined : decodeToolLearningDecision(raw.decision), search = raw.search === undefined ? undefined : decodeDiscoverySummary(raw.search);
  if (raw.decision !== undefined && decision === undefined || raw.search !== undefined && search === undefined
    || (raw.planningDecisionVersionId === undefined) !== (decision === undefined) || raw.planningDecisionVersionId !== undefined && (!textOf(raw.planningDecisionVersionId, 160) || !/^tool-decision_v1_[a-f0-9]{64}$/.test(raw.planningDecisionVersionId))
    || raw.status === "proposed" && (decision === undefined || decision.action === "research" || search === undefined)) return undefined;

  let review: AcquisitionInquiryOutcome["review"];
  if (raw.review !== undefined) {
    if (raw.status !== "proposed") return undefined;

    if (!recordOf(raw.review) || !keysAre(raw.review, ["plan", "jobId", "decisionVersionId"])) return undefined;

    const plan = decodeToolLearningPlan(raw.review.plan);
    if (plan === undefined || plan.scope !== raw.scope || plan.fundingOrigin?.inquiryJobId !== raw.jobId || plan.fundingOrigin.inquiryAttempt !== raw.attempt
      || plan.fundingOrigin.outcomeVersionId !== acquisitionInquiryOutcomeId(raw.jobId, raw.attempt) || raw.review.jobId !== toolLearningJobId(plan)
      || !textOf(raw.review.decisionVersionId, 160) || !/^tool-decision_v1_[a-f0-9]{64}$/.test(raw.review.decisionVersionId) || decision?.action !== "acquire") return undefined;

    review = { plan, jobId: raw.review.jobId, decisionVersionId: raw.review.decisionVersionId };
  }

  if (raw.status === "proposed" && decision?.action === "acquire" && review === undefined) return undefined;

  return { type: raw.type, schemaVersion: 1, jobId: raw.jobId, attempt: raw.attempt, specVersionId: raw.specVersionId, scope: raw.scope,
    status: raw.status as AcquisitionInquiryOutcome["status"], code: raw.code, ...(decision === undefined ? {} : { decision, planningDecisionVersionId: raw.planningDecisionVersionId as string }),
    ...(search === undefined ? {} : { search }), ...(review === undefined ? {} : { review }) };
}
