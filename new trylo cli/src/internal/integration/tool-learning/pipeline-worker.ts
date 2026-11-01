import { createBoardReader, withBoardWriter } from "../../adapters/learning-store/file-event-store.js";
import type { ToolEvolutionRequest } from "../../learning/domains/tool/evolution/contracts.js";
import type { ToolLearningPlan, ToolLearningResult, ToolDiscoverySummary, ToolGenerationTrace } from "../../learning/domains/tool/evolution/pipeline.js";
import { decodeDiscoverySummary, decodeToolLearningRecipe, decodeToolGenerationTrace, resultVersionId, TOOL_JOB_PREFIX, validToolPipelineJobs } from "../../learning/domains/tool/evolution/pipeline.js";
import { decodeToolEvolutionVerification } from "../../learning/domains/tool/evolution/artifact.js";
import type { ToolEvolutionOutcome } from "./evolution-runtime.js";
import { pipelineFailure, savePipelineAsset } from "./pipeline-assets.js";
import { candidateFromBoard } from "./evolution-reader.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { ToolJobAdmission } from "./evolution-archive.js";
import { monitorToolJob } from "./pipeline-monitor.js";
import { planForJob, recipeForPlan, resultForJob, waitingToolJobReady } from "./pipeline-queue.js";

export type ToolPipelineServices = {
  readonly executionAuthorized?: boolean;
  readonly search: (capability: string, signal: AbortSignal) => Promise<ToolDiscoverySummary>;
  readonly evolve: (request: ToolEvolutionRequest, signal: AbortSignal, feedback: string, admission: ToolJobAdmission) => Promise<ToolEvolutionOutcome>;
};
type WorkerInput = {
  readonly boardRoot: string; readonly scope: string; readonly now: () => number; readonly services: ToolPipelineServices;
  readonly mode: "manual" | "after_turn"; readonly signal: AbortSignal; readonly maxJobs?: number; readonly jobIds?: readonly string[];
};

/** Claims are serialized by Board; slow work always runs after releasing its writer. */
export async function workToolLearningPipeline(input: WorkerInput) {
  const limit = input.maxJobs ?? 1;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 3) return pipelineFailure("invalid_budget", "maxJobs must be in 1..3");
  const loaded = await createBoardReader(input.boardRoot).load();
  if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
  if (!validToolPipelineJobs(loaded.state)) return pipelineFailure("invalid_pipeline_job", "tool job namespace contains malformed persisted facts");
  const eligible = loaded.state.jobs.filter(job => job.jobId.startsWith(TOOL_JOB_PREFIX) && job.scope === input.scope
    && (input.jobIds === undefined || input.jobIds.includes(job.jobId)) && ["queued", "running", "waiting_evidence"].includes(job.state));
  const results: { readonly jobId: string; readonly code: string }[] = [];
  for (const job of eligible) {
    if (input.signal.aborted || results.length >= limit) break;
    const result = await runJob(input, job.jobId);
    // A competitor winning the claim is normal and costs no work budget.
    if (result.code !== undefined && result.code !== "not_claimed") results.push({ jobId: job.jobId, code: result.code });
  }
  return { ok: true as const, results, cancelled: input.signal.aborted };
}

async function runJob(input: WorkerInput, jobId: string) {
  const claim = await claimJob(input, jobId);
  if (!claim.ok || "code" in claim) return claim;
  const { plan, attempt, selected } = claim;
  const monitor = monitorToolJob({ boardRoot: input.boardRoot, jobId, attempt, signal: input.signal }), signal = monitor.signal;
  const occurredAt = () => new Date(input.now()).toISOString();
  let search: ToolDiscoverySummary = { status: "failed", candidates: [], failures: [] };
  let generation: ToolGenerationTrace | undefined;
  const base = () => ({ type: "tool_learning_result" as const, schemaVersion: 1 as const, jobId, attempt, search, occurredAt: occurredAt(),
    ...(selected === undefined ? {} : { recipeVersionId: selected.versionId }), ...(generation === undefined ? {} : { generation }) });
  let result: ToolLearningResult;
  try {
    const raw = await input.services.search(plan.capability, signal);
    const summary = decodeDiscoverySummary(raw);
    if (summary === undefined) throw new Error("search result exceeds the pipeline contract");
    search = summary;
    if (signal.aborted) result = { ...base(), outcome: "cancelled", code: "cancelled" };
    else if (selected === undefined) result = { ...base(), outcome: "waiting_evidence", code: "verification_recipe_required" };
    else if (input.mode === "after_turn" && selected.recipe.automation !== "after_turn") {
      result = { ...base(), outcome: "waiting_evidence", code: "manual_recipe" };
    } else if (input.mode === "after_turn" && input.services.executionAuthorized !== true) {
      result = { ...base(), outcome: "waiting_evidence", code: "execution_authorization_required" };
    } else {
      const outcome = await input.services.evolve({ ...selected.recipe.request, requestId: `${jobId}:${attempt}` }, signal,
        discoveryFeedback(search), { jobId, attempt });
      generation = generationTrace(outcome);
      result = outcome.kind === "candidate" ? { ...base(), outcome: "waiting_approval", code: "candidate_pending_review", candidateVersionId: outcome.versionId }
        : outcome.kind === "cancelled" ? { ...base(), outcome: "cancelled", code: "cancelled" }
        : { ...base(), outcome: "failed", code: outcome.code.slice(0, 160) || "evolution_failed" };
    }
  } catch (error) {
    // Provider/network details can contain credentials; persist only the stage class.
    result = { ...base(), outcome: signal.aborted ? "cancelled" : "failed", code: signal.aborted ? "cancelled" : "pipeline_service_failed" };
    if (!(error instanceof Error)) result = { ...result, code: signal.aborted ? "cancelled" : "pipeline_service_threw" };
  } finally {
    monitor.close();
  }
  const saved = await finishJob(input, plan, result);
  return saved.ok ? { ok: true as const, code: result.code } : saved;
}

