import { contentHashOf } from "../../../../../control/hash.js";
import type { BoardState } from "../../../../../control/state.js";
import type { LearningAssetVersion } from "../../../../../control/contracts.js";
import { parseCheckObservation } from "../../domain/legacy/parse.js";
import { assessCheckImprovement, prepareCheckImprovement } from "../../domain/legacy/algorithm.js";
import type { CheckObservation, CheckValidationReports } from "../../domain/legacy/contracts.js";
import type { ToolLearningRecipe } from "../../../../../domains/tool/evolution/pipeline.js";
import type { ToolEvolutionVerification } from "../../../../../domains/tool/evolution/verification.js";
import { hasExactSampleCoverage } from "../../../../../domains/tool/evolution/verification.js";
import { isJsonValue, jsonBytes, keysAre, recordOf, textOf } from "../../../../../domains/tool/evolution/parse.js";
import { isCheckAssetAvailable, type CheckBoardFailure } from "./artifacts.js";

export type CheckRecipe = { readonly type: "check_recipe"; readonly schemaVersion: 1; readonly observationRef: string;
  readonly recipe: ToolLearningRecipe; readonly reports: CheckValidationReports };

export type CheckLesson = { readonly type: "check_lesson"; readonly schemaVersion: 1; readonly observationRef: string;
  readonly outcome: "trial_supported" | "rejected" | "cancelled" | "unavailable"; readonly reason: string; readonly recipeVersionId?: string;
  readonly attempts?: readonly { readonly role: "baseline" | "faulty" | "valid"; readonly report: ToolEvolutionVerification }[] };

export type CheckRun = { readonly type: "check_run"; readonly schemaVersion: 1; readonly runId: string; readonly taskId: string;
  readonly scope: string; readonly capability: string; readonly requirementRef: string; readonly recipeVersionId: string;
  readonly report: ToolEvolutionVerification };

export type CheckFeedback = { readonly type: "check_feedback"; readonly schemaVersion: 1; readonly runId: string;
  readonly sourceRef: string; readonly kind: "confirmed" | "false_negative" | "false_positive" };

export type RecipeEntry = { readonly versionId: string; readonly content: CheckRecipe; readonly observation: CheckObservation;
  readonly parentVersionId?: string };

export type CheckCatalog = { readonly observations: readonly { readonly versionId: string; readonly value: CheckObservation }[];
  readonly started: readonly string[]; readonly lessons: readonly CheckLesson[]; readonly recipes: readonly RecipeEntry[];
  readonly runs: readonly CheckRun[]; readonly feedbacks: readonly CheckFeedback[] };

export function checkFailure(code: string, message: string): CheckBoardFailure { return { ok: false, code, message }; }

export function recordId(kind: string, content: unknown): string { return `check:${kind}:${contentHashOf(content)}`; }

/** Decode the namespace as one causal graph. Unknown versions and dangling links never become executable recipes. */
export function decodeCheckCatalog(state: BoardState): { readonly ok: true; readonly catalog: CheckCatalog } | CheckBoardFailure {
  const catalog = { observations: [] as { versionId: string; value: CheckObservation }[], started: [] as string[],
    lessons: [] as CheckLesson[], recipes: [] as RecipeEntry[], runs: [] as CheckRun[], feedbacks: [] as CheckFeedback[] };

  for (const asset of state.assets.filter(item => item.versionId.startsWith("check:"))) {
    if (!isCheckAssetAvailable(state, asset)) return checkFailure("check_artifact_unavailable", asset.versionId);
    const value = asset.content;
    if (!recordOf(value) || value.schemaVersion !== 1 || !isJsonValue(value) || jsonBytes(value) > 600 * 1024
      || !decodeRecord(asset, value, catalog)) return checkFailure("check_catalog_corrupt", asset.versionId);
  }

  if (new Set(catalog.observations.map(item => item.value.observationId)).size !== catalog.observations.length
    || new Set(catalog.runs.map(item => item.runId)).size !== catalog.runs.length
    || catalog.feedbacks.some((item, index) => catalog.feedbacks.slice(0, index).some(previous => previous.runId === item.runId
      && previous.sourceRef === item.sourceRef && previous.kind !== item.kind))) return checkFailure("check_catalog_corrupt", "conflicting causal identities");

  return { ok: true, catalog };
}

