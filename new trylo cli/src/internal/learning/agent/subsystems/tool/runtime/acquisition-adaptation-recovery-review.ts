import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import type { BoardState } from "../../../../control/state.js";
import { centralLearningRemaining, type CentralLearningRemaining } from "../../../../control/coordination-contract.js";
import type { JobState } from "../../../../control/contracts.js";
import { contentHashOf } from "../../../../control/hash.js";
import { npmInstallId } from "../../../../../tooling/contract/npm-install.js";
import { acquisitionAdaptationJobId } from "../domain/evolution/acquisition-identity.js";
import { acquisitionRecoveryReviewId } from "../domain/evolution/acquisition-lease.js";
import { toolLearningFundingClaimMatches, toolLearningFundingClaimBelongsTo, toolLearningFundingIdentity } from "../domain/evolution/funding-identity.js";
import { recordOf } from "../domain/evolution/parse.js";
import { toolAcquisitionFromBoard, toolAcquisitionInstalledVersion } from "./acquisition-continuation.js";
import { readAcquisitionAdaptationLease } from "./acquisition-adaptation-lease.js";
import { acquisitionAdaptationOutcomeFromBoard, findCommittedAcquisitionCandidate } from "./acquisition-adaptation-committed.js";
import { assetAvailable, pipelineFailure } from "./pipeline-assets.js";
import { toolFundingGrantMatches } from "./tool-funding-grant.js";

export type AcquisitionRecoverySelection = { readonly boardRoot: string; readonly jobId: string; readonly scope: string;
  readonly approvalId?: string; readonly childJobId: string; readonly attempt: number; readonly now: () => number };

type RecoveryViewCommon = {
  readonly formatVersion: 1; readonly workspaceId: string; readonly jobId: string; readonly approvalId: string;
  readonly childJobId: string; readonly attempt: number; readonly state: JobState; readonly canResume: boolean; readonly expiresAt?: string;
  readonly budget: { readonly grantId: string; readonly status: "open" | "closed" | "not_funded"; readonly claimId?: string;
    readonly claimIds: readonly string[]; readonly remaining?: CentralLearningRemaining; readonly pendingReservations: number; readonly pendingMaxTokens: number };
  readonly action: "fence_expired_attempt_and_preserve_original_budget";
  readonly next: "confirm_exact_recovery" | "resume_committed_outcome" | "inspect_or_wait";
};

export type AcquisitionRecoveryView = RecoveryViewCommon & (
  | { readonly recoverable: true; readonly reviewId: string; readonly code?: never }
  | { readonly recoverable: false; readonly reviewId?: never; readonly code: string }
);

export function acquisitionRecoveryFenceId(childJobId: string, attempt: number, reviewId: string): string {
  return `acquisition-recovery-fence:${contentHashOf([childJobId, attempt, reviewId])}`;
}

