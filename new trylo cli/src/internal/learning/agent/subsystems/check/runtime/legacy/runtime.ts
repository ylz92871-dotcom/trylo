import { contentHashOf } from "../../../../../control/hash.js";
import { parseCheckObservation } from "../../domain/legacy/parse.js";
import { assessCheckImprovement, prepareCheckImprovement } from "../../domain/legacy/algorithm.js";
import type { CheckObservation } from "../../domain/legacy/contracts.js";
import type { ToolEvolutionCandidate } from "../../../../../domains/tool/evolution/contracts.js";
import type { ToolEvolutionVerifier } from "../../../../../domains/tool/evolution/verification.js";
import { verificationBinds } from "../../../../../domains/tool/evolution/artifact.js";
import { isJsonValue, jsonBytes, keysAre, parseToolEvolutionCandidate, recordOf, textOf } from "../../../../../domains/tool/evolution/parse.js";
import { withBoardWriter } from "../../../../../../adapters/learning-store/file-event-store.js";
import { readCheckArtifacts, saveCheckArtifact, type CheckBoardFailure } from "../../adapters/board/artifacts.js";
import { checkFailure, correctionMatches, decodeCheckCatalog, decodeReport, recipeSuspended, recordId,
  type CheckCatalog, type CheckFeedback, type CheckLesson, type CheckRecipe, type CheckRun, type RecipeEntry } from "../../adapters/board/legacy-records.js";

export type CheckTask = { readonly taskId: string; readonly scope: string; readonly capability: string;
  readonly requirementRef: string; readonly candidate: ToolEvolutionCandidate };

export type CheckLearningOptions = { readonly boardRoot: string; readonly verifier: ToolEvolutionVerifier;
  /** Collection is checked at every entry. The host must supply evidence already eligible for this profile. */
  readonly collect: boolean; readonly now?: () => number };

type LearnStop = "idle" | "quota_exhausted" | "cancelled" | "recovery_required";

type Learned = { readonly ok: true; readonly stop: LearnStop; readonly spent: number; readonly lessons: readonly CheckLesson[] };