function decodeRecord(asset: LearningAssetVersion, value: Record<string, unknown>, catalog: {
  observations: { versionId: string; value: CheckObservation }[]; started: string[]; lessons: CheckLesson[];
  recipes: RecipeEntry[]; runs: CheckRun[]; feedbacks: CheckFeedback[];
}): boolean {
  if (value.type === "check_observation") {
    const parsed = parseCheckObservation(value);
    if (!parsed.ok || asset.kind !== "workflow" || asset.scope !== parsed.value.scope
      || asset.versionId !== recordId("observation", parsed.value)) return false;
    if (!correctionMatches(catalog, parsed.value)) return false;
    catalog.observations.push({ versionId: asset.versionId, value: parsed.value });
    return true;
  }

  const observation = catalog.observations.find(item => item.versionId === value.observationRef);

  if (value.type === "check_started") {
    if (!keysAre(value, ["type", "schemaVersion", "observationRef"]) || observation === undefined
      || asset.scope !== observation.value.scope || asset.versionId !== recordId("started", value)) return false;
    catalog.started.push(observation.versionId);
    return true;
  }

  if (value.type === "check_recipe") {
    if (!keysAre(value, ["type", "schemaVersion", "observationRef", "recipe", "reports"]) || observation === undefined
      || asset.kind !== "verification_recipe" || asset.scope !== observation.value.scope
      || asset.versionId !== recordId("recipe", value) || !recordOf(value.reports)) return false;

    const plan = prepareCheckImprovement(observation.value);
    const reports = decodeReports(value.reports);
    if (!plan.ok || reports === undefined || contentHashOf(plan.value.recipe) !== contentHashOf(value.recipe)
      || !assessCheckImprovement(plan.value, reports).ok
      || asset.parentVersionId !== observation.value.correction?.targetVersionId) return false;

    const content: CheckRecipe = { type: "check_recipe", schemaVersion: 1, observationRef: observation.versionId,
      recipe: plan.value.recipe, reports };

    catalog.recipes.push({ versionId: asset.versionId, content, observation: observation.value,
      ...(asset.parentVersionId === undefined ? {} : { parentVersionId: asset.parentVersionId }) });
    return true;
  }

  if (value.type === "check_lesson") {
    if (!keysAre(value, ["type", "schemaVersion", "observationRef", "outcome", "reason"], ["recipeVersionId", "attempts"])
      || observation === undefined || asset.scope !== observation.value.scope || asset.versionId !== recordId("lesson", value)
      || !textOf(value.reason, 512) || !["trial_supported", "rejected", "cancelled", "unavailable"].includes(String(value.outcome))
      || (value.outcome === "trial_supported" ? !catalog.recipes.some(item => item.versionId === value.recipeVersionId
        && item.content.observationRef === value.observationRef) : value.recipeVersionId !== undefined)
      || !validAttempts(value.attempts, observation.value)) return false;

    catalog.lessons.push(value as CheckLesson);
    return true;
  }

  if (value.type === "check_run") {
    const recipe = catalog.recipes.find(item => item.versionId === value.recipeVersionId);
    const report = decodeReport(value.report);
    if (!keysAre(value, ["type", "schemaVersion", "runId", "taskId", "scope", "capability", "requirementRef", "recipeVersionId", "report"])
      || recipe === undefined || report === undefined || !textOf(value.runId, 160) || !textOf(value.taskId, 160)
      || value.scope !== asset.scope || value.scope !== recipe.observation.scope || value.capability !== recipe.observation.capability
      || value.requirementRef !== recipe.observation.requirementRef || asset.versionId !== recordId("run", value)
      || (report.verdict !== "unavailable" && report.verdict !== "cancelled" && !hasExactSampleCoverage(recipe.content.recipe.request, report))
      || report.samplesHash !== contentHashOf(recipe.content.recipe.request.evidence)) return false;

    catalog.runs.push(value as CheckRun);
    return true;
  }

  if (value.type === "check_feedback") {
    const run = catalog.runs.find(item => item.runId === value.runId);
    if (!keysAre(value, ["type", "schemaVersion", "runId", "sourceRef", "kind"]) || run === undefined
      || run.scope !== asset.scope || !textOf(value.sourceRef, 512) || !["confirmed", "false_negative", "false_positive"].includes(String(value.kind))
      || asset.versionId !== recordId("feedback", value)) return false;
    catalog.feedbacks.push(value as CheckFeedback);
    return true;
  }

  return false;
}

