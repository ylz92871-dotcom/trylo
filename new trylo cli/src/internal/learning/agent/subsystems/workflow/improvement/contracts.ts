import type { WorkflowLearningResult, WorkflowTask } from "../domain/trace-contracts.js";
import type { CentralLearningSourceContext } from "../../../../control/source-context.js";
import type { WorkflowResearchAction, WorkflowResearchInput, WorkflowResearchUsage } from "./research-contracts.js";

/** A reusable operation contract can span business tasks without spanning effects/check semantics. */
export type WorkflowProcessContract = {
  readonly key: string;
  readonly inputContract: string;
  readonly outputContract: string;
  readonly sideEffects: "read_only" | "local_artifact" | "external";
  readonly checkContract: string;
};

export type WorkflowProcessTask = WorkflowTask & { readonly process?: WorkflowProcessContract };

/** Evidence is a bounded public projection supplied by the host, never model reasoning. */
export type WorkflowImprovementEvidence = {
  readonly ref: string;
  readonly kind: "tool_success" | "tool_failure" | "quality_failure" | "user_input" | "user_correction" | "rework" | "context";
  readonly summary: string;
  readonly executionId?: string;
  /** Historical facts retain the immutable version whose context supplied them. */
  readonly sourceVersionId?: string;
};

export type WorkflowOpportunity = {
  readonly opportunityId: string;
  /** Stable problem identity within this exact scope/family; wording may change. */
  readonly issueKey: string;
  readonly task: WorkflowProcessTask;
  readonly trigger: "repeated_inefficiency" | "user_correction" | "central_research";
  readonly problem: string;
  readonly desiredOutcome: string;
  readonly evidenceRefs: readonly string[];
  /** Optional local rewrite target in the existing improvement parent, not legacy checkpoint IDs. */
  readonly affectedStepIds?: readonly string[];
};

/** A diagnosis remains falsifiable even after the associated workflow helps. */
export type WorkflowDiagnosis = {
  readonly hypothesis: string;
  readonly supportingRefs: readonly string[];
  readonly counterEvidenceRefs: readonly string[];
  readonly alternatives: readonly string[];
  readonly discriminateBy: readonly string[];
};

export type WorkflowProcedureStep = {
  readonly id: string;
  readonly action: string;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly dependsOn: readonly string[];
  /** The executor must obtain this observable fact; unknown never means true. */
  readonly when?: { readonly fact: string; readonly equals: string };
  readonly verify: string;
  readonly onFailure:
    | { readonly action: "replan" | "stop"; readonly reason: string }
    | { readonly action: "goto"; readonly target: string; readonly maxAttempts: number; readonly reason: string };
};

export type WorkflowProcedure = {
  readonly name: string;
  readonly requiredConditions: Readonly<Record<string, string>>;
  readonly assumptions: readonly { readonly claim: string; readonly check: string }[];
  readonly steps: readonly WorkflowProcedureStep[];
  readonly qualityInvariants: readonly string[];
  /** Cache/reuse is valid only while these observable conditions hold. */
  readonly invalidationSignals: readonly string[];
  readonly stopRules: readonly string[];
};

export type WorkflowProcessChange = {
  readonly kind: "replace" | "insert" | "remove" | "reorder" | "branch" | "reuse" | "stop_rule";
  readonly stepIds: readonly string[];
  readonly before: string;
  readonly after: string;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
  readonly expectedEffect: string;
};

export type WorkflowImprovementProposal = {
  readonly diagnosis: WorkflowDiagnosis;
  readonly procedure: WorkflowProcedure;
  readonly changes: readonly WorkflowProcessChange[];
};

/** Separate from historical trace extraction: these actions need not have occurred yet. */
export type WorkflowImprovement = {
  readonly schemaVersion: 1;
  readonly type: "workflow_improvement";
  readonly opportunity: WorkflowOpportunity;
  readonly proposal: WorkflowImprovementProposal;
  readonly evidence: readonly WorkflowImprovementEvidence[];
  readonly parentVersionId?: string;
  readonly claim: "proposed_improvement";
};

export type WorkflowImprovementUse = {
  readonly useId: string;
  readonly versionId: string;
  readonly task: WorkflowProcessTask;
  readonly boundary: string;
};

