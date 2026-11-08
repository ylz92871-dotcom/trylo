import type { CheckerAllowance, CheckerFeedback } from "../runtime/v2/contracts.js";
import type { createExecutableCheckLearning } from "../runtime/v2/runtime.js";
import { validAllowance } from "../adapters/board/store.js";
import { deriveCheckerVersionQualification } from "../runtime/v2/version-qualification.js";
import { isJsonValue, keysAre, recordOf } from "../../../../domains/tool/evolution/parse.js";

export type CheckLearningOperation = { readonly action: "status" | "recover" }
  | { readonly action: "learn"; readonly allowance: CheckerAllowance }
  | { readonly action: "capture" | "feedback"; readonly value: unknown };

export type CheckLearningOperationService = Pick<ReturnType<typeof createExecutableCheckLearning>,
  "learn" | "recover" | "capture" | "feedback" | "inspect">;

/** Allocation decisions precede host configuration, so zero quota constructs no provider or store. */
export function prepareCheckLearningOperation(operation: CheckLearningOperation) {
  if (operation.action === "learn" && !validAllowance(operation.allowance)) {
    return { ok: false, code: "invalid_check_allowance", message: "invalid checker learning allocation" };
  }

  if (operation.action === "learn" && (operation.allowance.modelCalls === 0 || operation.allowance.tokens === 0)) {
    return { ok: true, stop: "zero_allowance", usage: { modelCalls: 0, executions: 0, tokens: 0 }, jobs: [] };
  }

  return undefined;
}

/** The subsystem owns operation dispatch and its data projection; the host owns configuration and transport. */
export async function dispatchCheckLearningOperation(service: CheckLearningOperationService, operation: CheckLearningOperation,
  signal: AbortSignal) {
  const result = operation.action === "learn" ? await service.learn({ subsystem: "verifier", allowance: operation.allowance }, signal)
    : operation.action === "recover" ? await service.recover()
      : operation.action === "capture" ? await service.capture(operation.value)
        : operation.action === "feedback" ? await submitFeedback(service, operation.value, signal)
          : await service.inspect();
  if (operation.action === "status" && result.ok && "catalog" in result) {
    const catalog = result.catalog;
    return { disposition: "status" as const, result: { ok: true, sequence: result.state.sequence,
      counts: { experiences: catalog.experiences.length, versions: catalog.versions.length, runs: catalog.runs.length,
        feedbacks: catalog.feedbacks.length, jobs: catalog.results.length },
      versions: catalog.versions.map(entry => ({ versionId: entry.versionId, question: entry.value.checker.question,
        scope: entry.value.checker.applicability.scope, evaluation: entry.value.evaluation?.status ?? "working",
        qualification: deriveCheckerVersionQualification(catalog, entry.value) })),
      pendingJobs: catalog.leases.filter(lease => !catalog.results.some(result => result.jobId === lease.jobId))
        .map(lease => ({ jobId: lease.jobId, ownerId: lease.ownerId })),
      pendingChecks: catalog.runClaims.filter(claim => !catalog.runs.some(run => run.runId === claim.runId))
        .map(claim => ({ runId: claim.runId, ownerId: claim.ownerId })) } };
  }

  const failedJob = "jobs" in result && Array.isArray(result.jobs) && result.jobs.some(job => job.outcome === "failed");

  return { disposition: result.ok && !failedJob ? "succeeded" as const : "failed" as const, result };
}

async function submitFeedback(service: CheckLearningOperationService, raw: unknown, signal: AbortSignal) {
  if (!isJsonValue(raw) || !recordOf(raw) || !keysAre(raw, ["scope", "sessionId", "turnId", "sourceRef", "text", "runIds"], ["judgment", "appliesTo"])) {
    return { ok: false as const, code: "invalid_checker_feedback", message: "feedback JSON must contain exact source and run coordinates" };
  }
  return service.feedback(raw as Omit<CheckerFeedback, "schemaVersion" | "type">, signal);
}
