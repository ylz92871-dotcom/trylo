import type { CheckExperience, CheckInput, CheckRequirements } from "../../domain/v2/contracts.js";
import { checkInputJson, checkerAsToolCandidate, checkerMatches, parseCheckExperience, parseCheckInput,
  parseCheckRequirements, parseCheckerVerdict } from "../../domain/v2/parse.js";
import { contentHashOf } from "../../../../../control/hash.js";
import { isJsonValue, keysAre, recordOf, textOf } from "../../../../../domains/tool/evolution/parse.js";
import { learnCheckers } from "./learning.js";
import { recoverCheckerJobs } from "./jobs.js";
import { recoverCheckerRuns, runClaimedChecker } from "./run-claims.js";
import { failure, readCheckerBoard, saveCheckerRecord } from "../../adapters/board/store.js";
import { checkerMaterialHasCredentials } from "./privacy.js";
import { checkerExperienceHasSharedOracle, correctionScope, feedbackSuspendsVersion, parseCheckerFeedback } from "./feedback.js";
import { repairBoardTornTail } from "../../../../../../adapters/learning-store/torn-tail-repair.js";
import { checkerTargetFingerprint } from "../../domain/v2/exposure.js";
import { deriveCheckerVersionQualification } from "./version-qualification.js";
import type { CheckerAllowance, CheckerCatalog, CheckerEngineOptions, CheckerFeedback, CheckerOutcome, CheckerRun } from "./contracts.js";

export type CheckerTaskInput = { readonly scope: string; readonly requirements: CheckRequirements; readonly input: CheckInput;
  readonly runId: string; readonly sessionId: string; readonly turnId: string };

/** One domain entry for daily tasks and independent learning. Permissions and oracle ownership stay outside it. */
export function createExecutableCheckLearning(options: CheckerEngineOptions) {
  const save = (value: Parameters<typeof saveCheckerRecord>[1]) => saveCheckerRecord(options.boardRoot, value, new Date(options.now()).toISOString());

  async function capture(raw: unknown) {
    if (options.collection() === "disabled") return failure("collection_disabled", "check evidence collection is disabled");

    const parsed = parseCheckExperience(raw);
    if (!parsed.ok) return failure(parsed.code, parsed.message);

    if (checkerMaterialHasCredentials(parsed.value)) return failure("check_evidence_ineligible", "credential-shaped material cannot become check learning evidence");

    const loaded = await readCheckerBoard(options.boardRoot);
    if (!loaded.ok) return loaded;

    const compatible = assessmentCompatibility(options, loaded.catalog, parsed.value);
    if (compatible !== undefined) return compatible;

    if (parsed.value.priorRuns.some(ref => !loaded.catalog.runs.some(run => run.runId === ref && run.scope === parsed.value.scope
      && run.sessionId === parsed.value.sessionId && run.requirements.ref === parsed.value.requirements.ref
      && run.requirements.digest === parsed.value.requirements.digest))) return failure("unbound_check_experience", "experience cannot cite a check outside its scope or exact standard");

    return save(parsed.value);
  }

  async function check(raw: CheckerTaskInput, signal: AbortSignal) {
    if (options.collection() === "disabled") return { ok: true as const, runs: [] };

    const parsed = parseTask(raw);
    if (!parsed.ok) return parsed;

    const task = parsed.value;
    const loaded = await readCheckerBoard(options.boardRoot);
    if (!loaded.ok) return loaded;

    // A run is bound to the exact task coordinates and frozen checker version.
    const selected = selectVersions(loaded.catalog, task);
    const runs: CheckerRun[] = [];

    for (const entry of selected) {
      if (signal.aborted) break;

      const runId = `checker-run:${contentHashOf({ origin: task.runId, sessionId: task.sessionId, turnId: task.turnId,
        scope: task.scope, versionId: entry.versionId, input: task.input })}`;
      const checked = await runClaimedChecker(options, { runId, versionId: entry.versionId,
        scope: task.scope, sessionId: task.sessionId, turnId: task.turnId, requirements: task.requirements,
        input: task.input, inputDigest: contentHashOf(task.input) }, () => executeChecker(options, entry.value.checker, task.input, signal), signal);
      if (!checked.ok) return checked;

      if (checked.run !== undefined) runs.push(checked.run);

      if (checked.reason === "turn_budget_exhausted") break;
    }

    return { ok: true as const, runs };
  }

  async function feedback(raw: Omit<CheckerFeedback, "schemaVersion" | "type">, signal: AbortSignal) {
    if (options.collection() === "disabled") return failure("collection_disabled", "check feedback collection is disabled");

    if (signal.aborted) return failure("cancelled", "feedback cancelled");

    const loaded = await readCheckerBoard(options.boardRoot);
    if (!loaded.ok) return loaded;

    const parsed = parseCheckerFeedback({ ...raw, schemaVersion: 2, type: "checker_feedback" }, loaded.catalog);
    if (parsed === undefined) return failure("invalid_checker_feedback", "feedback needs bounded source, actual runs and a matching correction scope");

    if (checkerMaterialHasCredentials(parsed)) return failure("check_evidence_ineligible", "credential-shaped feedback cannot enter learning");

    const run = loaded.catalog.runs.find(item => item.runId === parsed.judgment?.runId);
    const value: CheckerFeedback = { ...parsed, appliesTo: correctionScope(parsed, run) };
    if (parseCheckerFeedback(value, loaded.catalog) === undefined) return failure("invalid_checker_feedback", "a task correction cannot combine different task coordinates");

    if (run !== undefined) {
      const compatible = assessmentCompatibility(options, loaded.catalog, judgmentExperience(value, run));
      if (compatible !== undefined) return compatible;
    }

    const saved = await save(value);
    if (!saved.ok || run === undefined || value.appliesTo?.kind === "task") return saved;

    // This comes from an explicit task-owner operation. Neither the generator nor a checker can submit judgments through its port.
    return capture(judgmentExperience(value, run));
  }

  return { capture, check, feedback,
    learn: (dispatch: { readonly subsystem: "verifier"; readonly allowance: CheckerAllowance }, signal: AbortSignal) => learnCheckers(options, dispatch, signal),
    recover: async () => {
      const repaired = await repairBoardTornTail(options.boardRoot);
      if (!repaired.ok) return failure(repaired.reason, repaired.detail);
      const jobs = await recoverCheckerJobs(options);
      if (!jobs.ok) return jobs;
      const runs = await recoverCheckerRuns(options);
      if (!runs.ok) return runs;
      return { ok: true as const, recovered: jobs.recovered, recoveredRuns: runs.recovered, boardRepair: repaired };
    },
    inspect: () => readCheckerBoard(options.boardRoot),
  };
}

