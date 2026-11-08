import type { TaskFamily } from "../../../../domains/shared/types.js";

/** Version 1 records explicit, redacted execution facts, never hidden reasoning. */
export type WorkflowStep = {
  readonly nodeId: string;
  readonly input: string;
  readonly output: string;
  readonly dependsOn: readonly string[];
  readonly check: string;
  readonly status: "passed" | "failed";
  readonly evidenceRefs: readonly string[];
  readonly recoveryTo?: string;
  readonly inputBindings?: Readonly<Record<string, string>>;
  readonly outputDigest?: string;
};

export type WorkflowTrace = {
  readonly schemaVersion: 1;
  readonly traceId: string;
  readonly scope: string;
  readonly taskFamily: TaskFamily;
  readonly source: "imported" | "runtime";
  readonly steps: readonly WorkflowStep[];
  readonly outcome: "success" | "failure" | "unknown";
  readonly workflowVersionId?: string;
  readonly conditions?: Readonly<Record<string, string>>;
  readonly conditionEvidenceRefs?: readonly string[];
  readonly adoptedBranchId?: string;
  readonly sessionId?: string;
  readonly executionId?: string;
  readonly runState?: "running" | "waiting" | "cancelled" | "budget_exhausted" | "interrupted" | "completed" | "failed";
  readonly cost?: { readonly tokens: number; readonly wallMs: number };
  readonly otherFailures?: readonly { readonly toolCallId: string; readonly command: string; readonly evidenceRef: string }[];
  readonly budgetReceipt?: WorkflowBudgetReceipt;
};

export type WorkflowBudgetReceipt = {
  readonly initialTokens: number;
  readonly grantedTokens: number;
  readonly observedOutputTokens: number;
  readonly reservedUnknownTokens: number;
  readonly remainingTokens: number;
  readonly usageUncertain: boolean;
};

export type WorkflowTask = {
  readonly scope: string;
  readonly taskFamily: TaskFamily;
  readonly conditions?: Readonly<Record<string, string>>;
};

export type LearnedWorkflowNode = {
  readonly id: string;
  readonly input: string;
  readonly output: string;
  readonly dependsOn: readonly string[];
  readonly check: string;
};

export type WorkflowLesson = {
  readonly afterNode: string;
  readonly goto?: string;
  readonly lesson: string;
  readonly evidenceRefs: readonly string[];
};

export type WorkflowPathStatistics = {
  readonly samples: number;
  readonly successes: number;
  readonly failures: number;
  readonly unknown: number;
  readonly failedChecks: number;
  readonly failedOperations: number;
  readonly reworkSteps: number;
  readonly totalSteps: number;
  readonly measuredCostSamples: number;
  readonly totalTokens: number;
  readonly totalWallMs: number;
};

export type WorkflowBranch = {
  readonly id: string;
  readonly when: Readonly<Record<string, string>>;
  readonly mode: "path" | "lessons_only";
  readonly nodes: readonly LearnedWorkflowNode[];
  readonly recovery: readonly WorkflowLesson[];
  readonly positiveEvidenceRefs: readonly string[];
  readonly negativeEvidenceRefs: readonly string[];
  readonly statistics: WorkflowPathStatistics;
  readonly checkProvenance?: readonly WorkflowCheckProvenance[];
};

export type WorkflowCheckProvenance = {
  readonly nodeId: string;
  readonly check: string;
  readonly sourceRef: string;
  readonly status: "pending_execution" | "observed";
  readonly baseEvidenceRefs: readonly string[];
  readonly observedTraceIds: readonly string[];
  readonly passedTraceIds: readonly string[];
};

export type WorkflowLearningLedger = {
  readonly algorithm: "evidence-cost-v2";
  readonly maxRounds: number;
  readonly rounds: number;
  readonly stopReason: "stable" | "round_limit";
  readonly processedTraces: number;
  readonly examinedCandidates: number;
  readonly supersededTraceIds: readonly string[];
  readonly statisticsScope: "window";
  readonly changes: readonly { readonly round: number; readonly branchId: string; readonly supportingTraceIds: readonly string[] }[];
};

/** Kept in Board assets as working experience. No activation/permission claim. */
export type WorkflowLearningArtifact = WorkflowTask & {
  readonly schemaVersion: 1 | 2;
  readonly type: "workflow_learning";
  readonly requestId: string;
  readonly mode: "path" | "lessons_only";
  readonly nodes: readonly LearnedWorkflowNode[];
  readonly recovery: readonly WorkflowLesson[];
  readonly positiveEvidenceRefs: readonly string[];
  readonly negativeEvidenceRefs: readonly string[];
  readonly traces: readonly WorkflowTrace[];
  readonly parentVersionId?: string;
  readonly correction?: WorkflowCorrection;
  /** Present on V2; absent on frozen legacy V1 assets. */
  readonly branches?: readonly WorkflowBranch[];
  readonly learning?: WorkflowLearningLedger;
  readonly evidenceWindow?: WorkflowEvidenceWindow;
};

export type WorkflowCorrection = {
  readonly reason: string;
  readonly nodeId: string;
  readonly check: string;
  readonly recoveryTo?: string;
  readonly when?: Readonly<Record<string, string>>;
};

export type WorkflowLearningRequest = WorkflowTask & {
  readonly requestId: string;
  readonly subsystem: "workflow";
  readonly collect: boolean;
  readonly budget: { readonly maxEpisodes: number; readonly maxSteps: number; readonly maxTokens: number; readonly maxRounds?: number };
  readonly traces: readonly WorkflowTrace[];
  readonly parentVersionId?: string;
  readonly correction?: WorkflowCorrection;
  /** Internal only: constructed from immutable parent/feedback records. */
  readonly evidenceWindow?: WorkflowEvidenceWindow;
};

export type WorkflowEvidenceWindow = {
  readonly parentVersionId: string;
  readonly retainedTraceIds: readonly string[];
  readonly omittedRefs: readonly string[];
  readonly statisticsScope: "window";
};

export type WorkflowLearningFailure = { readonly ok: false; readonly code: string; readonly message: string };

export type WorkflowLearningResult<T> = { readonly ok: true; readonly value: T } | WorkflowLearningFailure;