/** Independent host evidence of the exposed control path; model step labels cannot create it. */
export type WorkflowProcessEvidence =
  | { readonly kind: "unverified" }
  | { readonly kind: "partial"; readonly checkerRef: string; readonly evidenceRefs: readonly string[];
      readonly checkedStepIds: readonly string[] }
  | { readonly kind: "complete"; readonly checkerRef: string; readonly evidenceRefs: readonly string[];
      readonly checkedStepIds: readonly string[]; readonly skippedStepIds: readonly string[] };

/** Created by the runtime from current, post-adoption receipts. Model labels are not verdicts. */
export type WorkflowImprovementFeedback = {
  readonly feedbackId: string;
  readonly useId: string;
  readonly versionId: string;
  readonly executionId: string;
  readonly task: WorkflowProcessTask;
  readonly exposure: "reported_used" | "skipped";
  readonly quality: "passed" | "failed" | "unknown";
  readonly evidenceRefs: readonly string[];
  readonly followedStepIds: readonly string[];
  readonly explanation: string;
  readonly processEvidence?: WorkflowProcessEvidence;
  /** Only an explicit operator/user action may create this, never the model report tool. */
  readonly userAssessment?: { readonly judgment: "helped" | "harmed" | "neutral"; readonly evidenceRef: string };
  readonly comparison?: {
    /** Same input/check/context fingerprint, distinct executions, both costs measured. */
    readonly comparisonKey: string;
    readonly baselineExecutionId: string;
    readonly candidateExecutionId: string;
    readonly baselineQuality: "passed" | "failed";
    readonly baselineCost: number;
    readonly candidateCost: number;
    readonly unit: "tokens" | "wall_ms" | "tool_calls" | "rework_steps";
    readonly evidenceRefs: readonly string[];
  };
};

export type WorkflowImprovementReputation = {
  readonly reportedUses: number;
  readonly qualityPasses: number;
  readonly qualityFailures: number;
  readonly unknown: number;
  readonly skipped: number;
  readonly comparableUses: number;
  readonly improvements: number;
  readonly regressions: number;
  readonly recentFailures: number;
  readonly userHelped: number;
  readonly userHarmed: number;
  readonly userNeutral: number;
  readonly disputed: number;
  /** Adverse evidence in another host task with this exact process/condition contract. */
  readonly relatedAdverseUses: number;
  readonly completeProcessUses: number;
  readonly partialProcessUses: number;
  readonly unverifiedProcessUses: number;
  readonly processQualityPasses: number;
  /** Beta(1,1) smoothing of observed task quality; not causal or calibrated confidence. */
  readonly qualityEstimate: number;
  readonly standing: "untried" | "trial" | "user_supported" | "supported" | "needs_revision";
};

export type WorkflowImprovementModelInput = {
  readonly centralContent?: CentralLearningSourceContext;
  readonly opportunity: WorkflowOpportunity;
  readonly evidence: readonly WorkflowImprovementEvidence[];
  readonly parent?: WorkflowImprovement;
  /** Bounded prior interventions, including failures, in this same problem lineage. */
  readonly history?: readonly { readonly versionId: string; readonly artifact: WorkflowImprovement }[];
  readonly feedback: readonly WorkflowImprovementFeedback[];
};

export type WorkflowImprovementResearchInput = WorkflowResearchInput<WorkflowImprovementModelInput>;

export type WorkflowImprovementResearchAction = WorkflowResearchAction<WorkflowImprovementProposal>;

export type WorkflowImprovementModelPort = {
  propose(input: WorkflowImprovementModelInput, signal: AbortSignal, allowance: number): Promise<WorkflowLearningResult<WorkflowImprovementProposal>>;
  /** Optional on old custom ports; one invocation is one separately reserved research call. */
  research?(input: WorkflowImprovementResearchInput, signal: AbortSignal, allowance: number): Promise<WorkflowLearningResult<WorkflowImprovementResearchAction>>;
  /** Per-call accounting, independent from the legacy proposal accumulator. */
  researchUsage?(): WorkflowResearchUsage;
  usage(): { readonly calls: number; readonly tokens: number; readonly observedTokens: number; readonly uncertain: boolean };
};
