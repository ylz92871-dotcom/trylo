import { createBoardReader, withBoardWriter } from "../../../../../../adapters/learning-store/file-event-store.js";
import { contentHashOf } from "../../../../../control/hash.js";
import type { BoardStore } from "../../../../../control/store-port.js";
import type { BoardState } from "../../../../../control/state.js";
import { isJsonValue, jsonBytes, keysAre, recordOf, textOf } from "../../../../../domains/tool/evolution/parse.js";
import { parseCheckExperience, parseCheckInput, parseCheckRequirements,
  parseLearnedChecker } from "../../domain/v2/parse.js";
import { validateCheckEvaluation } from "../../domain/v2/evaluate.js";
import { isCheckAssetAvailable, saveCheckArtifact } from "./artifacts.js";
import { parseCheckerRunOutcome, parseCheckerRunRequest, runRequest, sameRunRequest } from "../../runtime/v2/run-identity.js";
import { parseCheckerFeedback } from "../../runtime/v2/feedback.js";
import { decodeGeneration, decodeGenerationStart, decodeGenerationEvaluation } from "./generation-record.js";
import { CHECKER_RUNS_PER_TURN } from "../../runtime/v2/contracts.js";
import type { CheckerCatalog, CheckerFailure, CheckerRecord, CheckerVersion, CheckerRun, CheckerRunClaim, CheckerFeedback,
  CheckerJobResult, CheckerLease, CheckerGeneration, CheckerGenerationStart, CheckerGenerationEvaluation } from "../../runtime/v2/contracts.js";

export function failure(code: string, message: string): CheckerFailure { return { ok: false, code, message }; }

export function checkerRecordId(value: CheckerRecord): string { return `checker:${value.type}:${contentHashOf(value)}`; }

export async function readCheckerBoard(boardRoot: string) {
  const loaded = await createBoardReader(boardRoot).load();
  if (!loaded.ok) return failure(loaded.reason, loaded.detail);
  const decoded = decodeCheckerCatalog(loaded.state);
  return decoded.ok ? { ok: true as const, state: loaded.state, catalog: decoded.catalog } : decoded;
}

/** The same Board writer owns v1 recipes and v2 methods; there is no private checker database. */
export async function saveCheckerRecord(boardRoot: string, value: CheckerRecord, issuedAt: string) {
  const result = await withBoardWriter(boardRoot, async store => {
    const loaded = await store.load();
    if (!loaded.ok) return failure(loaded.reason, loaded.detail);
    const decoded = decodeCheckerCatalog(loaded.state);
    if (!decoded.ok) return decoded;
    const conflict = identityConflict(decoded.catalog, value);
    if (conflict !== undefined) return conflict;
    if ((value.type === "checker_generation_started" || value.type === "checker_generation" || value.type === "checker_generation_evaluation")
      && decodeRecord(value, decoded.catalog) === undefined) return failure("invalid_checker_generation_record", value.type);
    return appendCheckerRecord(store, value, issuedAt);
  });
  return "reason" in result ? failure(result.reason, result.detail) : result;
}

export async function appendCheckerRecord(store: BoardStore, value: CheckerRecord, issuedAt: string) {
  return saveCheckArtifact(store, { versionId: checkerRecordId(value), kind: value.type === "checker_version" ? "verification_recipe" : "workflow",
    content: value, scope: value.type === "checker_version" ? value.checker.applicability.scope : value.scope,
    source: value.type === "checker_feedback" ? "user_explicit" : "inferred", sourceRefs: sources(value), issuedAt,
    hypothesis: value.type === "checker_version" ? value.checker.question : `Attributed ${value.type}`,
    ...(value.type !== "checker_version" || value.checker.parentVersionId === undefined ? {} : { parentVersionId: value.checker.parentVersionId }) });
}

export function decodeCheckerCatalog(state: BoardState): { readonly ok: true; readonly catalog: CheckerCatalog } | CheckerFailure {
  const catalog = { experiences: [] as CheckerCatalog["experiences"][number][], versions: [] as CheckerCatalog["versions"][number][],
    runs: [] as CheckerRun[], runClaims: [] as CheckerRunClaim[], feedbacks: [] as CheckerFeedback[], results: [] as CheckerJobResult[], leases: [] as CheckerLease[],
    generationStarts: [] as CheckerGenerationStart[], generations: [] as CheckerGeneration[], generationEvaluations: [] as CheckerGenerationEvaluation[] };

  for (const asset of state.assets.filter(item => item.versionId.startsWith("checker:"))) {
    if (!isCheckAssetAvailable(state, asset)) return failure("checker_artifact_unavailable", asset.versionId);

    const record = decodeRecord(asset.content, catalog);
    if (record === undefined || checkerRecordId(record) !== asset.versionId
      || (record.type === "checker_version" ? record.checker.applicability.scope : record.scope) !== asset.scope
      || (record.type === "checker_version" ? record.checker.parentVersionId : undefined) !== asset.parentVersionId
      || identityConflict(catalog, record) !== undefined) return failure("checker_store_corrupt", asset.versionId);

    switch (record.type) {
      case "check_experience": catalog.experiences.push({ versionId: asset.versionId, value: record }); break;
      case "checker_version": catalog.versions.push({ versionId: asset.versionId, value: record }); break;
      case "checker_run": catalog.runs.push(record); break;
      case "checker_run_claim": catalog.runClaims.push(record); break;
      case "checker_feedback": catalog.feedbacks.push(record); break;
      case "checker_job_result": catalog.results.push(record); break;
      case "checker_lease": catalog.leases.push(record); break;
      case "checker_generation_started": catalog.generationStarts.push(record); break;
      case "checker_generation": catalog.generations.push(record); break;
      case "checker_generation_evaluation": catalog.generationEvaluations.push(record); break;
    }
  }

  return { ok: true, catalog };
}