function generationTrace(outcome: ToolEvolutionOutcome): ToolGenerationTrace {
  const report = outcome.kind === "candidate" ? outcome.artifact.verification : outcome.kind === "failed" ? outcome.verification : undefined;
  const verification = decodeToolEvolutionVerification(report);
  const trace = decodeToolGenerationTrace({ attempts: outcome.attempts,
    ...(outcome.kind !== "failed" || outcome.rejectionCode === undefined ? {} : { rejectionCode: outcome.rejectionCode }),
    ...(verification === undefined ? {} : { verification }) });
  if (trace === undefined) throw new Error("invalid generation diagnostics");
  return trace;
}

async function claimJob(input: WorkerInput, jobId: string) {
  const result = await withBoardWriter(input.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
    const job = loaded.state.jobs.find(item => item.jobId === jobId);
    const plan = planForJob(loaded.state, jobId);
    if (job === undefined || plan === undefined || plan.scope !== input.scope || job.scope !== plan.scope || job.domain !== "tool") return pipelineFailure("invalid_job_binding", jobId);
    if (job.state === "running") {
      const recorded = resultForJob(loaded.state, jobId, job.attempt);
      if (recorded === undefined) return pipelineFailure("running_job_requires_inspection", jobId);
      const applied = await store.apply(terminalCommand(recorded));
      return applied.ok ? { ok: true as const, code: "recovered_terminal" } : pipelineFailure(applied.reason, applied.detail);
    }
    const selected = recipeForPlan(loaded.state, plan);
    if (job.state === "waiting_evidence") {
      if (resultForJob(loaded.state, jobId, job.attempt) === undefined) return pipelineFailure("invalid_pipeline_result", jobId);
      if (!waitingToolJobReady(loaded.state, job, plan, input.mode, input.services.executionAuthorized === true)) return { ok: true as const, code: "not_claimed" };
      const requeued = await store.apply({ type: "requeue_job", commandId: `${jobId}:requeue:${job.attempt}`, issuedAt: new Date(input.now()).toISOString(), jobId, expectedAttempt: job.attempt });
      if (!requeued.ok) return pipelineFailure(requeued.reason, requeued.detail);
    } else if (job.state !== "queued") return { ok: true as const, code: "not_claimed" };
    const attempt = job.attempt + 1;
    const started = await store.apply({ type: "start_job", commandId: `${jobId}:start:${attempt}`, issuedAt: new Date(input.now()).toISOString(), jobId });
    if (!started.ok || started.idempotent) return started.ok ? { ok: true as const, code: "not_claimed" } : pipelineFailure(started.reason, started.detail);
    return { ok: true as const, plan, attempt, selected };
  });
  return "reason" in result ? pipelineFailure(result.reason, result.detail) : result;
}

async function finishJob(input: WorkerInput, plan: ToolLearningPlan, result: ToolLearningResult) {
  const saved = await withBoardWriter(input.boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);
    const job = loaded.state.jobs.find(item => item.jobId === result.jobId);
    if (job?.state !== "running" || job.attempt !== result.attempt) return pipelineFailure("stale_job_result", result.jobId);
    if (result.candidateVersionId !== undefined) {
      const candidate = candidateFromBoard(loaded.state, result.candidateVersionId);
      const selected = loaded.state.assets.find(asset => asset.versionId === result.recipeVersionId);
      if (!candidate.ok || selected === undefined || !candidateBindsRecipe(candidate.artifact.request, selected.content, plan, result)) {
        return pipelineFailure("candidate_recipe_binding_mismatch", result.jobId);
      }
    }
    const archived = await savePipelineAsset(store, { versionId: resultVersionId(result.jobId, result.attempt), kind: "workflow", content: result,
      scope: plan.scope, source: "inferred", issuedAt: result.occurredAt });
    if (!archived.ok) return archived;
    const applied = await store.apply(terminalCommand(result));
    return applied.ok ? { ok: true as const } : pipelineFailure(applied.reason, applied.detail);
  });
  return "reason" in saved ? pipelineFailure(saved.reason, saved.detail) : saved;
}

function candidateBindsRecipe(request: ToolEvolutionRequest, raw: unknown, plan: ToolLearningPlan, result: ToolLearningResult): boolean {
  const recipe = decodeToolLearningRecipe(raw);
  return recipe !== undefined && request.requestId === `${result.jobId}:${result.attempt}` && request.scope === plan.scope
    && request.capability === plan.capability && contentHashOf(request) === contentHashOf({ ...recipe.request, requestId: request.requestId });
}

function terminalCommand(result: ToolLearningResult) {
  const base = { commandId: `${result.jobId}:terminal:${result.attempt}`, issuedAt: result.occurredAt, jobId: result.jobId };
  return result.outcome === "waiting_approval" || result.outcome === "waiting_evidence"
    ? { ...base, type: "complete_job" as const, next: result.outcome }
    : { ...base, type: "fail_job" as const, terminal: result.outcome };
}

function discoveryFeedback(search: ToolDiscoverySummary): string {
  return `Public discovery metadata only; do not copy upstream code or claim an installation. Search status: ${search.status}.\n`
    + JSON.stringify(search.candidates.map(candidate => ({ platform: candidate.platform, id: candidate.id, sourceUrl: candidate.sourceUrl, license: candidate.licenseSpdx })));
}
