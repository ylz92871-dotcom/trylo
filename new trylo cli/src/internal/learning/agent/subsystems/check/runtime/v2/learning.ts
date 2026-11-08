import { contentHashOf } from "../../../../../control/hash.js";
import type { CheckSample, CheckExperience, CheckEvaluation, CheckInput } from "../../domain/v2/contracts.js";
import { checkerExposureFingerprints, checkerTargetFingerprint } from "../../domain/v2/exposure.js";
import { checkerExperienceHasSharedOracle, correctionScope } from "./feedback.js";
import { checkerExposureHistory } from "./exposure.js";
import { buildCheckerPrompt } from "../../domain/v2/prompt.js";
import { evaluateChecker } from "../../domain/v2/evaluate.js";
import { checkerJobId, claimCheckerJob, recoverCheckerJobs, settleCheckerJob } from "./jobs.js";
import { generateCheckerAttempt } from "./generation.js";
import { failure, readCheckerBoard, saveCheckerRecord, validAllowance } from "../../adapters/board/store.js";
import type { CheckerAllowance, CheckerCatalog, CheckerEngineOptions, CheckerGeneration, CheckerJobResult, CheckerVersion } from "./contracts.js";

type Opportunity = { readonly scope: string; readonly records: CheckerCatalog["experiences"]; readonly samples: readonly CheckSample[];
  readonly feedback: CheckerCatalog["feedbacks"]; readonly prior: CheckerCatalog["versions"][number] | undefined;
  readonly feedbackInputs: readonly CheckInput[]; readonly oracleEligible: ReadonlySet<string>; readonly basis: string; readonly jobId: string };

type Retry = { readonly generation: CheckerGeneration; readonly evaluation?: CheckEvaluation };

/** The learner owns its topics and up to three bounded improvement steps; terminal topics need new evidence. */
export async function learnCheckers(options: CheckerEngineOptions, dispatch: { readonly subsystem: "verifier"; readonly allowance: CheckerAllowance }, signal: AbortSignal) {
  if (dispatch?.subsystem !== "verifier" || !validAllowance(dispatch.allowance)) return failure("invalid_check_allowance", "invalid checker learning allocation");

  const usage = { modelCalls: 0, executions: 0, tokens: 0 }, jobs: CheckerJobResult[] = [];
  const stopped = (stop: string) => ({ ok: true as const, stop, usage, jobs });

  if (options.collection() === "disabled") return stopped("collection_disabled");

  const recovered = await recoverCheckerJobs(options);
  if (!recovered.ok) return recovered;

  for (;;) {
    if (signal.aborted) return stopped("cancelled");

    const loaded = await readCheckerBoard(options.boardRoot);
    if (!loaded.ok) return loaded;

    const opportunity = nextOpportunity(loaded.catalog);
    if (opportunity === undefined) return stopped("idle");

    if (usage.modelCalls >= dispatch.allowance.modelCalls) return stopped("model_allowance_exhausted");

    const prompt = promptFor(opportunity);
    if (!prompt.ok) return failure(prompt.code, prompt.message);

    if (dispatch.allowance.tokens - usage.tokens < promptCost(prompt.value) + 512) return stopped("token_allowance_exhausted");

    const allowance = { modelCalls: Math.min(3, dispatch.allowance.modelCalls - usage.modelCalls),
      executions: dispatch.allowance.executions - usage.executions, tokens: dispatch.allowance.tokens - usage.tokens };

    // Claim the frozen evidence basis before any generation or evaluation work.
    const claimed = await claimCheckerJob(options, { schemaVersion: 2, type: "checker_lease", jobId: opportunity.jobId,
      scope: opportunity.scope, ownerId: options.owner.id, allowance, basis: opportunity.basis });
    if (!claimed.ok) return claimed;

    if (!claimed.claimed) return stopped(claimed.state === "running" ? "worker_running" : "recovery_required");

    const result = await improveChecker(options, opportunity, allowance, signal);

    usage.modelCalls += result.usage.modelCalls;
    usage.executions += result.usage.executions;
    usage.tokens += result.usage.tokens;
    const settled = await settleCheckerJob(options, result);
    if (!settled.ok) return settled;

    jobs.push(result);

    if (result.outcome === "cancelled") return stopped("cancelled");

    if (result.reason === "provider_token_overrun") return stopped("provider_token_overrun");

    if (options.collection() === "disabled") return stopped("collection_disabled");
  }
}

