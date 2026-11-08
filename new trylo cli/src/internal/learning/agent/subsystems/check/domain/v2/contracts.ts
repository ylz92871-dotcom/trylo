import type { JsonObject, JsonValue } from "../../../../../../protocol/envelope.js";
import type { CandidateExecutor, CandidateExecution } from "../../../../../domains/tool/evolution/execution.js";
import type { Result } from "../../../../../../tooling/contract/result.js";

/** v2 adds generated executable checking methods. v1 sample recipes remain a separate readable namespace. */
export const CHECK_V2_SCHEMA_VERSION = 2;
export const CHECK_V2_LIMITS = {
  inputBytes: 16_384, experienceBytes: 65_536, candidateBytes: 65_536,
  sourceBytes: 32_768, samples: 32, sourceRefs: 32, findings: 16,
  promptBytes: 131_072, promptExperiences: 16,
} as const;

export type CheckPhase = "after_tool" | "before_completion";

export type CheckStatus = "pass" | "fail" | "not_applicable";

export type CheckRequirements = { readonly ref: string; readonly digest: string; readonly text: string; readonly schema?: JsonObject };

export type CheckInput = {
  readonly task: { readonly instruction: string; readonly requirementRef: string; readonly requirementDigest: string };
  readonly phase: CheckPhase;
  readonly tool?: { readonly name: string; readonly args: JsonObject; readonly result: JsonValue };
  readonly output: JsonValue;
};

export type CheckExperience = {
  readonly schemaVersion: 2;
  readonly type: "check_experience";
  readonly id: string;
  readonly scope: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly requirements: CheckRequirements;
  readonly facts: CheckInput;
  readonly assessment?: {
    readonly verdict: "valid" | "invalid" | "not_applicable";
    readonly sourceRef: string;
    readonly kind: "user_correction" | "task_oracle";
  };
  readonly priorRuns: readonly string[];
};

/** Conditions are evaluated locally. Natural-language claims never grant applicability or authority. */
export type CheckerApplicability = {
  readonly scope: string;
  readonly requirementRef: string;
  readonly requirementDigest: string;
  readonly requiredKeys: readonly string[];
  readonly excludedKeys: readonly string[];
  readonly instructionIncludes: readonly string[];
};

export type LearnedChecker = {
  readonly schemaVersion: 2;
  readonly type: "learned_checker";
  readonly question: string;
  readonly claim: string;
  readonly applicability: CheckerApplicability;
  readonly timing: readonly CheckPhase[];
  readonly source: string;
  readonly sourceRefs: readonly string[];
  readonly parentVersionId?: string;
};

export type CheckerVerdict = {
  readonly status: CheckStatus;
  readonly findings: readonly { readonly requirementRef: string; readonly message: string }[];
};

/** Oracle labels belong to the host and are never part of a generated checker artifact. */
export type CheckSample = {
  readonly id: string;
  readonly role: "source" | "holdout";
  readonly input: CheckInput;
  readonly expected: CheckStatus;
  readonly oracle: { readonly kind: "task_oracle" | "user_correction"; readonly sourceRef: string; readonly requirementDigest: string };
};

export type CheckEvaluationCase = {
  readonly sampleId: string;
  readonly role: CheckSample["role"];
  readonly expected: CheckStatus;
  readonly execution: "executed" | "not_applicable";
  readonly outcome:
    | { readonly kind: "matched" | "mismatch"; readonly verdict: CheckerVerdict }
    | { readonly kind: "checker_error"; readonly code: Exclude<CandidateExecution["kind"], "value"> | "invalid_verdict" | "executor_threw" }
    | { readonly kind: "cancelled" };
};

export type CheckEvaluation = {
  readonly status: "supported" | "rejected" | "incomplete" | "cancelled";
  readonly candidateHash: string;
  readonly samplesHash: string;
  readonly cases: readonly CheckEvaluationCase[];
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly checkerErrors: number;
};

export type EvaluateCheckerInput = {
  readonly candidate: LearnedChecker;
  readonly samples: readonly CheckSample[];
  readonly executor: CandidateExecutor;
  readonly signal: AbortSignal;
};

export type CheckV2FailureCode = "invalid_experience" | "invalid_input" | "invalid_requirements"
  | "invalid_checker" | "invalid_sample" | "invalid_verdict" | "invalid_corpus" | "prompt_capacity" | "unbound_checker";

export type CheckV2Result<T> = Result<T, CheckV2FailureCode>;