function decodeReports(value: Record<string, unknown>): CheckValidationReports | undefined {
  if (!keysAre(value, ["baseline", "faulty", "valid"])) return undefined;
  const baseline = decodeReport(value.baseline), faulty = decodeReport(value.faulty), valid = decodeReport(value.valid);
  return baseline === undefined || faulty === undefined || valid === undefined ? undefined : { baseline, faulty, valid };
}

export function decodeReport(value: unknown): ToolEvolutionVerification | undefined {
  if (!recordOf(value) || !keysAre(value, ["verdict", "candidateHash", "samplesHash", "checks"])
    || !["pass", "fail", "cancelled", "unavailable"].includes(String(value.verdict))
    || !digest(value.candidateHash) || !digest(value.samplesHash) || !Array.isArray(value.checks) || value.checks.length > 32
    || !value.checks.every(check => recordOf(check) && keysAre(check, ["sampleId", "role", "outcome", "detail"])
      && textOf(check.sampleId, 128) && ["source", "variation", "counterexample"].includes(String(check.role))
      && ["passed", "wrong_result", "unexpected_error", "timeout", "cancelled", "execution_unavailable"].includes(String(check.outcome))
      && typeof check.detail === "string" && check.detail.length <= 1000)) return undefined;

  if ((value.verdict === "pass" || value.verdict === "fail")
    && ((value.verdict === "pass") !== (value.checks.length > 0 && value.checks.every(check => check.outcome === "passed")))) return undefined;

  return value as ToolEvolutionVerification;
}

function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }

function validAttempts(value: unknown, observation: CheckObservation): boolean {
  if (value === undefined) return true;

  const plan = prepareCheckImprovement(observation);

  return plan.ok && Array.isArray(value) && value.length <= 3 && value.every((attempt, index) => {
    if (!recordOf(attempt) || !keysAre(attempt, ["role", "report"]) || attempt.role !== ["baseline", "faulty", "valid"][index]) return false;
    const report = decodeReport(attempt.report);
    const candidate = index === 0 ? observation.controls[plan.value.validation.baselineCandidate]
      : index === 1 ? observation.controls.faulty : observation.controls.valid;
    const recipe = index === 0 ? observation.baselineRecipe : plan.value.recipe;
    return report !== undefined && report.candidateHash === contentHashOf(candidate) && report.samplesHash === contentHashOf(recipe.request.evidence);
  });
}

export function recipeSuspended(catalog: CheckCatalog, versionId: string): boolean {
  return catalog.feedbacks.some(feedback => feedback.kind !== "confirmed"
    && catalog.runs.some(run => run.runId === feedback.runId && run.recipeVersionId === versionId));
}

export function correctionMatches(catalog: Pick<CheckCatalog, "recipes">, observation: CheckObservation): boolean {
  const correction = observation.correction;
  if (correction === undefined) return true;

  const target = catalog.recipes.find(item => item.versionId === correction.targetVersionId);
  if (target === undefined || target.observation.scope !== observation.scope || target.observation.capability !== observation.capability
    || target.observation.requirementRef !== observation.requirementRef
    || contentHashOf(target.content.recipe) !== contentHashOf(observation.baselineRecipe)) return false;

  const parentScope = target.observation.correction?.appliesTo;

  return parentScope?.kind !== "task" || (correction.appliesTo.kind === "task" && correction.appliesTo.taskId === parentScope.taskId);
}