/** Independently callable subsystem: the dispatch supplies only a name and a verifier-call quota. */
export function createCheckLearningSubsystem(options: CheckLearningOptions) {
  const now = options.now ?? Date.now;
  const load = async () => {
    const loaded = await readCheckArtifacts(options.boardRoot);
    return loaded.ok ? decodeCheckCatalog(loaded.state) : loaded;
  };
  const save = async (content: CheckObservation | CheckRecipe | CheckLesson | CheckRun | CheckFeedback
    | { readonly type: "check_started"; readonly schemaVersion: 1; readonly observationRef: string }, scope: string,
  sourceRefs: readonly string[], parentVersionId?: string) => {
    const result = await withBoardWriter(options.boardRoot, async store => {
      const loaded = await store.load();
      if (!loaded.ok) return checkFailure(loaded.reason, loaded.detail);

      const decoded = decodeCheckCatalog(loaded.state);
      if (!decoded.ok) return decoded;

      const admitted = admitIdentity(decoded.catalog, content);
      if (admitted !== undefined) return admitted;

      return saveCheckArtifact(store, {
        versionId: recordId(content.type.slice(6), content), kind: content.type === "check_recipe" ? "verification_recipe" : "workflow",
        scope, source: content.type === "check_observation" && content.source.kind === "explicit_correction" ? "user_explicit" : "inferred",
        sourceRefs, content, issuedAt: new Date(now()).toISOString(), hypothesis: "Improve attributed sample coverage without changing task authority",
        ...(parentVersionId === undefined ? {} : { parentVersionId }),
      });
    });
    return "reason" in result ? checkFailure(result.reason, result.detail) : result;
  };

  async function observe(raw: unknown) {
    if (!options.collect) return checkFailure("collection_disabled", "check evidence collection is disabled");

    const parsed = parseCheckObservation(raw);
    if (!parsed.ok) return checkFailure(parsed.code, parsed.message);

    const loaded = await load();
    if (!loaded.ok) return loaded;

    const observation = parsed.value;
    const conflict = loaded.catalog.observations.find(item => item.value.observationId === observation.observationId);
    if (conflict !== undefined && contentHashOf(conflict.value) !== contentHashOf(observation)) {
      return checkFailure("observation_conflict", "an observation identity cannot be rewritten");
    }

    const correction = validateCorrection(loaded.catalog, observation);
    if (correction !== undefined) return correction;

    return save(observation, observation.scope, [observation.source.ref, observation.source.runId, observation.requirementRef]);
  }

  async function learn(dispatch: { readonly subsystem: "verifier"; readonly quota: number }, signal: AbortSignal): Promise<Learned | CheckBoardFailure> {
    if (!recordOf(dispatch) || !keysAre(dispatch, ["subsystem", "quota"]) || dispatch.subsystem !== "verifier"
      || !Number.isSafeInteger(dispatch.quota) || dispatch.quota < 0 || dispatch.quota > 96) {
      return checkFailure("invalid_dispatch", "dispatch needs verifier and a verifier-call quota in 0..96");
    }

    if (!options.collect) return { ok: true, stop: "idle", spent: 0, lessons: [] };

    let spent = 0;
    const lessons: CheckLesson[] = [];
    const done = (stop: LearnStop): Learned => ({ ok: true, stop, spent, lessons });

    for (;;) {
      if (signal.aborted) return done("cancelled");

      const loaded = await load();
      if (!loaded.ok) return loaded;

      const next = loaded.catalog.observations.find(item => !loaded.catalog.lessons.some(lesson => lesson.observationRef === item.versionId));
      if (next === undefined) return done("idle");

      if (loaded.catalog.started.includes(next.versionId)) return done("recovery_required");

      // Reserve the entire compare before doing work; a quota is never a partially executed quality claim.
      if (dispatch.quota - spent < 3) return done("quota_exhausted");

      const started = await save({ type: "check_started", schemaVersion: 1, observationRef: next.versionId }, next.value.scope, [next.versionId]);
      if (!started.ok) return started;

      if (started.idempotent) return done("recovery_required");

      const plan = prepareCheckImprovement(next.value);
      let lesson: CheckLesson;

      if (!plan.ok) lesson = { type: "check_lesson", schemaVersion: 1, observationRef: next.versionId, outcome: "rejected", reason: plan.code };
      else {
        const corrected = validateCorrection(loaded.catalog, next.value);
        if (corrected !== undefined) lesson = { type: "check_lesson", schemaVersion: 1, observationRef: next.versionId,
          outcome: "rejected", reason: corrected.code };
        else {
          const outcome = await evaluate(plan.value, next.versionId, signal);
          spent += outcome.spent;
          if (!outcome.ok) return outcome;
          lesson = outcome.lesson;
        }
      }

      const saved = await save(lesson, next.value.scope, [next.versionId]);
      if (!saved.ok) return saved;

      lessons.push(lesson);

      if (lesson.outcome === "cancelled") return done("cancelled");
    }
  }

  async function evaluate(plan: import("../../domain/legacy/contracts.js").CheckImprovementPlan, observationRef: string, signal: AbortSignal) {
    let spent = 0;
    const attempts: NonNullable<CheckLesson["attempts"]>[number][] = [];
    const observation = plan.observation;
    const base = { type: "check_lesson" as const, schemaVersion: 1 as const, observationRef, attempts };

    try {
      const verify = async (role: "baseline" | "faulty" | "valid", candidate: ToolEvolutionCandidate, recipe: CheckRecipe["recipe"]) => {
        spent += 1;
        const report = decodeReport(await options.verifier.verify(candidate, recipe.request, signal));
        if (report === undefined || report.candidateHash !== contentHashOf(candidate) || report.samplesHash !== contentHashOf(recipe.request.evidence)) {
          throw new Error("invalid verifier report");
        }
        attempts.push({ role, report });
        return report;
      };
      const baseline = await verify("baseline", observation.controls[plan.validation.baselineCandidate], observation.baselineRecipe);
      const faulty = signal.aborted ? baseline : await verify("faulty", observation.controls.faulty, plan.recipe);
      const valid = signal.aborted ? baseline : await verify("valid", observation.controls.valid, plan.recipe);

      if (signal.aborted) return { ok: true as const, spent, lesson: { ...base, outcome: "cancelled" as const, reason: "cancelled" } };

      const assessed = assessCheckImprovement(plan, { baseline, faulty, valid });
      if (!assessed.ok) return { ok: true as const, spent, lesson: { ...base,
        outcome: [baseline, faulty, valid].some(report => report.verdict === "unavailable") ? "unavailable" as const : "rejected" as const,
        reason: assessed.code } };

      const content: CheckRecipe = { type: "check_recipe", schemaVersion: 1, observationRef, recipe: plan.recipe, reports: assessed.value.reports };
      const saved = await save(content, observation.scope, [observationRef, observation.requirementRef], observation.correction?.targetVersionId);

      return saved.ok ? { ok: true as const, spent, lesson: { ...base, outcome: "trial_supported" as const,
        reason: "reproduced_miss_or_false_positive_and_preserved_valid_control", recipeVersionId: saved.versionId } }
        : { ...saved, spent };
    } catch {
      // No external verdict is inferred from an adapter exception. The observation is terminal until new evidence arrives.
      return { ok: true as const, spent, lesson: { ...base, outcome: "unavailable" as const, reason: "verifier_exception" } };
    }
  }

  async function checkTask(raw: CheckTask, signal: AbortSignal) {
    if (!options.collect) return { ok: true as const, status: "skipped" as const, reason: "collection_disabled" };

    const task = parseTask(raw);
    if (!task.ok) return task;

    if (signal.aborted) return checkFailure("cancelled", "check cancelled before dispatch");

    const loaded = await load();
    if (!loaded.ok) return loaded;

    const selected = selectRecipe(loaded.catalog, task.value);
    if (typeof selected === "string") return { ok: true as const, status: "skipped" as const, reason: selected };

    const runId = recordId("execution", { task: task.value, recipeVersionId: selected.versionId });
    const previous = loaded.catalog.runs.find(run => run.runId === runId);
    if (previous !== undefined) return { ok: true as const, status: "checked" as const, run: previous };

    let report;

    try { report = decodeReport(await options.verifier.verify(task.value.candidate, selected.content.recipe.request, signal)); }
    catch { return checkFailure("verifier_unavailable", "verifier threw; no result was inferred"); }

    if (report === undefined || report.candidateHash !== contentHashOf(task.value.candidate)
      || report.samplesHash !== contentHashOf(selected.content.recipe.request.evidence)
      || ((report.verdict === "pass" || report.verdict === "fail")
        && !verificationBinds(task.value.candidate, selected.content.recipe.request, report))) {
      return checkFailure("invalid_verifier_report", "check result is not bound to the dispatched candidate and exact recipe");
    }

    const run: CheckRun = { type: "check_run", schemaVersion: 1, runId, taskId: task.value.taskId, scope: task.value.scope,
      capability: task.value.capability, requirementRef: task.value.requirementRef, recipeVersionId: selected.versionId, report };
    const saved = await save(run, run.scope, [selected.versionId, run.taskId, run.requirementRef]);

    return saved.ok ? { ok: true as const, status: "checked" as const, run } : saved;
  }

  async function feedback(raw: { readonly runId: string; readonly sourceRef: string; readonly kind: CheckFeedback["kind"] }) {
    if (!options.collect) return checkFailure("collection_disabled", "feedback collection is disabled");

    if (!recordOf(raw) || !keysAre(raw, ["runId", "sourceRef", "kind"]) || !textOf(raw.runId, 160)
      || !textOf(raw.sourceRef, 512) || !["confirmed", "false_negative", "false_positive"].includes(String(raw.kind))) {
      return checkFailure("invalid_feedback", "feedback needs an actual run, a source reference and a known kind");
    }

    const loaded = await load();
    if (!loaded.ok) return loaded;

    const run = loaded.catalog.runs.find(item => item.runId === raw.runId);
    if (run === undefined) return checkFailure("run_not_found", "feedback cannot manufacture an exposure");

    if (loaded.catalog.feedbacks.some(item => item.runId === raw.runId && item.sourceRef === raw.sourceRef && item.kind !== raw.kind)) {
      return checkFailure("feedback_conflict", "same feedback source cannot change its verdict");
    }

    return save({ type: "check_feedback", schemaVersion: 1, ...raw }, run.scope, [run.runId, raw.sourceRef]);
  }

  async function inspect() {
    const loaded = await load();
    if (!loaded.ok) return loaded;
    const catalog = loaded.catalog;
    return { ok: true as const, observations: catalog.observations, lessons: catalog.lessons, runs: catalog.runs, feedbacks: catalog.feedbacks,
      recipes: catalog.recipes.map(entry => ({ versionId: entry.versionId, recipe: entry.content.recipe, observationRef: entry.content.observationRef,
        performance: performance(catalog, entry.versionId), suspended: recipeSuspended(catalog, entry.versionId) })) };
  }

  return { observe, learn, checkTask, feedback, inspect };
}

