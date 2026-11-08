export const ASSET_KINDS = ["user_rule", "prompt_patch", "skill", "workflow"] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

export const DRAFT_STATUS = "draft" as const;

export type DraftStatus = typeof DRAFT_STATUS;

export const SCOPE_KINDS = ["task", "project", "task_family", "user_global"] as const;

export type ScopeKind = (typeof SCOPE_KINDS)[number];

export type Scope = {
  readonly kind: ScopeKind;
  readonly id: string;
};

export type VersionPins = {
  readonly model: string;
  readonly toolset: string;
  readonly codeBaseline: string;
  readonly workflow: string;
};

export const CHECK_KINDS = ["unit_test", "compile", "lint", "acceptance"] as const;

export type CheckKind = (typeof CHECK_KINDS)[number];

export type TaskFamily = {
  readonly id: string;
  readonly intentClass: string;
  readonly checkKind: CheckKind;
  readonly language?: string;
  readonly repoKind?: string;
  readonly checkSchema?: string;
};

export const EXTERNAL_VERDICT_KINDS = [
  "test",
  "exit_code",
  "user_acceptance",
  "independent_verifier",
] as const;

export type ExternalVerdictKind = (typeof EXTERNAL_VERDICT_KINDS)[number];

export const VERDICT_RESULTS = ["pass", "fail", "partial"] as const;

export type VerdictResult = (typeof VERDICT_RESULTS)[number];

export type ExternalVerdict = {
  readonly kind: ExternalVerdictKind;
  readonly result: VerdictResult;
  readonly ref: string;
  readonly selfGenerated: boolean;
};

export const WEAK_SIGNAL_KINDS = [
  "llm_self_score",
  "output_length",
  "token_count",
  "no_complaint",
  "self_generated_tests",
  "judge_rubric",
] as const;

export type WeakSignalKind = (typeof WEAK_SIGNAL_KINDS)[number];

export type WeakSignal = {
  readonly kind: WeakSignalKind;
  readonly note: string;
};

export type PrivacyStamp = {
  readonly rawUserTextStored: false;
  readonly allowedFields: readonly string[];
  readonly pointer?: string;
};

export type Provenance = {
  readonly source: "user_explicit" | "inferred_from_observations";
  readonly observationRefs: readonly string[];
  readonly createdBy:
    | "user_builder"
    | "prompt_detector"
    | "skill_inducer"
    | "workflow_inducer";
};

export const FAILURE_CODES = [
  "insufficient_evidence",
  "insufficient_attribution",
  "needs_more_evidence",
  "permission_claim_rejected",
  "scope_too_broad",
  "forbidden_payload",
  "dual_save_blocked",
  "not_explicit",
  "hidden_cot_rejected",
  "malformed_input",
  "mutation_rejected",
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

export type DomainFailure = {
  readonly kind: "failure";
  readonly code: FailureCode;
  readonly reason: string;
  readonly confounders: readonly string[];
};

export const PROMPT_SECTIONS = [
  "role",
  "constraint",
  "context_order",
  "tool_description",
  "phrasing",
] as const;

export type PromptSection = (typeof PROMPT_SECTIONS)[number];

export type PromptOp =
  | {
      readonly op: "replace_section";
      readonly section: PromptSection;
      readonly fromHash: string;
      readonly toHash: string;
    }
  | {
      readonly op: "add_constraint";
      readonly constraintHash: string;
    }
  | {
      readonly op: "reorder_context";
      readonly order: readonly string[];
    };

export type TrajectorySketch = {
  readonly nodeIds: readonly string[];
  readonly stepCount: number;
  readonly hadFailureRecovery: boolean;
  readonly hadChecks: boolean;
};

export function domainFailure(
  code: FailureCode,
  reason: string,
  confounders: readonly string[] = [],
): DomainFailure {
  return { kind: "failure", code, reason, confounders };
}

export function privacyStamp(
  allowedFields: readonly string[],
  pointer?: string,
): PrivacyStamp {
  if (pointer === undefined) {
    return { rawUserTextStored: false, allowedFields };
  }
  return { rawUserTextStored: false, allowedFields, pointer };
}
