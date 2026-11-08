import type { SubagentHandoff } from "../protocol/subagent-handoff.js";
import type { SubagentStatus } from "./types.js";
import { systemTimerScheduler, type TimerScheduler } from "./scheduler.js";
import { observeOptional, OPTIONAL_OBSERVER_TIMEOUT_MS } from "./optional-observer.js";

/** A boundary observation, never another owner of member state or authority. */
export type CollaborationRound = {
  readonly configuration?: import("./member-configuration.js").SubagentMemberConfigurationMetadata;
  readonly executionId?: string;
  readonly delivery?: import("./input-channel.js").SubagentInput["receipt"];
  readonly teamRunId: string;
  readonly taskId: string;
  readonly memberId: string;
  readonly role: string;
  /** Exact current resolved role description supplied by Execution; older hosts may omit it. */
  readonly roleDescription?: string;
  readonly round: number;
  readonly dependencies: readonly string[];
  readonly assignment: string;
  readonly handoff?: SubagentHandoff;
};

export type SubagentCollaborationPort = {
  readonly accountUsage?: (round: CollaborationRound, usage: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number }) => Promise<void>;
  readonly capture?: (round: CollaborationRound, event: import("../protocol/envelope.js").Envelope) => Promise<void>;
  readonly report?: (round: CollaborationRound, report: import("./collaboration-reporting.js").CollaborationMemberReport) => Promise<void>;
  prepare(round: CollaborationRound, signal: AbortSignal): Promise<string | undefined>;
  /** The compiled request reached a provider response; before-header failures have no receipt. */
  dispatched(round: CollaborationRound, requestId: string, guidance: string | undefined): Promise<void>;
  completed(round: CollaborationRound, output: string): Promise<void>;
  /** Production supplies executionId; legacy task/round callers remain readable but cannot distinguish replacement incarnations. */
  ended(identity: Pick<CollaborationRound, "teamRunId" | "taskId" | "memberId" | "round" | "executionId">,
    status: SubagentStatus, errorCode?: string): Promise<void>;
};

export type CollaborationObserverPhase = keyof SubagentCollaborationPort;

export const COLLABORATION_OBSERVER_TIMEOUT_MS = OPTIONAL_OBSERVER_TIMEOUT_MS;

/** Optional learning observers have no authority to fail or withhold execution. */
export function guardCollaborationPort(port: SubagentCollaborationPort,
  onFailure?: (phase: CollaborationObserverPhase) => void,
  scheduler: TimerScheduler = systemTimerScheduler): SubagentCollaborationPort {
  const failed = (phase: CollaborationObserverPhase): void => {
    try { onFailure?.(phase); }
    catch {
      // The diagnostic is another observer. Its failure cannot suppress the original execution fact.
    }
  };
  const observe = async <T>(phase: CollaborationObserverPhase, operation: () => Promise<T>, signal?: AbortSignal): Promise<T | undefined> => {
    const observed = await observeOptional(operation, scheduler, signal);
    if (observed.kind === "value") return observed.value;
    if (observed.kind === "failed") failed(phase);
    return undefined;
  };

  return {
    ...(port.accountUsage === undefined ? {} : { accountUsage: async (round: CollaborationRound,
      usage: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number }) => {
      await observe("accountUsage", () => port.accountUsage!(round, usage));
    } }),
    ...(port.capture === undefined ? {} : { capture: async (round: CollaborationRound, event: import("../protocol/envelope.js").Envelope) => {
      await observe("capture", () => port.capture!(round, event));
    } }),
    ...(port.report === undefined ? {} : { report: async (round: CollaborationRound, report: import("./collaboration-reporting.js").CollaborationMemberReport) => {
      await observe("report", () => port.report!(round, report));
    } }),
    prepare: (round, signal) => observe("prepare", () => port.prepare(round, signal), signal),
    async dispatched(round, requestId, guidance) { await observe("dispatched", () => port.dispatched(round, requestId, guidance)); },
    async completed(round, output) { await observe("completed", () => port.completed(round, output)); },
    async ended(identity, status, errorCode) { await observe("ended", () => port.ended(identity, status, errorCode)); },
  };
}