function decodeRecord(raw: unknown, catalog: CheckerCatalog): CheckerRecord | undefined {
  if (!isJsonValue(raw) || jsonBytes(raw) > 600_000 || !recordOf(raw) || raw.schemaVersion !== 2) return undefined;

  if (raw.type === "check_experience") {
    const parsed = parseCheckExperience(raw);
    return parsed.ok ? parsed.value : undefined;
  }

  if (raw.type === "checker_version") return decodeVersion(raw, catalog);

  if (raw.type === "checker_generation_started") return decodeGenerationStart(raw, catalog);

  if (raw.type === "checker_generation") return decodeGeneration(raw, catalog);

  if (raw.type === "checker_generation_evaluation") return decodeGenerationEvaluation(raw, catalog);

  if (raw.type === "checker_run") return decodeRun(raw, catalog);

  if (raw.type === "checker_run_claim") return decodeRunClaim(raw, catalog);

  if (raw.type === "checker_feedback") return parseCheckerFeedback(raw, catalog);

  if (raw.type === "checker_job_result") {
    if (!keysAre(raw, ["schemaVersion", "type", "jobId", "scope", "outcome", "reason", "usage"], ["versionId"])
      || !identities(raw, ["jobId", "scope", "reason"]) || !["generated", "no_change", "rejected", "failed", "cancelled"].includes(String(raw.outcome))
      || !validAllowance(raw.usage) || (raw.versionId !== undefined && !catalog.versions.some(version => version.versionId === raw.versionId))) return undefined;
    return structuredClone(raw) as CheckerJobResult;
  }

  if (raw.type === "checker_lease") {
    if (!keysAre(raw, ["schemaVersion", "type", "jobId", "scope", "ownerId", "allowance", "basis"])
      || !identities(raw, ["jobId", "scope", "ownerId", "basis"]) || !validAllowance(raw.allowance)) return undefined;
    return structuredClone(raw) as CheckerLease;
  }

  return undefined;
}

function decodeVersion(raw: Record<string, unknown>, catalog: CheckerCatalog): CheckerVersion | undefined {
  if (!keysAre(raw, ["schemaVersion", "type", "checker", "requirements", "experienceRefs", "generation"], ["evaluation", "validationSamples"])
    || !Array.isArray(raw.experienceRefs) || raw.experienceRefs.length > 32 || raw.experienceRefs.length === 0
    || !raw.experienceRefs.every(ref => catalog.experiences.some(item => item.versionId === ref)) || !recordOf(raw.generation)
    || !keysAre(raw.generation, ["requestId", "model", "usage"], ["exposedInputs"]) || !identities(raw.generation, ["requestId", "model"])
    || (raw.generation.exposedInputs !== undefined && (!Array.isArray(raw.generation.exposedInputs) || raw.generation.exposedInputs.length > 2048
      || !raw.generation.exposedInputs.every(value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value))))
    || !recordOf(raw.generation.usage) || !keysAre(raw.generation.usage, ["inputTokens", "outputTokens"])
    || !count(raw.generation.usage.inputTokens) || !count(raw.generation.usage.outputTokens)) return undefined;

  const checker = parseLearnedChecker(raw.checker), requirements = parseCheckRequirements(raw.requirements);
  if (!checker.ok || !requirements.ok || checker.value.applicability.requirementRef !== requirements.value.ref
    || checker.value.applicability.requirementDigest !== requirements.value.digest) return undefined;

  if (checker.value.parentVersionId !== undefined && !catalog.versions.some(item => item.versionId === checker.value.parentVersionId
    && item.value.requirements.ref === requirements.value.ref && item.value.requirements.digest === requirements.value.digest
    && item.value.checker.applicability.scope === checker.value.applicability.scope)) return undefined;

  if ((raw.evaluation === undefined) !== (raw.validationSamples === undefined)) return undefined;

  if (raw.evaluation !== undefined && !validEvaluation(raw.evaluation, raw.validationSamples, checker.value)) return undefined;

  return structuredClone(raw) as CheckerVersion;
}

