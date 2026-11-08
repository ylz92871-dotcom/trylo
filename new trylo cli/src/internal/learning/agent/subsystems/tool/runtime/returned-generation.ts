import { withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { BoardState } from "../../../../control/state.js";
import { contentHashOf } from "../../../../control/hash.js";
import { committedToolRecipeForResult, toolReturnReviewRef } from "../domain/evolution/frozen-construction.js";
import { toolLearningFundingIdentity, toolLearningFundingClaimBelongsTo } from "../domain/evolution/funding-identity.js";
import { parseToolEvolutionCandidate, keysAre, recordOf, textOf } from "../domain/evolution/parse.js";
import { isIsoTime } from "../domain/evolution/artifact.js";
import { resultVersionId } from "../domain/evolution/pipeline.js";
import type { ToolEvolutionVerifier } from "../domain/evolution/verification.js";
import { planForJob, resultForJob } from "./pipeline-records.js";
import { toolFundingGrantMatches } from "./tool-funding-grant.js";
import { assetAvailable, pipelineFailure, savePipelineAsset } from "./pipeline-assets.js";
import { candidateFromBoard } from "./evolution-reader.js";
import { createToolEvolutionArchive } from "./evolution-archive.js";
import { acceptToolEvolutionCandidate } from "./evolution-runtime.js";

type Returned = { readonly jobId: string; readonly attempt: number; readonly reservationId: string; readonly model: string;
  readonly responseText: string; readonly evidenceRef: string; readonly returnedAt: string };

const recoveryRef = (jobId: string, attempt: number) => `tool-returned-generation:${contentHashOf({ jobId, attempt })}`;

/** Read the original failed request, not a new recipe or a replacement wallet.
 * This narrow route materializes a complete response stopped by its known
 * accounting overrun. The original failed result and all charges remain. */
function returnedSource(state: BoardState, scope: string, input: Returned) {
  const job = state.jobs.find(row => row.jobId === input.jobId), plan = planForJob(state, input.jobId);
  const result = resultForJob(state, input.jobId, input.attempt);
  if (job?.domain !== "tool" || job.scope !== scope || job.attempt !== input.attempt || plan?.scope !== scope
    || result?.outcome !== "failed" || result.candidateVersionId !== undefined) return pipelineFailure("tool_return_binding_changed", "The original failed generation must remain exact");

  const identity = toolLearningFundingIdentity(plan), grant = state.centralLearningGrants?.find(row => row.grantId === identity.grantId);
  const reservation = grant?.reservations.find(row => row.reservationId === input.reservationId);
  const knownOverrun = grant?.status === "closed" && reservation?.usage?.kind === "reported" && reservation.usage.totalTokens > reservation.maxTokens;
  const receipt = state.assets.find(row => row.versionId === `tool-late-usage:${contentHashOf({ reservationId: input.reservationId, evidenceRef: input.evidenceRef })}`);
  const measured = receipt?.content;
  const measuredReturn = receipt?.kind === "workflow" && receipt.scope === scope && receipt.source === "inferred" && assetAvailable(state, receipt)
    && recordOf(measured) && measured.type === "tool_complete_return_usage_receipt" && measured.schemaVersion === 1
    && measured.jobId === job.jobId && measured.attempt === job.attempt && measured.reservationId === input.reservationId
    && measured.evidenceRef === input.evidenceRef && measured.returnedAt === input.returnedAt
    && measured.responseTextHash === contentHashOf(input.responseText) && reservation?.usage !== undefined
    && contentHashOf(measured.usage) === contentHashOf(reservation.usage);
  const completeReturn = grant?.status === "open" && result.code === "provider_error" && result.cleanupCode === undefined
    && measuredReturn && result.generation !== undefined && result.generation.verification === undefined && grant.reservations.every(row => row.state === "settled");
  if (grant === undefined || !toolFundingGrantMatches(state, plan, grant) || !(knownOverrun || completeReturn) || grant.claim !== undefined
    || reservation?.state !== "settled" || reservation.usage?.kind !== "reported" || reservation.usage.model !== input.model
    || !toolLearningFundingClaimBelongsTo(plan, job.jobId, job.attempt, reservation.claimId)) {
    return pipelineFailure("tool_return_accounting_unresolved", "The complete returned request needs its exact measured settlement and no active lease; recovery never refuels it");
  }

  const frozen = committedToolRecipeForResult(state, job, plan, result);
  if (!frozen.ok) return frozen;

  if (frozen.selected === undefined) return pipelineFailure("frozen_recipe_unavailable", "Do not buy another plan to recover returned data");

  const request = { ...frozen.selected.recipe.request, requestId: `${job.jobId}:${job.attempt}` };
  const candidate = parseToolEvolutionCandidate(input.responseText, request.prior?.source);
  if (!candidate.ok) return candidate;

  return { ok: true as const, job, result, request, candidate: candidate.value, reservation,
    recipeVersionId: frozen.selected.versionId, sourceResultRef: resultVersionId(job.jobId, job.attempt) };
}

/** A recovered candidate remains quarantined and requires the normal explicit
 * trial/Permission paths. Receipt data and qualification never activate it. */
export function recoveredToolGenerationFromBoard(state: BoardState, jobId: string, attempt: number) {
  const asset = state.assets.find(row => row.versionId === recoveryRef(jobId, attempt)), raw = asset?.content;
  if (asset?.kind !== "workflow" || !assetAvailable(state, asset) || !recordOf(raw) || !keysAre(raw,
    ["type", "schemaVersion", "scope", "jobId", "attempt", "reservationId", "model", "responseText", "evidenceRef", "returnedAt",
      "sourceResultRef", "sourceResultHash", "requestHash", "candidateHash", "candidateVersionId"])
    || raw.type !== "tool_learning_generation_recovery" || raw.schemaVersion !== 1 || raw.jobId !== jobId || raw.attempt !== attempt
    || typeof raw.scope !== "string" || asset.scope !== raw.scope || typeof raw.responseText !== "string"
    || ![raw.reservationId, raw.model, raw.evidenceRef, raw.returnedAt, raw.sourceResultRef, raw.sourceResultHash,
      raw.requestHash, raw.candidateHash, raw.candidateVersionId].every(value => typeof value === "string")) {
    return pipelineFailure("tool_return_recovery_unavailable", "No exact qualified return recovery is available");
  }

  const input: Returned = { jobId, attempt, reservationId: String(raw.reservationId), model: String(raw.model), responseText: raw.responseText,
    evidenceRef: String(raw.evidenceRef), returnedAt: String(raw.returnedAt) };
  const source = returnedSource(state, raw.scope, input);
  if (!source.ok) return source;

  const candidate = candidateFromBoard(state, String(raw.candidateVersionId));
  if (!candidate.ok) return candidate;

  if (raw.sourceResultRef !== source.sourceResultRef || raw.sourceResultHash !== contentHashOf(source.result)
    || raw.requestHash !== contentHashOf(source.request) || raw.candidateHash !== contentHashOf(source.candidate)
    || contentHashOf(candidate.artifact.request) !== raw.requestHash || contentHashOf(candidate.artifact.candidate) !== raw.candidateHash
    || candidate.artifact.generatedAt !== input.returnedAt) return pipelineFailure("tool_return_recovery_mismatch", "The recovered version must bind the original complete public response and frozen checks");

  return { ok: true as const, recoveryRef: asset.versionId, candidateVersionId: candidate.versionId, artifact: candidate.artifact };
}

export async function recoverReturnedToolGeneration(options: { readonly boardRoot: string; readonly scope: string;
  readonly authorized: () => boolean; readonly verifier: ToolEvolutionVerifier }, input: Returned, signal: AbortSignal) {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 || !textOf(input.evidenceRef, 512) || !isIsoTime(input.returnedAt)) {
    return pipelineFailure("invalid_tool_return", "Exact public response evidence and canonical return time are required");
  }

  const prepared = await withBoardWriter(options.boardRoot, async board => {
    if (!options.authorized() || signal.aborted) return pipelineFailure("tool_learning_authorization_required", "Return recovery is inactive");

    const loaded = await board.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

    const source = returnedSource(loaded.state, options.scope, input);
    if (!source.ok) return source;

    const recovered = recoveredToolGenerationFromBoard(loaded.state, input.jobId, input.attempt);
    if (recovered.ok) return { ...source, existing: recovered.candidateVersionId };

    const matches = loaded.state.assets.filter(row => row.kind === "tool_package" && row.scope === options.scope).flatMap(row => {
      const found = candidateFromBoard(loaded.state, row.versionId);
      return found.ok && found.artifact.generatedAt === input.returnedAt && contentHashOf(found.artifact.request) === contentHashOf(source.request)
        && contentHashOf(found.artifact.candidate) === contentHashOf(source.candidate) ? [found.versionId] : [];
    });
    if (matches.length > 1) return pipelineFailure("tool_return_candidate_conflict", "Inspect competing committed return versions");

    return { ...source, existing: matches[0] };
  });
  if (!prepared.ok) return "reason" in prepared ? pipelineFailure(prepared.reason, prepared.detail) : prepared;

  let candidateVersionId = prepared.existing;
  if (candidateVersionId === undefined) {
    // The generation job already has an immutable failure. Use the existing
    // manual archival boundary after exact source checks, rather than falsify
    // running ownership or repeat the paid request. Qualification is unchanged.
    const accepted = await acceptToolEvolutionCandidate({ verifier: options.verifier, archive: createToolEvolutionArchive(options.boardRoot),
      now: () => Date.parse(input.returnedAt) }, prepared.request, prepared.candidate, signal, 1);
    if (accepted.kind === "failed" && accepted.code === "sample_checks_failed" && accepted.verification?.verdict === "fail") {
      const verification = accepted.verification;
      const reviewed = await withBoardWriter(options.boardRoot, async board => {
        if (!options.authorized() || signal.aborted) return pipelineFailure("tool_learning_authorization_required", "Return review is inactive");

        const loaded = await board.load();
        if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

        const source = returnedSource(loaded.state, options.scope, input);
        if (!source.ok) return source;

        if (contentHashOf(source.request) !== contentHashOf(prepared.request) || contentHashOf(source.candidate) !== contentHashOf(prepared.candidate)) {
          return pipelineFailure("tool_return_candidate_mismatch", "The exact received candidate changed during local qualification");
        }

        return savePipelineAsset(board, { versionId: toolReturnReviewRef(input.jobId, input.attempt), kind: "workflow", scope: options.scope,
          source: "inferred", issuedAt: input.returnedAt, content: { type: "tool_generation_return_rejection", schemaVersion: 1, ...input,
            sourceResultHash: contentHashOf(source.result), recipeVersionId: source.recipeVersionId, requestHash: contentHashOf(source.request), verification },
          observations: [source.sourceResultRef, source.recipeVersionId, input.reservationId, input.evidenceRef] });
      });
      if (!reviewed.ok) return reviewed;
    }

    if (accepted.kind !== "candidate") return accepted.kind === "failed" ? { ok: false as const, code: accepted.code,
      message: accepted.message, ...(accepted.verification === undefined ? {} : { verification: accepted.verification }) }
      : pipelineFailure("learning_aborted", "Return qualification was cancelled");

    candidateVersionId = accepted.versionId;
  }

  const version = candidateVersionId;
  const saved = await withBoardWriter(options.boardRoot, async board => {
    if (!options.authorized() || signal.aborted) return pipelineFailure("tool_learning_authorization_required", "Return recovery is inactive");

    const loaded = await board.load();
    if (!loaded.ok) return pipelineFailure(loaded.reason, loaded.detail);

    const source = returnedSource(loaded.state, options.scope, input);
    if (!source.ok) return source;

    const candidate = candidateFromBoard(loaded.state, version);
    if (!candidate.ok) return candidate;

    if (contentHashOf(candidate.artifact.request) !== contentHashOf(source.request) || contentHashOf(candidate.artifact.candidate) !== contentHashOf(source.candidate)
      || candidate.artifact.generatedAt !== input.returnedAt) return pipelineFailure("tool_return_candidate_mismatch", "Keep the exact returned candidate");

    const retained = await savePipelineAsset(board, { versionId: recoveryRef(input.jobId, input.attempt), kind: "workflow", scope: options.scope,
      source: "inferred", issuedAt: input.returnedAt, content: { type: "tool_learning_generation_recovery", schemaVersion: 1, scope: options.scope, ...input,
        sourceResultRef: source.sourceResultRef, sourceResultHash: contentHashOf(source.result), requestHash: contentHashOf(source.request),
        candidateHash: contentHashOf(source.candidate), candidateVersionId: version }, observations: [source.sourceResultRef, source.recipeVersionId, input.reservationId, input.evidenceRef, version] });

    return retained.ok ? { ok: true as const, recoveryRef: retained.versionId, candidateVersionId: version, apiCalls: 0 } : retained;
  });

  return "reason" in saved ? pipelineFailure(saved.reason, saved.detail) : saved;
}