async function improveChecker(options: CheckerEngineOptions, opportunity: Opportunity, allowance: CheckerAllowance,
  signal: AbortSignal): Promise<CheckerJobResult> {
  const usage: { modelCalls: number; executions: number; tokens: number } = { modelCalls: 0, executions: 0, tokens: 0 };
  const result = (outcome: CheckerJobResult["outcome"], reason: string, versionId?: string): CheckerJobResult => ({
    schemaVersion: 2, type: "checker_job_result", jobId: opportunity.jobId, scope: opportunity.scope, outcome, reason, usage,
    ...(versionId === undefined ? {} : { versionId }) });
  let retry: Retry | undefined;

  for (let attempt = 1; attempt <= allowance.modelCalls; attempt += 1) {
    if (signal.aborted || options.collection() === "disabled") return result("cancelled", signal.aborted ? "cancelled" : "collection_disabled");

    const prompt = promptFor(opportunity, retry);
    if (!prompt.ok) return result("rejected", prompt.code);

    const maxOutputTokens = Math.min(8192, allowance.tokens - usage.tokens - promptCost(prompt.value));
    if (maxOutputTokens < 512) return result(retry?.generation.outcome === "failed" ? "failed" : "rejected", "token_allowance_exhausted");

    const records = publicRecords(opportunity), requirements = opportunity.records[0]!.value.requirements;
    const tokenReserve = promptCost(prompt.value) + maxOutputTokens;
    const generated = await generateCheckerAttempt(options, { prompt: prompt.value, experiences: records.map(item => item.value),
      feedbackRefs: opportunity.feedback.map(item => item.sourceRef), parentVersionId: opportunity.prior?.versionId,
      started: { schemaVersion: 2, type: "checker_generation_started", requestId: opportunity.jobId + ":generation:" + attempt,
        jobId: opportunity.jobId, scope: opportunity.scope, ownerId: options.owner.id, attempt,
        requirementRef: requirements.ref, requirementDigest: requirements.digest, promptDigest: contentHashOf(prompt.value),
        exposedInputs: promptInputs(opportunity), experienceRefs: records.map(item => item.versionId), tokenReserve, maxOutputTokens } }, signal);

    usage.modelCalls += 1;

    if (!generated.ok) {
      usage.tokens += tokenReserve;
      return result("failed", generated.code);
    }

    const generation = generated.record;
    usage.tokens += generation.chargedTokens;

    if (generation.outcome === "cancelled" || generation.outcome === "no_change") return result(generation.outcome, generation.reason);

    if (generation.reason === "provider_token_overrun" || generation.usageStatus === "unknown") return result("failed", generation.reason);

    if (generation.candidate === undefined) {
      retry = { generation };
      continue;
    }

    const evaluated = await evaluateAttempt(options, opportunity, generation, usage, allowance, signal);
    if (!evaluated.ok) return result("failed", evaluated.code);

    if (evaluated.evaluation?.status === "cancelled" || signal.aborted) return result("cancelled", "cancelled");

    if (evaluated.evaluation !== undefined && evaluated.evaluation.status !== "supported") {
      retry = { generation, evaluation: evaluated.evaluation };
      continue;
    }

    if (options.collection() === "disabled") return result("cancelled", "collection_disabled");

    const saved = await saveVersion(options, opportunity, generation, evaluated.evaluation);

    return saved.ok ? result("generated", evaluated.evaluation === undefined ? "working_method_needs_task_feedback" : "independent_samples_supported", saved.versionId)
      : result("failed", saved.code);
  }

  return result(retry?.generation.outcome === "failed" ? "failed" : "rejected",
    retry?.evaluation === undefined ? retry?.generation.reason ?? "improvement_allowance_exhausted" : "evaluation_" + retry.evaluation.status);
}

async function evaluateAttempt(options: CheckerEngineOptions, opportunity: Opportunity, generation: CheckerGeneration,
  usage: { executions: number }, allowance: CheckerAllowance, signal: AbortSignal) {
  const candidate = generation.candidate!; // Only grounded candidates reach this private operation.
  const executor = { execute: async (...args: Parameters<CheckerEngineOptions["executor"]["execute"]>) => {
    if (usage.executions >= allowance.executions) return { kind: "unavailable" as const, detail: "check execution quota exhausted" };
    usage.executions += 1;
    return options.executor.execute(...args);
  } };
  const evaluated = await evaluateChecker({ candidate, samples: opportunity.samples, executor, signal });
  if (!evaluated.ok) return evaluated.code === "invalid_corpus" ? { ok: true as const, evaluation: undefined } : evaluated;

  const saved = await saveCheckerRecord(options.boardRoot, { schemaVersion: 2, type: "checker_generation_evaluation",
    requestId: generation.requestId, jobId: generation.jobId, scope: generation.scope, candidate,
    evaluation: evaluated.value, validationSamples: opportunity.samples }, new Date(options.now()).toISOString());

  return saved.ok ? { ok: true as const, evaluation: evaluated.value } : saved;
}