function decodeRun(raw: Record<string, unknown>, catalog: CheckerCatalog): CheckerRun | undefined {
  if (!keysAre(raw, ["schemaVersion", "type", "runId", "versionId", "scope", "sessionId", "turnId", "requirements", "input", "inputDigest", "outcome"])
    || !identities(raw, ["runId", "versionId", "scope", "sessionId", "turnId", "inputDigest"]) || !recordOf(raw.outcome)) return undefined;

  const version = catalog.versions.find(item => item.versionId === raw.versionId), input = parseCheckInput(raw.input), requirements = parseCheckRequirements(raw.requirements);
  if (version === undefined || !input.ok || !requirements.ok || input.value.task.requirementDigest !== requirements.value.digest
    || requirements.value.ref !== version.value.requirements.ref || requirements.value.digest !== version.value.requirements.digest || raw.inputDigest !== contentHashOf(input.value)
    || raw.scope !== version.value.checker.applicability.scope) return undefined;

  const claim = catalog.runClaims.find(item => item.runId === raw.runId);
  if (claim === undefined || !sameRunRequest(claim, raw as CheckerRun)) return undefined;

  if (parseCheckerRunOutcome(raw.outcome, requirements.value.ref) === undefined) return undefined;

  return structuredClone(raw) as CheckerRun;
}

function decodeRunClaim(raw: Record<string, unknown>, catalog: CheckerCatalog): CheckerRunClaim | undefined {
  if (!keysAre(raw, ["schemaVersion", "type", "runId", "versionId", "scope", "sessionId", "turnId", "inputDigest", "ownerId", "requirements", "input"])
    || !textOf(raw.ownerId, 512)) return undefined;

  const parsed = parseCheckerRunRequest(runRequest(raw as CheckerRunClaim));
  const version = catalog.versions.find(item => item.versionId === raw.versionId);
  if (!parsed.ok || version === undefined || version.value.checker.applicability.scope !== parsed.value.scope
    || version.value.requirements.ref !== parsed.value.requirements.ref || version.value.requirements.digest !== parsed.value.requirements.digest
    || catalog.runClaims.filter(item => item.scope === raw.scope && item.sessionId === raw.sessionId && item.turnId === raw.turnId).length >= CHECKER_RUNS_PER_TURN) return undefined;

  return structuredClone(raw) as CheckerRunClaim;
}

function validEvaluation(raw: unknown, samples: unknown, checker: CheckerVersion["checker"]): boolean {
  return validateCheckEvaluation(raw, samples, checker);
}

export function validAllowance(value: unknown): value is { modelCalls: number; executions: number; tokens: number } {
  return recordOf(value) && keysAre(value, ["modelCalls", "executions", "tokens"])
    && count(value.modelCalls) && value.modelCalls <= 32 && count(value.executions) && value.executions <= 256
    && count(value.tokens) && value.tokens <= 262_144;
}

function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

function identities(raw: Record<string, unknown>, names: readonly string[]): boolean { return names.every(name => textOf(raw[name], 512)); }

function sources(value: CheckerRecord): readonly string[] {
  switch (value.type) {
    case "check_experience": return [value.id, value.requirements.ref, ...value.priorRuns];
    case "checker_version": return value.experienceRefs;
    case "checker_run": return [value.runId, value.versionId, value.requirements.ref];
    case "checker_run_claim": return [value.runId, value.versionId, value.requirements.ref, value.ownerId];
    case "checker_feedback": return [value.sourceRef, ...value.runIds];
    case "checker_lease": return [value.jobId, value.basis];
    case "checker_job_result": return [value.jobId];
    case "checker_generation_started": return [value.jobId, ...value.experienceRefs];
    case "checker_generation": return [value.jobId, value.requestId];
    case "checker_generation_evaluation": return [value.jobId, value.requestId];
  }
}

function identityConflict(catalog: CheckerCatalog, value: CheckerRecord): CheckerFailure | undefined {
  const previous = value.type === "check_experience" ? catalog.experiences.find(item => item.value.id === value.id)?.value
    : value.type === "checker_run" ? catalog.runs.find(item => item.runId === value.runId)
      : value.type === "checker_run_claim" ? catalog.runClaims.find(item => item.runId === value.runId)
      : value.type === "checker_feedback" ? catalog.feedbacks.find(item => item.sourceRef === value.sourceRef)
        : value.type === "checker_job_result" ? catalog.results.find(item => item.jobId === value.jobId)
          : value.type === "checker_lease" ? catalog.leases.find(item => item.jobId === value.jobId)
            : value.type === "checker_generation_started" ? catalog.generationStarts.find(item => item.requestId === value.requestId)
              : value.type === "checker_generation" ? catalog.generations.find(item => item.requestId === value.requestId)
                : value.type === "checker_generation_evaluation" ? catalog.generationEvaluations.find(item => item.requestId === value.requestId) : undefined;
  return previous !== undefined && contentHashOf(previous) !== contentHashOf(value) ? failure("checker_identity_conflict", value.type) : undefined;
}
