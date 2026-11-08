import type { CandidateExecutor } from "../../../../../domains/tool/evolution/execution.js";
import type { CheckEvaluation, CheckExperience, CheckInput, CheckRequirements, CheckSample, CheckerVerdict, LearnedChecker } from "../../domain/v2/contracts.js";

export const CHECKER_RUNS_PER_TURN = 3;

export type CheckerGenerationUsage = { readonly inputTokens: number; readonly outputTokens: number };

export type CheckerGenerator = { generate(input: { readonly requestId: string; readonly prompt: string;
  readonly maxOutputTokens: number; readonly signal: AbortSignal }): Promise<
    { readonly status: "generated"; readonly text: string; readonly usage: CheckerGenerationUsage; readonly model: string }
    | { readonly status: "failed" | "cancelled"; readonly code: string; readonly usage: CheckerGenerationUsage; readonly model: string }> };

export type CheckerOutcome = { readonly kind: "checked"; readonly verdict: CheckerVerdict }
  | { readonly kind: "checker_error"; readonly code: string }
  | { readonly kind: "cancelled" };

export type CheckerRun = { readonly schemaVersion: 2; readonly type: "checker_run"; readonly runId: string;
  readonly versionId: string; readonly scope: string; readonly sessionId: string; readonly turnId: string;
  readonly requirements: CheckRequirements; readonly input: CheckInput; readonly inputDigest: string; readonly outcome: CheckerOutcome };

/** Reservation is durable before execution; the bounded input permits honest orphan closeout after restart. */
export type CheckerRunClaim = { readonly schemaVersion: 2; readonly type: "checker_run_claim"; readonly runId: string;
  readonly versionId: string; readonly scope: string; readonly sessionId: string; readonly turnId: string;
  readonly inputDigest: string; readonly ownerId: string; readonly requirements: CheckRequirements; readonly input: CheckInput };

export type CheckerCorrectionScope = { readonly kind: "task"; readonly sessionId: string; readonly turnId: string }
  | { readonly kind: "class" | "long_term"; readonly requirementRef: string; readonly requirementDigest: string };

export type CheckerFeedback = { readonly schemaVersion: 2; readonly type: "checker_feedback"; readonly scope: string;
  readonly sessionId: string; readonly turnId: string; readonly sourceRef: string; readonly text: string; readonly runIds: readonly string[];
  /** Missing in early v2 records: interpreted as a correction of the cited task, never a global override. */
  readonly appliesTo?: CheckerCorrectionScope;
  readonly judgment?: { readonly runId: string; readonly expected: "pass" | "fail" | "not_applicable" } };

export type CheckerVersion = { readonly schemaVersion: 2; readonly type: "checker_version"; readonly checker: LearnedChecker;
  readonly requirements: CheckRequirements; readonly experienceRefs: readonly string[]; readonly evaluation?: CheckEvaluation;
  readonly validationSamples?: readonly CheckSample[];
  readonly generation: { readonly requestId: string; readonly model: string; readonly usage: CheckerGenerationUsage;
    readonly exposedInputs?: readonly string[] } };

export type CheckerAllowance = { readonly modelCalls: number; readonly executions: number; readonly tokens: number };

export type CheckerUsage = { readonly modelCalls: number; readonly executions: number; readonly tokens: number };

/** A durable reservation precedes every provider call. Hidden evaluation facts never occur in this record. */
export type CheckerGenerationStart = { readonly schemaVersion: 2; readonly type: "checker_generation_started";
  readonly requestId: string; readonly jobId: string; readonly scope: string; readonly ownerId: string; readonly attempt: number;
  readonly requirementRef: string; readonly requirementDigest: string; readonly promptDigest: string;
  readonly exposedInputs: readonly string[]; readonly experienceRefs: readonly string[];
  readonly tokenReserve: number; readonly maxOutputTokens: number };

/** Public provider output is evidence, never an oracle. Secret-shaped output is represented only by its digest. */
export type CheckerGeneration = { readonly schemaVersion: 2; readonly type: "checker_generation"; readonly requestId: string;
  readonly jobId: string; readonly scope: string; readonly model: string; readonly usage: CheckerGenerationUsage;
  readonly chargedTokens: number; readonly usageStatus: "reported" | "unknown"; readonly outcome: "generated" | "no_change" | "rejected" | "failed" | "cancelled";
  readonly reason: string; readonly output: { readonly kind: "public"; readonly text: string; readonly digest: string }
    | { readonly kind: "withheld"; readonly digest: string; readonly reason: "credential_shape" | "output_capacity" }
    | { readonly kind: "none" };
  readonly candidate?: LearnedChecker };

export type CheckerGenerationEvaluation = { readonly schemaVersion: 2; readonly type: "checker_generation_evaluation";
  readonly requestId: string; readonly jobId: string; readonly scope: string; readonly candidate: LearnedChecker;
  readonly evaluation: CheckEvaluation; readonly validationSamples: readonly CheckSample[] };

export type CheckerJobResult = { readonly schemaVersion: 2; readonly type: "checker_job_result"; readonly jobId: string;
  readonly scope: string; readonly outcome: "generated" | "no_change" | "rejected" | "failed" | "cancelled";
  readonly reason: string; readonly usage: CheckerUsage; readonly versionId?: string };

export type CheckerEngineOptions = { readonly boardRoot: string; readonly generator: CheckerGenerator; readonly executor: CandidateExecutor;
  readonly collection: () => "enabled" | "disabled"; readonly now: () => number;
  readonly assessCompatibility?: (experience: CheckExperience) => { readonly ok: true } | CheckerFailure;
  readonly owner: { readonly id: string; readonly alive: (ownerId: string) => Promise<"alive" | "dead" | "unknown"> } };

export type CheckerCatalog = { readonly experiences: readonly { readonly versionId: string; readonly value: CheckExperience }[];
  readonly versions: readonly { readonly versionId: string; readonly value: CheckerVersion }[]; readonly runs: readonly CheckerRun[];
  readonly runClaims: readonly CheckerRunClaim[];
  readonly feedbacks: readonly CheckerFeedback[]; readonly results: readonly CheckerJobResult[];
  readonly leases: readonly CheckerLease[]; readonly generationStarts: readonly CheckerGenerationStart[];
  readonly generations: readonly CheckerGeneration[]; readonly generationEvaluations: readonly CheckerGenerationEvaluation[] };

export type CheckerLease = { readonly schemaVersion: 2; readonly type: "checker_lease"; readonly jobId: string;
  readonly scope: string; readonly ownerId: string; readonly allowance: CheckerAllowance; readonly basis: string };

export type CheckerRecord = CheckExperience | CheckerVersion | CheckerRun | CheckerRunClaim | CheckerFeedback | CheckerJobResult | CheckerLease
  | CheckerGenerationStart | CheckerGeneration | CheckerGenerationEvaluation;

export type CheckerFailure = { readonly ok: false; readonly code: string; readonly message: string };
