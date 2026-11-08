import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import { centralLearningRemaining } from "../../../../control/coordination-contract.js";
import { toolLearningFundingClaimMatches, toolLearningFundingIdentity } from "../domain/evolution/funding-identity.js";
import { acquisitionInquiryAllowsExplicitProviderRetry, acquisitionInquiryReviewId } from "../domain/evolution/acquisition-inquiry.js";
import { acquisitionInquiryBindingFromBoard, acquisitionInquiryOutcomeFromBoard } from "./acquisition-inquiry-reader.js";
import { acquisitionInquirySpecFromBoard } from "./acquisition-inquiry-reader.js";
import { inquiryLeaseFromBoard } from "./acquisition-inquiry-lease.js";
import { assetAvailable, pipelineFailure } from "./pipeline-assets.js";
import { recordOf } from "../domain/evolution/parse.js";
import { npmInstallId } from "../../../../../tooling/contract/npm-install.js";
import { toolAcquisitionInstalledVersion, acquisitionAdaptationJobId } from "../domain/evolution/acquisition-identity.js";
import { toolFundingGrantMatches } from "./tool-funding-grant.js";

export type AcquisitionInquirySelection = { readonly boardRoot: string; readonly jobId: string; readonly scope: string; readonly approvalId?: string; readonly failureRef: string; readonly now: () => number };

