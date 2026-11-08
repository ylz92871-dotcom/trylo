import type { Result } from "../../../../../../tooling/contract/result.js";
import type { ToolEvolutionCandidate, ToolEvolutionSample } from "../../../../../domains/tool/evolution/contracts.js";
import type { ToolLearningRecipe } from "../../../../../domains/tool/evolution/pipeline.js";
import type { ToolEvolutionVerification } from "../../../../../domains/tool/evolution/verification.js";

/** Additive v1 contract. It improves caller-owned sample coverage, never task authority. */
export type CheckCorrection = {
  readonly targetVersionId: string;
  readonly appliesTo: { readonly kind: "task"; readonly taskId: string }
    | { readonly kind: "class" } | { readonly kind: "long_term" };
};

export type CheckObservation = {
  readonly schemaVersion: 1;
  readonly type: "check_observation";
  readonly observationId: string;
  readonly scope: string;
  readonly capability: string;
  readonly requirementRef: string;
  readonly source: {
    readonly kind: "task_result" | "false_negative" | "false_positive" | "explicit_correction";
    readonly ref: string;
    readonly runId: string;
  };
  readonly baselineRecipe: ToolLearningRecipe;
  readonly sample: ToolEvolutionSample;
  readonly controls: { readonly faulty: ToolEvolutionCandidate; readonly valid: ToolEvolutionCandidate };
  readonly correction?: CheckCorrection;
};

export type CheckImprovementPlan = {
  readonly observation: CheckObservation;
  readonly baselineVersionId: string;
  readonly recipeVersionId: string;
  readonly recipe: ToolLearningRecipe;
  readonly change: "add_sample" | "replace_sample";
  readonly validation: { readonly baselineCandidate: "faulty" | "valid"; readonly baselineExpected: "pass" | "fail" };
};

export type CheckValidationReports = {
  readonly baseline: ToolEvolutionVerification;
  readonly faulty: ToolEvolutionVerification;
  readonly valid: ToolEvolutionVerification;
};

export type CheckAssessment = {
  readonly status: "trial_supported";
  readonly recipeVersionId: string;
  readonly reports: CheckValidationReports;
};

export type CheckFailureCode = "invalid_observation" | "scope_mismatch" | "conflicting_sample"
  | "stale_correction" | "no_change" | "invalid_recipe" | "invalid_validation" | "no_improvement";

export type CheckResult<T> = Result<T, CheckFailureCode>;
