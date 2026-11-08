import { withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../control/hash.js";
import { toolLearningFundingClaimBelongsTo, toolLearningFundingIdentity } from "../domain/evolution/funding-identity.js";
import { frozenToolRecipeForResult } from "../domain/evolution/frozen-construction.js";
import { TOOL_GENERATION_INTERRUPTED } from "../domain/evolution/construction-stop.js";
import { resultVersionId, type ToolLearningResult } from "../domain/evolution/pipeline.js";
import { isDigest, isIsoTime } from "../domain/evolution/artifact.js";
import { recordOf, textOf } from "../domain/evolution/parse.js";
import { planForJob, resultForJob } from "./pipeline-records.js";
import { toolFundingGrantMatches } from "./tool-funding-grant.js";
import { pipelineFailure, savePipelineAsset } from "./pipeline-assets.js";

/** Explicit operator inspection after a confirmed worker exit. The original
 * funding owner must first settle/yield its lease, retaining unknown charges.
 * This records a lost tool-free generation, never a candidate or a refund. */
export async function checkpointInterruptedToolGeneration(options: { readonly boardRoot: string; readonly scope: string;
  readonly centralScope: string; readonly authorized: () => boolean }, input: {
  readonly jobId: string; readonly attempt: number; readonly evidenceRef: string; readonly evidenceHash: string;
  readonly observedAt: string; readonly executionId: string; readonly pid: number; readonly exitCode: number;
}, signal: AbortSignal) {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 2 || !textOf(input.evidenceRef, 512) || !isDigest(input.evidenceHash)
    || !isIsoTime(input.observedAt) || !textOf(input.executionId, 160) || !Number.isSafeInteger(input.pid) || input.pid < 1
    || !Number.isSafeInteger(input.exitCode)) return pipelineFailure("invalid_tool_interruption", "Exact stopped-worker evidence is required");

  const saved = await withBoardWriter(options.boardRoot, async board => {
    if (!options.authorized() || signal.aborted) return pipelineFailure("tool_learning_authorization_required", "Interruption inspection is inactive");

    const loaded = await board.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

    const state = loaded.state, job = state.jobs.find(row => row.jobId === input.jobId), plan = planForJob(state, input.jobId);
    if (job?.domain !== "tool" || job.scope !== options.scope || plan?.scope !== options.scope || job.attempt !== input.attempt) {
      return pipelineFailure("invalid_job_binding", "The inspected original attempt changed");
    }

    const previous = resultForJob(state, input.jobId, input.attempt - 1), current = resultForJob(state, input.jobId, input.attempt);
    const proofRef = `tool-interruption:${contentHashOf({ jobId: job.jobId, attempt: job.attempt })}`;

    if (current !== undefined) {
      const proof = state.assets.find(row => row.versionId === proofRef)?.content;
      if (current.code !== TOOL_GENERATION_INTERRUPTED || !recordOf(proof) || proof.evidenceHash !== input.evidenceHash) {
        return pipelineFailure("tool_interruption_result_exists", "Inspect the actual committed result instead of replacing it");
      }

      if (job.state === "running") {
        const terminal = await board.apply({ type: "complete_job", commandId: `${job.jobId}:terminal:${job.attempt}`,
          issuedAt: current.occurredAt, jobId: job.jobId, next: "waiting_evidence" });
        if (!terminal.ok) return pipelineFailure(terminal.reason, terminal.detail);
      }

      return { ok: true as const, resultRef: resultVersionId(job.jobId, job.attempt), duplicate: true };
    }

    const identity = toolLearningFundingIdentity(plan), grant = state.centralLearningGrants?.find(row => row.grantId === identity.grantId);
    if (job.state !== "running" || grant === undefined || grant.scope !== options.centralScope || grant.status !== "open"
      || !toolFundingGrantMatches(state, plan, grant) || grant.claim !== undefined || grant.reservations.some(row => row.state === "reserved")) {
      return pipelineFailure("tool_interruption_funding_unresolved", "The original funding owner must resolve its lease and pending reservations first");
    }

    const reservations = grant.reservations.filter(row => toolLearningFundingClaimBelongsTo(plan, job.jobId, job.attempt, row.claimId));
    if (reservations.length === 0 || reservations.some(row => row.state !== "settled")) return pipelineFailure("tool_interruption_reservation_required", "Keep the actual sent request and its original charge");

    if (state.assets.some(row => row.kind === "tool_package" && recordOf(row.content) && recordOf(row.content.request)
      && row.content.request.requestId === `${job.jobId}:${job.attempt}`)) {
      return pipelineFailure("tool_interruption_candidate_requires_recovery", "Recover the already archived candidate instead of generating another");
    }

    const frozen = frozenToolRecipeForResult(state, { jobId: job.jobId, attempt: input.attempt - 1 }, plan, previous);
    if (!frozen.ok) return frozen;

    if (previous === undefined || frozen.selected === undefined) return pipelineFailure("frozen_recipe_unavailable", "Do not replan a stopped generation");

    const proof = await savePipelineAsset(board, { versionId: proofRef, kind: "workflow", scope: plan.scope, source: "inferred", issuedAt: input.observedAt,
      content: { type: "tool_generation_interruption", schemaVersion: 1, scope: plan.scope, ...input,
        previousResultRef: resultVersionId(job.jobId, input.attempt - 1), reservationIds: reservations.map(row => row.reservationId),
        outcome: "sent_result_unknown", assessment: "Operator confirmed the worker stopped; no candidate or zero-cost assertion." },
      observations: [input.evidenceRef, ...reservations.map(row => row.reservationId)] });
    if (!proof.ok) return proof;

    const result: ToolLearningResult = { type: "tool_learning_result", schemaVersion: 1, jobId: job.jobId, attempt: job.attempt,
      outcome: "waiting_evidence", code: TOOL_GENERATION_INTERRUPTED, occurredAt: input.observedAt, search: previous.search,
      recipeVersionId: frozen.selected.versionId, generation: { attempts: reservations.length },
      ...(previous.decision === undefined ? {} : { decision: previous.decision }),
      ...(previous.decisionVersionId === undefined ? {} : { decisionVersionId: previous.decisionVersionId }) };
    const retained = await savePipelineAsset(board, { versionId: resultVersionId(job.jobId, job.attempt), kind: "workflow", scope: plan.scope,
      source: "inferred", issuedAt: input.observedAt, content: result, observations: [proofRef, frozen.selected.versionId] });
    if (!retained.ok) return retained;

    const terminal = await board.apply({ type: "complete_job", commandId: `${job.jobId}:terminal:${job.attempt}`,
      issuedAt: input.observedAt, jobId: job.jobId, next: "waiting_evidence" });

    return terminal.ok ? { ok: true as const, resultRef: retained.versionId, duplicate: false } : pipelineFailure(terminal.reason, terminal.detail);
  }, { commandGuard: () => options.authorized() && !signal.aborted });

  return "reason" in saved ? pipelineFailure(saved.reason, saved.detail) : saved;
}