export async function reviewAcquisitionInquiry(input: AcquisitionInquirySelection) {
  const loaded = await createBoardReader(input.boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
  const selected = acquisitionInquiryReviewFromBoard(loaded.state, input);
  return selected.ok ? { ok: true as const, ...selected.view } : selected;
}

export function acquisitionInquiryReviewFromBoard(state: BoardState, input: AcquisitionInquirySelection) {
  if (!Number.isFinite(input.now())) return pipelineFailure("invalid_inquiry_time", input.jobId);

  const selected = acquisitionInquiryBindingFromBoard(state, input);
  if (!selected.ok) return selected;

  const { child, inquiryJobId } = selected, identity = toolLearningFundingIdentity(selected.rootPlan);
  const grant = state.centralLearningGrants?.find(row => row.grantId === identity.grantId), issue = state.learningIssues?.find(row => row.issueId === identity.issueId);
  if (grant !== undefined && !toolFundingGrantMatches(state, selected.rootPlan, grant)) return pipelineFailure("invalid_inquiry_funding", inquiryJobId);

  const remaining = grant === undefined ? undefined : centralLearningRemaining(grant);
  const readOutcome = child === undefined ? { ok: true as const, outcome: undefined } : acquisitionInquiryOutcomeFromBoard(state, inquiryJobId, child.attempt, input.scope);
  if (!readOutcome.ok) return readOutcome;

  const outcome = readOutcome.outcome;
  const priorSpec = child === undefined || child.attempt === 0 ? { ok: true as const, spec: undefined }
    : acquisitionInquirySpecFromBoard(state, inquiryJobId, child.attempt, input.scope);
  if (!priorSpec.ok) return priorSpec;

  if (child?.state === "running" && priorSpec.spec?.failureRef !== input.failureRef) return pipelineFailure("inquiry_failure_binding_mismatch", priorSpec.spec?.failureRef ?? inquiryJobId);

  const installationId = selected.request.installation === undefined ? undefined : npmInstallId(selected.request.installation);
  const receipt = installationId === undefined ? undefined : state.assets.find(row => row.versionId === toolAcquisitionInstalledVersion(selected.request.approvalId, installationId));
  const installed = receipt !== undefined && assetAvailable(state, receipt) && receipt.scope === input.scope && recordOf(receipt.content)
    && receipt.content.type === "tool_acquisition_installed" && receipt.content.jobId === input.jobId
    && receipt.content.decisionVersionId === selected.request.approvalId && receipt.content.installationId === installationId;
  const adaptation = installationId === undefined ? undefined : state.jobs.find(row => row.jobId === acquisitionAdaptationJobId(input.jobId, selected.request.approvalId, installationId)
    && row.domain === "tool" && row.scope === input.scope && row.observationId === input.jobId && ["queued", "running", "waiting_approval"].includes(row.state));
  const ownClaim = child !== undefined && grant?.claim !== undefined && toolLearningFundingClaimMatches(selected.rootPlan, inquiryJobId, child.attempt, grant.claim) ? grant.claim : undefined;
  const lease = child === undefined ? { ok: true as const, expiresAt: undefined } : inquiryLeaseFromBoard(state, inquiryJobId, child.attempt, input.scope);
  if (!lease.ok) return lease;

  const expiresAt = ownClaim?.expiresAt ?? lease.expiresAt;
  const sourceReady = selected.failure.code !== "npm_resolver_stop_unconfirmed";
  const code = outcome?.status === "proposed" ? "inquiry_outcome_committed" : !sourceReady ? "acquisition_stop_unconfirmed"
    : new Set([...selected.request.learningPlan.trigger.evidenceRefs, input.failureRef]).size >= 64 ? "inquiry_evidence_capacity"
    : installed ? "acquisition_already_installed" : adaptation !== undefined ? "acquisition_adaptation_requires_inspection" : selected.failure.phase === "receipt_commit" ? "acquisition_receipt_requires_inspection"
      : outcome?.status === "waiting_evidence" && priorSpec.spec?.failureRef === input.failureRef && !acquisitionInquiryAllowsExplicitProviderRetry(outcome.code) ? "inquiry_waiting_for_new_evidence"
        : grant === undefined ? "learning_allowance_required"
      : grant.status !== "open" ? "learning_grant_closed" : issue?.decision.kind !== "focused_learning" || issue.decision.revision !== grant.focusRevision ? "learning_issue_not_focused"
        : child?.state === "running" ? "inquiry_running_requires_inspection"
          : child !== undefined && !["queued", "waiting_evidence"].includes(child.state) ? "inquiry_terminal"
            : (child?.attempt ?? 0) >= 3 ? "inquiry_attempt_limit"
              : grant.claim !== undefined && Date.parse(grant.claim.expiresAt) > input.now() ? "learning_claim_active"
                : remaining === undefined || remaining.calls < 1 || remaining.tokens < 1 || remaining.steps < 1 ? "learning_budget_exhausted" : undefined;
  const snapshot = { schemaVersion: 1, originalJobId: input.jobId, approvalId: selected.request.approvalId, failureRef: input.failureRef,
    rootJobId: selected.rootJobId, rootPlanHash: selected.rootPlanHash, child: child ?? null,
    grant: grant === undefined ? null : { grantId: grant.grantId, status: grant.status, claim: grant.claim ?? null, remaining, reservations: grant.reservations },
    outcomeHash: outcome === undefined ? null : contentHashOf(outcome), expiresAt: expiresAt ?? null };
  const recoverable = child?.state === "running" && outcome === undefined && expiresAt !== undefined && Date.parse(expiresAt) <= input.now()
    && (grant?.claim === undefined || ownClaim !== undefined);
  const view = { formatVersion: 1 as const, workspaceId: input.scope, jobId: input.jobId, approvalId: selected.request.approvalId,
    failureRef: input.failureRef, inquiryJobId, state: child?.state ?? "not_started", attempt: child?.attempt ?? 0,
    ready: code === undefined, ...(code === undefined || outcome !== undefined ? { reviewId: acquisitionInquiryReviewId({ action: "start", snapshot }) } : {}),
    ...(code === undefined ? {} : { code }),
    budget: { grantId: identity.grantId, status: grant?.status ?? "not_funded", ...(remaining === undefined ? {} : { remaining: { calls: remaining.calls, tokens: remaining.tokens } }) },
    ...(outcome === undefined ? {} : { outcome: { status: outcome.status, code: outcome.code,
      ...(outcome.decision === undefined ? {} : { proposal: { kind: "model_strategy_proposal" as const, action: outcome.decision.action,
        planningDecisionVersionId: outcome.planningDecisionVersionId!, rationale: outcome.decision.rationale, existingInsufficiency: outcome.decision.existingInsufficiency,
        expectedBenefit: outcome.decision.expectedBenefit, constructionCost: outcome.decision.constructionCost, alternatives: outcome.decision.alternatives } }),
      ...(outcome.review === undefined ? {} : { reviewJobId: outcome.review.jobId, approvalId: outcome.review.decisionVersionId }) } }),
    ...(child?.state !== "running" ? {} : { recovery: { recoverable, attempt: child.attempt, ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(recoverable ? { reviewId: acquisitionInquiryReviewId({ action: "fence", snapshot }) } : {}) } }),
    action: "research_existing_task_without_acquisition" as const,
    next: outcome?.review !== undefined ? "review_new_decision" as const : code === undefined ? "confirm_inquiry" as const : "inspect_or_wait" as const };

  return { ...selected, grant, ownClaim, snapshot, outcome, view };
}