function judgmentExperience(raw: Omit<CheckerFeedback, "schemaVersion" | "type">, run: CheckerRun): CheckExperience {
  const expected = raw.judgment!.expected;
  return { schemaVersion: 2, type: "check_experience", id: `checker-judgment:${contentHashOf([raw.sourceRef, run.runId])}`,
    scope: run.scope, sessionId: run.sessionId, turnId: raw.turnId, requirements: run.requirements, facts: run.input,
    assessment: { verdict: expected === "pass" ? "valid" : expected === "fail" ? "invalid" : "not_applicable",
      kind: "user_correction", sourceRef: raw.sourceRef }, priorRuns: [run.runId] };
}

function assessmentCompatibility(options: CheckerEngineOptions, catalog: CheckerCatalog, experience: CheckExperience) {
  const assessment = experience.assessment;
  if (assessment === undefined) return undefined;

  const previous = catalog.experiences.find(item => item.value.scope === experience.scope
    && item.value.requirements.ref === experience.requirements.ref && item.value.requirements.digest === experience.requirements.digest
    && checkerExperienceHasSharedOracle(catalog, item.value)
    && checkerTargetFingerprint(item.value.facts) === checkerTargetFingerprint(experience.facts) && item.value.assessment !== undefined
    && item.value.assessment.verdict !== assessment.verdict);
  if (previous !== undefined) return failure("check_oracle_conflict", "the same frozen requirement and input have contradictory independent labels");

  const compatible = options.assessCompatibility?.(experience);

  return compatible?.ok === false ? compatible : undefined;
}

async function executeChecker(options: CheckerEngineOptions, checker: CheckerCatalog["versions"][number]["value"]["checker"],
  input: CheckInput, signal: AbortSignal): Promise<CheckerOutcome> {
  try {
    const actual = await options.executor.execute(checkerAsToolCandidate(checker), checkInputJson(input), signal);
    if (signal.aborted || actual.kind === "cancelled") return { kind: "cancelled" };
    if (actual.kind !== "value") return { kind: "checker_error", code: actual.kind };
    const verdict = parseCheckerVerdict(actual.value);
    return verdict.ok && verdict.value.findings.every(row => row.requirementRef === input.task.requirementRef)
      ? { kind: "checked", verdict: verdict.value } : { kind: "checker_error", code: "invalid_verdict" };
  } catch {
    return signal.aborted ? { kind: "cancelled" } : { kind: "checker_error", code: "executor_threw" };
  }
}

function selectVersions(catalog: CheckerCatalog, task: CheckerTaskInput) {
  const applicable = catalog.versions.filter(entry => checkerMatches(entry.value.checker, task.input, task.scope)
    && (entry.value.evaluation === undefined || entry.value.evaluation.status === "supported"));
  const superseded = new Set<string>();

  // A later correction pauses the successor; it does not undo the earlier, independently supported replacement.
  for (const entry of applicable.filter(item => item.value.evaluation?.status === "supported")) {
    let parent = entry.value.checker.parentVersionId;
    while (parent !== undefined && !superseded.has(parent)) {
      superseded.add(parent);
      parent = catalog.versions.find(item => item.versionId === parent)?.value.checker.parentVersionId;
    }
  }

  return applicable.filter(entry => !superseded.has(entry.versionId)
    && deriveCheckerVersionQualification(catalog, entry.value) !== "evidence_withdrawn"
    && !feedbackSuspendsVersion(catalog, entry.versionId, task)).slice(-3);
}

function parseTask(raw: unknown): { readonly ok: true; readonly value: CheckerTaskInput } | ReturnType<typeof failure> {
  if (!isJsonValue(raw) || !recordOf(raw) || !keysAre(raw, ["scope", "requirements", "input", "runId", "sessionId", "turnId"])
    || ![raw.scope, raw.runId, raw.sessionId, raw.turnId].every(value => textOf(value, 512))) return failure("invalid_checker_task", "invalid task coordinates");

  const requirements = parseCheckRequirements(raw.requirements), input = parseCheckInput(raw.input);
  if (!requirements.ok) return failure(requirements.code, requirements.message);

  if (!input.ok) return failure(input.code, input.message);

  if (requirements.value.ref !== input.value.task.requirementRef || requirements.value.digest !== input.value.task.requirementDigest) {
    return failure("checker_requirement_mismatch", "input is not bound to this task's exact requirement");
  }

  return { ok: true, value: { scope: String(raw.scope), runId: String(raw.runId), sessionId: String(raw.sessionId), turnId: String(raw.turnId),
    requirements: requirements.value, input: input.value } };
}
