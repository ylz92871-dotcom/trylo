import type { ProviderMessage } from "./provider.js";

export type SubagentRoutingPath = "independent" | "fork";

export type SubagentRoutingDecision = {
  readonly path: SubagentRoutingPath;
  readonly reason: string;
  readonly versionId?: string;
  readonly candidateIds: readonly string[];
};

export type SubagentRoutingConditions = {
  readonly parentAvailable: boolean;
  readonly parentMessageCount: number;
  /** Omitted when a bounded inspection cannot establish the exact serialized size. */
  readonly parentBytes?: number;
  /** Capacity fallback reports raw input facts without building the completed-context list. */
  readonly parentContextBasis?: "input";
  readonly messageBytes: number;
};

/** Safe to persist: the transient message and parent contents never enter this receipt. */
export type SubagentRoutingReceipt = {
  readonly selectionExecutionId: string;
  readonly decision: SubagentRoutingDecision;
  readonly actualPath: SubagentRoutingPath;
  readonly conditions: SubagentRoutingConditions;
};

type SubagentRoutingIdentity = SubagentRoutingReceipt & {
  readonly executionId: string;
  readonly taskId: string;
  readonly agentId: string;
  readonly round: number;
};

export type SubagentRoutingDispatch = SubagentRoutingIdentity & { readonly requestId: string };

export type SubagentRoutingFinish = SubagentRoutingIdentity & {
  readonly endState: "completed" | "failed" | "cancelled" | "timed_out";
  /** Reported values come from provider usage; unknown is never a measured zero. */
  readonly usage: { readonly state: "reported" | "unknown"; readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number;
    readonly cachedInputTokens?: number };
  readonly dispatchedRequestIds: readonly string[];
  /** Wall duration includes input-idle time; use provider token receipts for billed cost. */
  readonly latencyMs: number;
};

/** Execution-owned choice and body-free observations. No learner, store or scheduler lives here.
 * Choosing context cannot change the model, role, tools, permissions or worker lifecycle. */
export type SubagentRoutingPort = {
  choose(input: { readonly executionId: string; readonly message: string;
    readonly parentMessages: readonly ProviderMessage[]; readonly explicitFork?: boolean;
    readonly inheritedProfile?: boolean;
    readonly signal: AbortSignal }): Promise<SubagentRoutingDecision>;
  dispatched(input: SubagentRoutingDispatch): Promise<void>;
  finished(input: SubagentRoutingFinish): Promise<void>;
};

/** Supplied implicit choices are byte-bounded; explicit forks retain their existing execution contract. */
export const SUBAGENT_ROUTING_PARENT_BYTES = 131_072;

