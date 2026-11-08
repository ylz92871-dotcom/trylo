import { withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { npmInstallId } from "../../../../../tooling/contract/npm-install.js";
import { recordOf } from "../domain/evolution/parse.js";
import { readToolAcquisition, toolAcquisitionInstalledVersion } from "./acquisition-continuation.js";
import { assetAvailable, pipelineFailure, savePipelineAsset } from "./pipeline-assets.js";
import { prepareNpmToolAdaptation, type NpmAdaptationServices } from "./npm-adaptation-runtime.js";
import { monitorToolJob } from "./pipeline-monitor.js";
import { recoverAcquisitionAdaptation, acquisitionAdaptationResultId } from "./acquisition-adaptation-recovery.js";
import { toolLearningParentFromBoard } from "./learning-parent.js";
import { toolLearningNpmParents, toolLearningFeedbackRequirements } from "./learning-context.js";
import { acquisitionAdaptationJobId } from "../domain/evolution/acquisition-identity.js";
import { generatedPredecessorFromBoard } from "./generated-predecessor.js";
import { exactPureProductionLearningParents } from "./pure-production-regression.js";

export { acquisitionAdaptationJobId } from "../domain/evolution/acquisition-identity.js";

import { acquisitionAdaptationClaimActive, saveAcquisitionAdaptationLease } from "./acquisition-adaptation-lease.js";
import { prepareAcquisitionFundingRestart } from "./acquisition-funding-restart.js";
import { toolLearningCleanupCode, type ToolLearningCleanupCode } from "../domain/evolution/cleanup.js";

type Selection = { readonly boardRoot: string; readonly jobId: string; readonly scope: string; readonly approvalId: string; readonly now: () => number };

/** Acquisition approval remains frozen on the original job; a child claim cannot impersonate it. */
export async function claimAcquisitionAdaptation(input: Selection & { readonly workspaceId: string }) {
  const request = await readToolAcquisition(input.boardRoot, input.jobId, input.scope);
  if (!request.ok) return request;

  if (request.approvalId !== input.approvalId || request.installation === undefined) return pipelineFailure("acquisition_plan_mismatch", input.jobId);

  const installationId = npmInstallId(request.installation), jobId = acquisitionAdaptationJobId(input.jobId, input.approvalId, installationId);
  const result = await withBoardWriter(input.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

    const receipt = loaded.state.assets.find(row => row.versionId === toolAcquisitionInstalledVersion(input.approvalId, installationId));
    if (receipt === undefined || !assetAvailable(loaded.state, receipt) || receipt.scope !== input.scope || !recordOf(receipt.content)
      || receipt.content.type !== "tool_acquisition_installed" || receipt.content.jobId !== input.jobId
      || receipt.content.decisionVersionId !== input.approvalId || receipt.content.installationId !== installationId) {
      return pipelineFailure("acquisition_installation_not_recorded", input.jobId);
    }

    const target = request.learningPlan.targetVersionId;
    const selectedParent = target === undefined ? undefined : toolLearningParentFromBoard(loaded.state, target);
    if (selectedParent !== undefined && !selectedParent.ok) return selectedParent;

    const parents = toolLearningNpmParents(loaded.state, request.learningPlan), requirements = toolLearningFeedbackRequirements(loaded.state, request.learningPlan);
    if (!parents.ok) return parents;

    if (!requirements.ok) return requirements;

    const parent = selectedParent?.ok && selectedParent.parent.kind === "npm" ? { versionId: selectedParent.parent.versionId,
      plan: selectedParent.parent.plan, feedback: parents.parents.find(row => row.versionId === target)?.feedback ?? "No task feedback available" } : undefined;
    const productionSources = selectedParent?.ok && selectedParent.parent.kind === "generated"
      ? exactPureProductionLearningParents(loaded.state, request.learningPlan) : { ok: true as const, parents: [] };
    if (!productionSources.ok) return productionSources;

    if (productionSources.parents.length > 1) return pipelineFailure("ambiguous_generated_production_parent",
      "The inquiry refers to several exact production contracts; explicitly resolve the replacement parent before construction");

    const predecessorVersionId = productionSources.parents[0]?.versionId ?? target;
    const predecessor = selectedParent?.ok && selectedParent.parent.kind === "generated"
      ? generatedPredecessorFromBoard(loaded.state, predecessorVersionId!, input.workspaceId) : undefined;
    if (selectedParent?.ok && selectedParent.parent.kind === "generated" && predecessor === undefined) return pipelineFailure("invalid_acquisition_predecessor", target!);

    let job = loaded.state.jobs.find(row => row.jobId === jobId);
    if (job !== undefined && (job.domain !== "tool" || job.scope !== input.scope || job.observationId !== input.jobId)) return pipelineFailure("invalid_continuation_binding", jobId);

    if (job !== undefined && ["running", "waiting_approval", "succeeded"].includes(job.state)) {
      const recovered = await recoverAcquisitionAdaptation(store, loaded.state, { ...input, originalJobId: input.jobId, job,
        installationId, capability: request.capability, issuedAt: new Date(input.now()).toISOString() });
      if (!recovered.ok || !("recovered" in recovered) || recovered.recovered) return recovered;
      return pipelineFailure("running_adaptation_requires_inspection", jobId);
    }

    const at = new Date(input.now()).toISOString();
    const funding = await prepareAcquisitionFundingRestart(store, { plan: request.learningPlan, child: job, issuedAt: at });
    if (!funding.ok) return funding;

    if (job === undefined) {
      const queued = await store.apply({ type: "enqueue_job", commandId: `${jobId}:enqueue`, issuedAt: at,
        job: { jobId, domain: "tool", scope: input.scope, observationId: input.jobId, maxAttempts: 3, dedupeKey: jobId } });
      if (!queued.ok) return pipelineFailure(queued.reason, queued.detail);
    } else if (job.state === "waiting_evidence") {
      const queued = await store.apply({ type: "requeue_job", commandId: `${jobId}:requeue:${job.attempt}`, issuedAt: at, jobId, expectedAttempt: job.attempt });
      if (!queued.ok) return pipelineFailure(queued.reason, queued.detail);
    } else if (job.state !== "queued") return pipelineFailure("adaptation_job_terminal", jobId);

    const lease = await saveAcquisitionAdaptationLease(store, { originalJobId: input.jobId, approvalId: input.approvalId, installationId,
      jobId, attempt: (job?.attempt ?? 0) + 1, scope: input.scope, startedAt: at });
    if (!lease.ok) return lease;

    const started = await store.apply({ type: "start_job", commandId: `${jobId}:start:${(job?.attempt ?? 0) + 1}`, issuedAt: at, jobId });
    if (!started.ok || started.idempotent) return started.ok ? pipelineFailure("adaptation_not_claimed", jobId) : pipelineFailure(started.reason, started.detail);

    job = started.state.jobs.find(row => row.jobId === jobId)!;

    return { ok: true as const, completed: false as const, request, continuationJobId: jobId, admission: { jobId, attempt: job.attempt },
      requirements: requirements.requirements, ...(parent === undefined ? {} : { parent }),
      ...(predecessor === undefined ? {} : { predecessor }) };
  });

  return "reason" in result ? pipelineFailure(result.reason, result.detail) : result;
}

