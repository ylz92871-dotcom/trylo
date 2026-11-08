import { err, ok } from "../../../../../../tooling/contract/result.js";
import { canonicalJson, contentHashOf } from "../../../../../control/hash.js";
import type { ToolEvolutionCandidate, ToolEvolutionRequest } from "../../../../../domains/tool/evolution/contracts.js";
import { decodeToolLearningRecipe, type ToolLearningRecipe } from "../../../../../domains/tool/evolution/pipeline.js";
import { hasCompleteSampleCoverage, hasExactSampleCoverage, type ToolEvolutionVerification } from "../../../../../domains/tool/evolution/verification.js";
import type { CheckAssessment, CheckImprovementPlan, CheckObservation, CheckResult, CheckValidationReports } from "./contracts.js";
import { parseCheckObservation } from "./parse.js";

export function checkRecipeVersionId(recipe: ToolLearningRecipe): string {
  return `tool-recipe_v1_${contentHashOf(recipe)}`;
}

/** The topic is the uncovered or corrected sample; all old requirements survive unchanged. */
export function prepareCheckImprovement(input: CheckObservation): CheckResult<CheckImprovementPlan> {
  const parsed = parseCheckObservation(input);
  if (!parsed.ok) return parsed;

  const observation = parsed.value, baseline = observation.baselineRecipe;
  const evidence = [...baseline.request.evidence];
  const index = evidence.findIndex(sample => sample.sampleId === observation.sample.sampleId);
  const sameInput = evidence.findIndex(sample => canonicalJson(sample.input) === canonicalJson(observation.sample.input));
  if (index < 0 && sameInput >= 0) return err("conflicting_sample", "an existing input must be corrected by its original sample identity");

  if (index >= 0) {
    const previous = evidence[index];
    if (previous === undefined) return err("invalid_recipe", "existing sample is missing");

    if (canonicalJson(previous) === canonicalJson(observation.sample)) return err("no_change", "sample already covered by the baseline");

    if (observation.correction === undefined || previous.role !== observation.sample.role
      || canonicalJson(previous.input) !== canonicalJson(observation.sample.input)) {
      return err("conflicting_sample", "only an attributed correction may replace the expectation of an unchanged sample");
    }

    evidence[index] = observation.sample;
  } else evidence.push(observation.sample);

  const recipe = decodeToolLearningRecipe({ ...baseline, automation: "manual", request: { ...baseline.request, evidence } });
  if (recipe === undefined) return err("invalid_recipe", "improvement exceeds recipe bounds or removes mandatory sample coverage");

  const correctingFalsePositive = observation.source.kind === "false_positive" || observation.source.kind === "explicit_correction";

  return ok({ observation, baselineVersionId: checkRecipeVersionId(baseline), recipeVersionId: checkRecipeVersionId(recipe),
    recipe, change: index < 0 ? "add_sample" : "replace_sample",
    validation: { baselineCandidate: correctingFalsePositive ? "valid" : "faulty", baselineExpected: correctingFalsePositive ? "fail" : "pass" } });
}

/** Reports must come from the caller's real verifier port. This is a trial gate, not authority issuance. */
export function assessCheckImprovement(plan: CheckImprovementPlan, reports: CheckValidationReports): CheckResult<CheckAssessment> {
  const prepared = prepareCheckImprovement(plan.observation);
  if (!prepared.ok || canonicalJson(prepared.value) !== canonicalJson(plan)) return err("invalid_validation", "plan differs from its source observation");

  const controls = plan.observation.controls;
  const baselineCandidate = controls[plan.validation.baselineCandidate];
  if (!reportMatches(reports.baseline, baselineCandidate, plan.observation.baselineRecipe.request)
    || !reportMatches(reports.faulty, controls.faulty, plan.recipe.request)
    || !reportMatches(reports.valid, controls.valid, plan.recipe.request)) {
    return err("invalid_validation", "reports need exact candidate/sample hashes, coverage and conclusive process outcomes");
  }

  const baselineExpected = plan.validation.baselineExpected;
  const baselinePass = baselineExpected === "pass"
    ? hasCompleteSampleCoverage(plan.observation.baselineRecipe.request, reports.baseline)
    : reports.baseline.verdict === "fail" && wrongObservedSample(plan, reports.baseline);
  if (!baselinePass || reports.faulty.verdict !== "fail" || !wrongObservedSample(plan, reports.faulty)
    || !hasCompleteSampleCoverage(plan.recipe.request, reports.valid)) {
    return err("no_improvement", "recipe must reproduce the old miss or false positive, reject the faulty control and preserve the valid control");
  }

  return ok({ status: "trial_supported", recipeVersionId: plan.recipeVersionId, reports: structuredClone(reports) });
}

function wrongObservedSample(plan: CheckImprovementPlan, report: ToolEvolutionVerification): boolean {
  return report.checks.some(check => check.sampleId === plan.observation.sample.sampleId && check.outcome === "wrong_result");
}

function reportMatches(report: ToolEvolutionVerification, candidate: ToolEvolutionCandidate, request: ToolEvolutionRequest): boolean {
  return report.candidateHash === contentHashOf(candidate) && report.samplesHash === contentHashOf(request.evidence)
    && hasExactSampleCoverage(request, report) && (report.verdict === "pass" || report.verdict === "fail")
    && report.checks.every(check => check.outcome === "passed" || check.outcome === "wrong_result")
    && (report.verdict === "pass") === report.checks.every(check => check.outcome === "passed");
}