/** No permission issuance, shell, install or provider call is involved in this review. */
export async function reviewAcquisitionAdaptationRecovery(input: AcquisitionRecoverySelection) {
  const loaded = await createBoardReader(input.boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
  const selected = acquisitionRecoveryFromBoard(loaded.state, input);
  return selected.ok ? { ok: true as const, ...selected.view } : selected;
}

export function acquisitionRecoveryFromBoard(state: BoardState, input: AcquisitionRecoverySelection) {
  if (!Number.isFinite(input.now())) return pipelineFailure("invalid_acquisition_recovery_time", input.childJobId);

  const request = toolAcquisitionFromBoard(state, input.jobId, input.scope);
  if (!request.ok) return request;

  if (input.approvalId !== undefined && input.approvalId !== request.approvalId) return pipelineFailure("approval_plan_mismatch", input.jobId);

  if (request.installation === undefined) return pipelineFailure("acquisition_installation_not_recorded", input.jobId);

  const installationId = npmInstallId(request.installation);
  if (input.childJobId !== acquisitionAdaptationJobId(input.jobId, request.approvalId, installationId)
    || !Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > 3) return pipelineFailure("invalid_continuation_binding", input.childJobId);

  const child = state.jobs.find(row => row.jobId === input.childJobId);
  if (child?.domain !== "tool" || child.scope !== input.scope || child.observationId !== input.jobId || child.attempt !== input.attempt
    || child.maxAttempts !== 3 || child.dedupeKey !== input.childJobId) return pipelineFailure("stale_acquisition_recovery", input.childJobId);

  const receipt = state.assets.find(row => row.versionId === toolAcquisitionInstalledVersion(request.approvalId, installationId));
  if (receipt === undefined || !assetAvailable(state, receipt) || receipt.scope !== input.scope || !recordOf(receipt.content)
    || receipt.content.type !== "tool_acquisition_installed" || receipt.content.jobId !== input.jobId
    || receipt.content.decisionVersionId !== request.approvalId || receipt.content.installationId !== installationId) {
    return pipelineFailure("acquisition_installation_not_recorded", input.jobId);
  }

  const lease = readAcquisitionAdaptationLease(state, { originalJobId: input.jobId, approvalId: request.approvalId,
    installationId, jobId: child.jobId, attempt: child.attempt, scope: input.scope });
  if (!lease.ok) return lease;

  const identity = toolLearningFundingIdentity(request.learningPlan);
  const grant = state.centralLearningGrants?.find(row => row.grantId === identity.grantId);
  if (grant !== undefined && !toolFundingGrantMatches(state, request.learningPlan, grant)) {
    return pipelineFailure("invalid_acquisition_funding", input.childJobId);
  }

  const ownClaim = grant?.claim !== undefined && toolLearningFundingClaimMatches(request.learningPlan, child.jobId, child.attempt, grant.claim) ? grant.claim : undefined;
  const claimId = ownClaim?.claimId;
  const ownReservations = grant?.reservations.filter(row => toolLearningFundingClaimBelongsTo(request.learningPlan, child.jobId, child.attempt, row.claimId)) ?? [];
  const claimIds = [...new Set([...ownReservations.map(row => row.claimId), ...(claimId === undefined ? [] : [claimId])])].sort();
  const pending = ownReservations.filter(row => row.state === "reserved");
  const binding = { originalJobId: input.jobId, approvalId: request.approvalId, jobId: child.jobId, attempt: child.attempt,
    scope: input.scope, workspaceId: input.scope, installationId, capability: request.capability };
  const outcome = acquisitionAdaptationOutcomeFromBoard(state, binding), candidate = findCommittedAcquisitionCandidate(state, binding);
  if (!outcome.ok) return outcome;

  if (!candidate.ok) return candidate;

  const outcomeCommitted = outcome.outcome !== undefined, candidateCommitted = candidate.versionId !== undefined;
  const fundingOwnedElsewhere = grant?.claim !== undefined && ownClaim === undefined;
  const expiresAt = ownClaim?.expiresAt ?? lease.lease?.expiresAt;
  const reason = child.state !== "running" ? "adaptation_not_running" : outcomeCommitted || candidateCommitted ? "adaptation_outcome_committed"
    : fundingOwnedElsewhere ? "learning_claim_owned_elsewhere" : expiresAt === undefined ? "acquisition_claim_expiry_unknown"
      : Date.parse(expiresAt) > input.now() ? "acquisition_claim_active" : undefined;
  const snapshot = { schemaVersion: 1, scope: input.scope, originalJobId: input.jobId, approvalId: request.approvalId, installationId,
    childJobId: child.jobId, attempt: child.attempt, maxAttempts: child.maxAttempts, lease: lease.lease ?? null,
    funding: grant === undefined ? null : { grantId: grant.grantId, status: grant.status, budgetJobId: grant.jobId, claim: grant.claim ?? null,
      reservations: ownReservations },
    progressHash: contentHashOf(state.assets.filter(row => recordOf(row.content) && row.content.subjectId === child.jobId).map(row => [row.versionId, row.contentHash])) };
  const common: RecoveryViewCommon = { formatVersion: 1, workspaceId: input.scope, jobId: input.jobId, approvalId: request.approvalId,
    childJobId: child.jobId, attempt: child.attempt, state: child.state, canResume: child.attempt < child.maxAttempts,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    budget: { grantId: identity.grantId, status: grant?.status ?? "not_funded", claimIds,
      ...(claimId === undefined ? {} : { claimId }), ...(grant === undefined ? {} : { remaining: centralLearningRemaining(grant) }),
      pendingReservations: pending.length, pendingMaxTokens: pending.reduce((sum, row) => sum + row.maxTokens, 0) },
    action: "fence_expired_attempt_and_preserve_original_budget",
    next: reason === undefined ? "confirm_exact_recovery" : reason === "adaptation_outcome_committed" ? "resume_committed_outcome" : "inspect_or_wait" };
  const view: AcquisitionRecoveryView = reason === undefined ? { ...common, recoverable: true, reviewId: acquisitionRecoveryReviewId(snapshot) }
    : { ...common, recoverable: false, code: reason };

  return { ok: true as const, request, child, installationId, claimId, claimIds, grant, snapshot, view };
}