function saveVersion(options: CheckerEngineOptions, opportunity: Opportunity, generation: CheckerGeneration, evaluation: CheckEvaluation | undefined) {
  const version: CheckerVersion = { schemaVersion: 2, type: "checker_version", checker: generation.candidate!,
    requirements: opportunity.records[0]!.value.requirements, experienceRefs: publicRecords(opportunity).map(item => item.versionId),
    generation: { requestId: generation.requestId, model: generation.model, usage: generation.usage, exposedInputs: promptInputs(opportunity) },
    ...(evaluation === undefined ? {} : { evaluation, validationSamples: opportunity.samples }) };
  return saveCheckerRecord(options.boardRoot, version, new Date(options.now()).toISOString());
}

function promptCost(prompt: string): number { return new TextEncoder().encode(prompt).length + 1024; }

function promptInputs(opportunity: Opportunity): readonly string[] {
  return [...new Set([...publicRecords(opportunity).flatMap(item => checkerExposureFingerprints(item.value.facts)),
    ...opportunity.samples.filter(item => item.role === "source").flatMap(item => checkerExposureFingerprints(item.input)),
    ...opportunity.feedbackInputs.flatMap(checkerExposureFingerprints)])];
}

function nextOpportunity(catalog: CheckerCatalog): Opportunity | undefined {
  const groups = new Map<string, CheckerCatalog["experiences"][number][]>();

  for (const entry of catalog.experiences) {
    const key = contentHashOf([entry.value.scope, entry.value.requirements.ref, entry.value.requirements.digest]);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }

  for (const records of groups.values()) {
    const scope = records[0]!.value.scope, digest = records[0]!.value.requirements.digest, requirementRef = records[0]!.value.requirements.ref;
    const recent = records.slice(-16);
    const feedback = catalog.feedbacks.filter(note => feedbackIsRelevant(note, records, catalog.runs)).slice(-16);
    const history = catalog.versions.filter(item => item.value.checker.applicability.scope === scope && item.value.requirements.digest === digest
      && item.value.requirements.ref === requirementRef);
    const prior = history.at(-1);
    const exposed = new Set(checkerExposureHistory(catalog, scope, requirementRef, digest));
    const feedbackInputs = [...catalog.runs.filter(run => feedback.some(note => note.runIds.includes(run.runId))).map(run => run.input),
      ...records.filter(entry => feedback.some(note => note.judgment === undefined && note.runIds.length === 0
        && note.sessionId === entry.value.sessionId && note.turnId === entry.value.turnId)).map(entry => entry.value.facts)];

    for (const input of feedbackInputs) for (const fingerprint of checkerExposureFingerprints(input)) exposed.add(fingerprint);

    const basis = contentHashOf({ experiences: recent.map(item => item.versionId), feedback: feedback.map(item => contentHashOf(item)) });
    const jobId = checkerJobId(basis);
    if (catalog.results.some(item => item.jobId === jobId)) continue;

    return { scope, records: records.slice(-256), samples: samplesFor(records.map(item => item.value), exposed, catalog), feedback, prior,
      feedbackInputs, oracleEligible: new Set(records.filter(item => checkerExperienceHasSharedOracle(catalog, item.value)).map(item => item.value.id)), basis, jobId };
  }

  return undefined;
}

/** The first positive/negative observations teach; later distinct observations test unseen behavior. */
function samplesFor(experiences: readonly CheckExperience[], exposed: ReadonlySet<string>, catalog: CheckerCatalog): readonly CheckSample[] {
  const seen = new Set<string>(), classCounts = new Map<string, number>();
  const samples: CheckSample[] = [];

  for (const experience of experiences) {
    if (experience.assessment === undefined || !checkerExperienceHasSharedOracle(catalog, experience)) continue;

    const inputDigest = checkerTargetFingerprint(experience.facts);
    if (seen.has(inputDigest)) continue;

    seen.add(inputDigest);
    const expected = experience.assessment.verdict === "valid" ? "pass" : experience.assessment.verdict === "invalid" ? "fail" : "not_applicable";
    const count = classCounts.get(expected) ?? 0;
    classCounts.set(expected, count + 1);
    samples.push({ id: experience.id, role: count === 0 || checkerExposureFingerprints(experience.facts).some(fingerprint => exposed.has(fingerprint)) ? "source" : "holdout", input: experience.facts, expected,
      oracle: { kind: experience.assessment.kind, sourceRef: experience.assessment.sourceRef, requirementDigest: experience.requirements.digest } });
  }

  const required: CheckSample[] = [];

  for (const role of ["source", "holdout"] as const) for (const expected of ["pass", "fail", "not_applicable"] as const) {
    const sample = samples.find(item => item.role === role && item.expected === expected);
    if (sample !== undefined) required.push(sample);
  }

  const chosen = new Set(required.map(item => item.id));

  return [...required, ...samples.filter(item => !chosen.has(item.id)).slice(-(32 - required.length))];
}

