import type { WorkflowLearningResult, WorkflowTask } from "../domain/trace-contracts.js";

/** The model proposes meaning; runtime receipts alone attest execution/checks. */
export type WorkflowObservedCheck = {
  readonly toolCallId: string;
  readonly command: string;
  readonly status: "passed" | "failed";
  readonly evidenceRef: string;
  readonly sequence: number;
};

export type WorkflowObservedMutation = { readonly toolCallId: string; readonly path: string; readonly evidenceRef: string; readonly sequence: number };

export type WorkflowObservedTurn = {
  readonly sessionId: string;
  readonly turnId: string;
  readonly checks: readonly WorkflowObservedCheck[];
  readonly mutations: readonly WorkflowObservedMutation[];
  readonly artifacts?: readonly WorkflowObservedMutation[];
  readonly terminal: "completed" | "failed" | "cancelled" | "unknown";
  readonly tokens: number;
  readonly usageUncertain?: boolean;
  readonly wallMs: number;
};

export type WorkflowTraceProposal = {
  readonly excludedCalls?: readonly { readonly toolCallId: string; readonly role: "inspection" | "work"; readonly reason: string }[];
  readonly steps: readonly {
    readonly nodeId: string;
    readonly input: string;
    readonly output: string;
    readonly dependsOn: readonly string[];
    readonly checkToolCallId: string;
    readonly recoveryTo?: string;
  }[];
};

export type WorkflowModelPort = {
  classify(input: { readonly text: string; readonly scope: string; readonly families: readonly WorkflowTask[]; readonly observed?: WorkflowObservedTurn; readonly validationError?: string }, signal: AbortSignal, allowance?: number): Promise<WorkflowLearningResult<WorkflowTask>>;
  segment(input: { readonly task: WorkflowTask; readonly observed: WorkflowObservedTurn; readonly validationError?: string; readonly previousProposal?: WorkflowTraceProposal }, signal: AbortSignal, allowance?: number): Promise<WorkflowLearningResult<WorkflowTraceProposal>>;
  usage(): { readonly calls: number; readonly tokens: number; readonly allowance: number; readonly observedTokens?: number; readonly uncertain?: boolean };
};