function validateCorrection(catalog: CheckCatalog, observation: CheckObservation): CheckBoardFailure | undefined {
  if (!correctionMatches(catalog, observation)) {
    return checkFailure("stale_correction", "correction must name the exact prior recipe in the same requirement and capability scope");
  }
  return undefined;
}

function selectRecipe(catalog: CheckCatalog, task: CheckTask): RecipeEntry | "no_applicable_recipe" | "conflicting_recipes" {
  const candidates = catalog.recipes.filter(entry => entry.observation.scope === task.scope
    && entry.observation.capability === task.capability && entry.observation.requirementRef === task.requirementRef
    && !recipeSuspended(catalog, entry.versionId) && catalog.lessons.some(lesson => lesson.recipeVersionId === entry.versionId)
    && (entry.observation.correction?.appliesTo.kind !== "task" || entry.observation.correction.appliesTo.taskId === task.taskId));
  const superseded = new Set(candidates.flatMap(entry => {
    const parents: string[] = [];
    let parent = entry.parentVersionId;
    while (parent !== undefined) {
      parents.push(parent);
      parent = catalog.recipes.find(item => item.versionId === parent)?.parentVersionId;
    }
    return parents;
  }));
  const winners = candidates.filter(entry => !superseded.has(entry.versionId));

  return winners.length === 0 ? "no_applicable_recipe" : winners.length === 1 ? winners[0]! : "conflicting_recipes";
}