function publicRecords(opportunity: Opportunity) {
  const holdout = new Set(opportunity.samples.filter(item => item.role === "holdout").map(item => checkerTargetFingerprint(item.input)));
  const sourceIds = new Set(opportunity.samples.filter(item => item.role === "source").map(item => item.id));
  const relevant = opportunity.records.filter(item => !holdout.has(checkerTargetFingerprint(item.value.facts)));
  const explicit = relevant.filter(item => sourceIds.has(item.value.id)).slice(-8);
  const ids = new Set(explicit.map(item => item.versionId));

  return [...explicit, ...relevant.filter(item => !ids.has(item.versionId)).slice(-(16 - explicit.length))].map(entry => {
    if (entry.value.assessment === undefined || opportunity.oracleEligible.has(entry.value.id)) return entry;
    const { assessment, ...value } = entry.value;
    return { ...entry, value };
  });
}

function promptFor(opportunity: Opportunity, retry?: Retry) {
  const generated = buildCheckerPrompt({ experiences: publicRecords(opportunity).map(item => item.value),
    sourceSamples: opportunity.samples.filter(item => item.role === "source"),
    ...(opportunity.prior === undefined ? {} : { prior: opportunity.prior.value.checker }),
    ...(opportunity.feedback.length === 0 ? {} : { feedback: promptFeedback(opportunity.feedback) }) });
  if (!generated.ok || retry === undefined) return generated;

  // Only aggregate categories/counts return to the model. Cases, expected labels and hidden values stay on the Board.
  const diagnostics = { reason: retry.generation.reason, ...(retry.evaluation === undefined ? {} : {
    evaluationStatus: retry.evaluation.status, falsePositives: retry.evaluation.falsePositives,
    falseNegatives: retry.evaluation.falseNegatives, checkerErrors: retry.evaluation.checkerErrors,
    mismatches: retry.evaluation.cases.filter(item => item.outcome.kind === "mismatch").length }) };
  const previousPublic = retry.generation.output.kind === "public" ? retry.generation.output.text.slice(0, 8192) : undefined;
  const prompt = generated.value + "\n此前一次公开生成及汇总诊断（请修正方法，保持原标准和父版本）：\n"
    + JSON.stringify({ diagnostics, ...(previousPublic === undefined ? {} : { previousPublic }) });

  return new TextEncoder().encode(prompt).length <= 65536 ? { ok: true as const, value: prompt }
    : { ok: false as const, code: "prompt_capacity" as const, message: "checker improvement prompt exceeds its hard byte limit" };
}

function crossTaskFeedback(item: CheckerCatalog["feedbacks"][number]): boolean {
  if (item.judgment === undefined) return true;
  if (!("appliesTo" in item) || typeof item.appliesTo !== "object" || item.appliesTo === null || !("kind" in item.appliesTo)) return false;
  return item.appliesTo.kind === "class" || item.appliesTo.kind === "long_term";
}

function feedbackIsRelevant(note: CheckerCatalog["feedbacks"][number], records: CheckerCatalog["experiences"], runs: CheckerCatalog["runs"]): boolean {
  const first = records[0]!.value;
  if (note.scope !== first.scope || !crossTaskFeedback(note)) return false;
  if (note.runIds.length === 0) return note.judgment === undefined
    && records.some(entry => entry.value.sessionId === note.sessionId && entry.value.turnId === note.turnId);
  return note.runIds.some(runId => runs.some(run => run.runId === runId
    && run.requirements.ref === first.requirements.ref && run.requirements.digest === first.requirements.digest));
}

function promptFeedback(feedback: CheckerCatalog["feedbacks"]): string {
  const entries: string[] = [];
  let used = 2;

  for (const note of [...feedback].reverse()) {
    const base = { sourceRef: note.sourceRef, appliesTo: correctionScope(note),
      evidenceRole: note.judgment === undefined ? "raw_signal_not_oracle" : "explicit_owner_judgment_under_frozen_requirement", text: "" };
    const remaining = 1850 - used - JSON.stringify(base).length;
    if (remaining <= 0) continue;
    const entry = JSON.stringify({ ...base, text: note.text.slice(-Math.min(512, remaining)) });
    entries.unshift(entry);
    used += entry.length + 1;
  }

  return "反馈的 appliesTo 必须保留；无 judgment 的原文仅是公开问题信号，绝非独立 oracle，不得改变冻结标准。\n[" + entries.join(",") + "]";
}
