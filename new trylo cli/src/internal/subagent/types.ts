import type { ToolPort } from "../ports/tools.js";
import type { ObservationOutcome } from "../ports/tool-runner-port.js";
import type { PermissionGrantCache } from "../loop/permission-grants.js";
import type { SubagentInputChannel } from "./input-channel.js";

/**
 * Lifecycle states of a subAgent instance.
 */
export type SubagentStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

/**
 * Provenance and attribution lineage for subAgents.
 * All subAgent activities, events, and audit logs are strictly attributed back to rootAttemptId.
 */
export type SubagentLineage = {
  readonly parentAgentId: string;
  readonly rootAttemptId: string;
  readonly parentAttemptId?: string | undefined;
  readonly toolCallId?: string | undefined;
};

/**
 * Strict permission inheritance contract.
 * Red line: subAgents NEVER receive independent approval channels,
 * and cannot widen permissions beyond what the parent agent granted.
 */
export type SubagentPermissions = {
  readonly allowedTools: ReadonlyArray<string>;
  readonly inheritedGrants?: PermissionGrantCache | undefined;
  /** Always false: subAgents have no UI channel to request user authorization. */
  readonly allowIndependentApproval?: false | undefined;
};

/**
 * Governance limits for subAgents.
 */
export type SubagentGovernance = {
  readonly maxConcurrency?: number | undefined;
  readonly tokenBudget?: number | undefined;
  readonly timeoutMs?: number | undefined;
};

/**
 * Execution context exposed to the running subAgent worker.
 */
export type SubagentContext = {
  readonly subagentId: string;
  readonly name: string;
  readonly lineage: SubagentLineage;
  readonly signal: AbortSignal;
  readonly tools: ToolPort;
  readonly reportProgress: (message: string, percentage?: number | undefined) => void;
  readonly recordUsage: (inputTokens: number, outputTokens: number) => void;
  /**
   * The reading end of the channel the control surface writes to (C43).
   * Absent means the worker runs once and finishes — the historical shape, and
   * the one `delegate_subagent` still uses.
   */
  readonly input?: SubagentInputChannel | undefined;
};

export type SubagentWorker<T = unknown> = (context: SubagentContext) => Promise<T>;

export type SubagentSpawnRequest<T = unknown> = {
  readonly name: string;
  readonly prompt?: string | undefined;
  readonly agentType?: string | undefined;
  /**
   * The work to run. Required on purpose (WP-CLI-N3): a spawn with nothing to
   * run has no behaviour of its own, and the old default — echoing `input` back
   * as a `completed` result — reported success for work that never happened.
   */
  readonly worker: SubagentWorker<T>;
  readonly lineage: SubagentLineage;
  readonly permissions: SubagentPermissions;
  readonly governance?: SubagentGovernance | undefined;
  /**
   * The writing end of the channel handed to this run's worker (C43). The
   * control surface keeps it; the worker only ever sees the reading half.
   */
  readonly input?: SubagentInputChannel | undefined;
};

export type SubagentUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
};

export type SubagentResult<T = unknown> = {
  readonly subagentId: string;
  readonly name: string;
  readonly status: SubagentStatus;
  /**
   * How the observation that produced this value ended. `"timeout"` — the
   * waiter stopped waiting and `status` is the run's state at that instant,
   * which may not be terminal; the run is *not* cancelled by a waiter giving
   * up. `"terminal"` — `status` is the run's terminal state, and it will not
   * change again.
   */
  readonly observed: ObservationOutcome;
  readonly output?: T | undefined;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  } | undefined;
  readonly usage: SubagentUsage;
  readonly lineage: SubagentLineage;
};

export type SubagentProgressListener = (progress: {
  readonly message: string;
  readonly percentage?: number | undefined;
}) => void;

export type SubagentHandle<T = unknown> = {
  readonly subagentId: string;
  readonly name: string;
  readonly lineage: SubagentLineage;
  status(): SubagentStatus;
  cancel(reason?: string | undefined): Promise<boolean>;
  wait(timeoutMs?: number | undefined): Promise<SubagentResult<T>>;
  onProgress(listener: SubagentProgressListener): () => void;
};