function parseTask(raw: unknown): { readonly ok: true; readonly value: CheckTask } | CheckBoardFailure {
  if (!isJsonValue(raw) || jsonBytes(raw) > 128 * 1024 || !recordOf(raw) || !keysAre(raw, ["taskId", "scope", "capability", "requirementRef", "candidate"])
    || !textOf(raw.taskId, 160) || !textOf(raw.scope, 512) || !textOf(raw.capability, 512) || !textOf(raw.requirementRef, 512)) {
    return checkFailure("invalid_task", "task needs exact scope, capability and requirement coordinates");
  }

  const candidate = parseToolEvolutionCandidate(JSON.stringify(raw.candidate));

  return candidate.ok ? { ok: true, value: { taskId: raw.taskId, scope: raw.scope, capability: raw.capability,
    requirementRef: raw.requirementRef, candidate: candidate.value } } : checkFailure(candidate.code, candidate.message);
}

function performance(catalog: CheckCatalog, versionId: string) {
  const runs = catalog.runs.filter(run => run.recipeVersionId === versionId);
  const feedbacks = catalog.feedbacks.filter(feedback => runs.some(run => run.runId === feedback.runId));
  return { uses: runs.length, passed: runs.filter(run => run.report.verdict === "pass").length,
    failed: runs.filter(run => run.report.verdict === "fail").length, confirmed: feedbacks.filter(row => row.kind === "confirmed").length,
    falsePositives: feedbacks.filter(row => row.kind === "false_positive").length,
    falseNegatives: feedbacks.filter(row => row.kind === "false_negative").length };
}

function admitIdentity(catalog: CheckCatalog, content: { readonly type: string }): CheckBoardFailure | undefined {
  if (content.type === "check_observation") {
    const parsed = parseCheckObservation(content);
    if (!parsed.ok) return checkFailure(parsed.code, parsed.message);
    const previous = catalog.observations.find(item => item.value.observationId === parsed.value.observationId);
    if (previous !== undefined && contentHashOf(previous.value) !== contentHashOf(content)) return checkFailure("observation_conflict", "observation identity is immutable");
    return validateCorrection(catalog, parsed.value);
  }

  if (content.type === "check_run") {
    const run = content as CheckRun;
    const previous = catalog.runs.find(item => item.runId === run.runId);
    if (previous !== undefined && contentHashOf(previous) !== contentHashOf(run)) return checkFailure("run_conflict", "one dispatch cannot have two terminal check results");
  }

  if (content.type === "check_feedback") {
    const feedback = content as CheckFeedback;
    if (catalog.feedbacks.some(item => item.runId === feedback.runId && item.sourceRef === feedback.sourceRef && item.kind !== feedback.kind)) {
      return checkFailure("feedback_conflict", "same source cannot change its verdict");
    }
  }

  return undefined;
}