export async function runAcquisitionAdaptation(input: Selection & { readonly workspaceId: string; readonly installationRoot: string;
  readonly signal: AbortSignal; readonly services: (continuationJobId: string) => Promise<NpmAdaptationServices & { readonly release: () => Promise<void> }> }) {
  const claim = await claimAcquisitionAdaptation(input);
  if (!claim.ok || claim.completed) return claim;

  const monitor = monitorToolJob({ boardRoot: input.boardRoot, ...claim.admission, signal: input.signal,
    claimActive: state => acquisitionAdaptationClaimActive(state, { originalJobId: input.jobId, approvalId: input.approvalId,
      installationId: npmInstallId(claim.request.installation!), ...claim.admission, scope: input.scope, plan: claim.request.learningPlan, now: input.now() }) });
  let outcome: Awaited<ReturnType<typeof prepareNpmToolAdaptation>>;
  let services: Awaited<ReturnType<typeof input.services>> | undefined;
  let cleanupCode: ToolLearningCleanupCode | undefined;

  try {
    services = await input.services(claim.continuationJobId);
    outcome = await prepareNpmToolAdaptation({ ...input, plan: claim.request.learningPlan, installation: claim.request.installation!,
      adaptation: claim.request.decision.adaptation, admission: claim.admission, services, signal: monitor.signal, requirements: claim.requirements,
      acquisition: { jobId: input.jobId, decisionVersionId: input.approvalId }, ...(claim.parent === undefined ? {} : { parent: claim.parent }),
      ...(claim.predecessor === undefined ? {} : { predecessor: claim.predecessor }) });
  } catch {
    outcome = pipelineFailure(monitor.signal.aborted ? "cancelled" : "npm_adaptation_service_failed", "The funded adaptation step did not finish");
  } finally {
    monitor.close();
    if (services !== undefined) {
      try { await services.release(); }
      catch (error) { cleanupCode = toolLearningCleanupCode(error); } // Keep the actual construction outcome below.
    }
  }

  const saved = await withBoardWriter(input.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

    const job = loaded.state.jobs.find(row => row.jobId === claim.continuationJobId);
    if (job?.state !== "running" || job.attempt !== claim.admission.attempt) return pipelineFailure("stale_job_result", claim.continuationJobId);

    const at = new Date(input.now()).toISOString();
    const content = { type: "tool_acquisition_adaptation_result", schemaVersion: 1, originalJobId: input.jobId,
      jobId: job.jobId, attempt: job.attempt, approvalId: input.approvalId, ...outcome,
      ...(cleanupCode === undefined ? {} : { allowanceRelease: "failed", cleanupCode }) };
    const archived = await savePipelineAsset(store, { versionId: acquisitionAdaptationResultId(job.jobId, job.attempt), kind: "workflow",
      scope: input.scope, source: "inferred", issuedAt: at, content });
    if (!archived.ok) return archived;

    const terminal = await store.apply({ type: "complete_job", commandId: `${job.jobId}:terminal:${job.attempt}`, issuedAt: at,
      jobId: job.jobId, next: outcome.ok ? "waiting_approval" : "waiting_evidence" });

    return terminal.ok ? { ...outcome, continuationJobId: job.jobId, activated: false as const,
      ...(cleanupCode === undefined ? {} : { cleanupCode }) } : pipelineFailure(terminal.reason, terminal.detail);
  });

  return "reason" in saved ? pipelineFailure(saved.reason, saved.detail) : saved;
}
