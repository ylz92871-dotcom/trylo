/** Versioned display projection of durable workflow facts, never an executor. */
export type WorkflowStreamEvent = {
  readonly type: "workflow_state";
  readonly version: 1;
  readonly workflowVersionId: string;
  readonly traceId: string;
  readonly executionId?: string;
  readonly sessionId: string;
  readonly branchId?: string;
  readonly state: "running" | "waiting" | "cancelled" | "budget_exhausted" | "interrupted" | "completed" | "failed";
  readonly outcome: "success" | "failure" | "unknown";
  readonly steps: readonly { readonly nodeId: string; readonly status: "passed" | "failed"; readonly input: string; readonly output: string; readonly evidenceRefs: readonly string[];
    readonly dependsOn?: readonly string[]; readonly inputBindings?: Readonly<Record<string, string>>; readonly outputDigest?: string; readonly recoveryTo?: string }[];
  readonly cost?: { readonly tokens: number; readonly wallMs: number };
  readonly budgetReceipt?: { readonly initialTokens: number; readonly grantedTokens: number; readonly observedOutputTokens: number;
    readonly reservedUnknownTokens: number; readonly remainingTokens: number; readonly usageUncertain: boolean };
};
