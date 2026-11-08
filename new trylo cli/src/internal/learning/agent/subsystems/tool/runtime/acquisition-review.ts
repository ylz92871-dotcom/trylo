import { createBoardReader } from "../../../../../adapters/learning-store/file-event-store.js";
import { npmInstallId } from "../../../../../tooling/contract/npm-install.js";
import { toolAcquisitionFromBoard, toolAcquisitionInstalledVersion } from "./acquisition-continuation.js";
import { acquisitionAdaptationJobId } from "../domain/evolution/acquisition-identity.js";
import { assetAvailable, pipelineFailure } from "./pipeline-assets.js";
import { recordOf } from "../domain/evolution/parse.js";
import { acquisitionAdaptationOutcomeFromBoard, findCommittedAcquisitionCandidate, type AcquisitionAdaptationOutcome } from "./acquisition-adaptation-committed.js";
import type { BoardState } from "../../../../control/state.js";
import { toolLearningAcquisitionFailures } from "./acquisition-failure-reader.js";
import { toolAcquisitionFailureRecovery } from "../domain/evolution/acquisition-failure.js";

/** Operator review contains the real frozen selection and progress, never a
 * dependency tree/source dump or a model's assertion of observed benefit. */
export async function reviewToolLearningAcquisition(boardRoot: string, jobId: string, scope: string) {
  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
  const request = toolAcquisitionFromBoard(loaded.state, jobId, scope);
  return request.ok ? projectToolAcquisitionReview(loaded.state, request) : request;
}

export function projectToolAcquisitionReview(state: BoardState, request: Extract<ReturnType<typeof toolAcquisitionFromBoard>, { readonly ok: true }>) {
  const { jobId, scope } = request;
  const failures = toolLearningAcquisitionFailures(state, { scope, trigger: { evidenceRefs: [] } }, { jobId, attempt: request.attempt, approvalId: request.approvalId });
  if (!failures.ok) return failures;

  const failure = failures.failures.find(row => row.jobId === jobId && row.attempt === request.attempt && row.decisionVersionId === request.approvalId);
  const installationId = request.installation === undefined ? undefined : npmInstallId(request.installation);
  const receipt = installationId === undefined ? undefined : state.assets.find(row => row.versionId === toolAcquisitionInstalledVersion(request.approvalId, installationId));
  const installed = receipt !== undefined && receipt.scope === scope && assetAvailable(state, receipt) && recordOf(receipt.content)
    && receipt.content.type === "tool_acquisition_installed" && receipt.content.jobId === jobId
    && receipt.content.decisionVersionId === request.approvalId && receipt.content.installationId === installationId;
  const continuationId = installationId === undefined ? undefined : acquisitionAdaptationJobId(jobId, request.approvalId, installationId);
  const job = state.jobs.find(row => row.jobId === continuationId && row.observationId === jobId && row.scope === scope && row.domain === "tool");
  let result: AcquisitionAdaptationOutcome | undefined, versionId: string | undefined;

  if (job !== undefined && installationId !== undefined) {
    const binding = { originalJobId: jobId, approvalId: request.approvalId, jobId: job.jobId, attempt: job.attempt,
      scope, workspaceId: scope, installationId, capability: request.capability };
    const stored = acquisitionAdaptationOutcomeFromBoard(state, binding);
    if (!stored.ok) return stored;

    result = stored.outcome;

    if (result === undefined && ["waiting_approval", "succeeded"].includes(job.state)) return pipelineFailure("invalid_continuation_result", job.jobId);

    if (result?.ok === true) versionId = result.versionId;
    else if (result === undefined && job.state === "running") {
      const committed = findCommittedAcquisitionCandidate(state, binding);
      if (!committed.ok) return committed;
      versionId = committed.versionId;
    }
  }

  const decision = request.decision;

  return { ok: true as const, formatVersion: 1 as const, workspaceId: scope, jobId, approvalId: request.approvalId,
    capability: request.capability, candidate: { ...request.chosen, version: decision.candidate.version }, rationale: decision.rationale, existingInsufficiency: decision.existingInsufficiency,
    expectedBenefit: decision.expectedBenefit, constructionCost: decision.constructionCost, alternatives: decision.alternatives, adaptation: decision.adaptation,
    ...(failure === undefined || installed || job !== undefined ? {} : { failure: { ref: failure.ref, phase: failure.phase, code: failure.code,
      diagnostics: failure.diagnostics, recovery: toolAcquisitionFailureRecovery(failure) } }),
    ...(installationId === undefined ? {} : { installation: { installationId, packageCount: request.installation!.packages.length, installed } }),
    ...(job === undefined ? {} : { continuation: { jobId: job.jobId, state: job.state, attempt: job.attempt,
      ...(result?.ok === false ? { code: result.code } : {}),
      ...(versionId === undefined ? {} : { versionId, ...(job.state === "running" ? { recovery: "committed_candidate" as const } : {}) }) } }),
    action: "resolve_download_install_and_prepare_immutable_adaptation" as const,
    next: versionId === undefined ? "authorize_or_resume_acquisition" as const : "production_verify_then_explicit_activation" as const };
}
