import type { ProfilePort } from "../contract/profile.js";
import type { PermissionPort } from "../ports/permission.js";
import type { ProviderMessage, ProviderPort } from "../ports/provider.js";
import type { ToolSandbox } from "../ports/tools.js";
import { AgentRoundObservation } from "./control-observation.js";
import { createSubagentInputChannel, type SubagentInputChannel } from "./input-channel.js";
import { createInteractiveChildWorker, type InteractiveChildResult } from "./interactive-worker.js";
import { resolveRole, uniqueNicknameFor, type ResolvedRole, type SubagentRole } from "./role.js";
import { SUBAGENT_HISTORY_LIMIT, type SubagentRuntime } from "./runtime.js";
import type { SubagentGovernance, SubagentHandle } from "./types.js";
import type { TimerScheduler } from "./scheduler.js";
import { SubagentGovernanceError } from "./governance.js";
import type { PermissionGrantCache } from "../loop/permission-grants.js";
import type { LoopPorts } from "../loop/runner.js";

export const DEFAULT_AGENT_IDLE_MS = 30_000;
export const AGENT_CLEANUP_WAIT_MS = 5_000;

export type SubagentControlOptions = {
  readonly runtime: SubagentRuntime;
  readonly provider: ProviderPort;
  readonly permission: PermissionPort;
  readonly sandbox?: ToolSandbox;
  readonly profile?: ProfilePort | undefined;
  readonly model?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly parentMessages?: ReadonlyArray<ProviderMessage> | (() => ReadonlyArray<ProviderMessage> | undefined) | undefined;
  readonly allowedTools?: ReadonlyArray<string> | (() => ReadonlyArray<string>) | undefined;
  readonly roles?: ReadonlyArray<SubagentRole> | undefined;
  readonly childMaxIterations?: number | undefined;
  readonly grants?: PermissionGrantCache | undefined;
  readonly execPolicy?: LoopPorts["execPolicy"];
  readonly onEnvelope?: ((envelope: import("../protocol/envelope.js").Envelope) => void) | undefined;
  readonly scheduler?: TimerScheduler | undefined;
};

export type AgentEntry = {
  readonly agentId: string;
  readonly taskId: string;
  readonly roundOffset: number;
  readonly nickname: string;
  readonly instruction: string;
  readonly channel: SubagentInputChannel;
  readonly handle: SubagentHandle<InteractiveChildResult>;
  readonly observation: AgentRoundObservation;
  readonly resolved: ResolvedRole;
  readonly governance: SubagentGovernance;
  readonly idleTimeoutMs: number;
  readonly forkMessages: ReadonlyArray<ProviderMessage> | undefined;
  /** Only automatic parking permits send_input to reopen a closed task. */
  parked: boolean;
};

type StartRequest = {
  readonly message: string;
  readonly toolCallId: string;
  readonly forkMessages?: ReadonlyArray<ProviderMessage> | undefined;
  readonly agentType?: string | undefined;
  readonly model?: string | undefined;
  readonly governance?: SubagentGovernance | undefined;
  readonly idleTimeoutMs?: number | undefined;
  readonly allowedTools?: ReadonlyArray<string> | undefined;
  readonly previous?: AgentEntry | undefined;
};

/** Owns bounded conversations and continuation identity; Runtime owns execution. */
export class ControlAgentSessions {
  private readonly agents = new Map<string, AgentEntry>();
  private readonly latest = new Map<string, AgentEntry>();
  private readonly finished: string[] = [];
  private readonly recovering = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: SubagentControlOptions) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void { for (const listener of this.listeners) listener(); }

  get(target: string): AgentEntry | undefined {
    const task = this.latest.get(target);
    if (task !== undefined) return task;
    const entry = this.agents.get(target);
    return entry === undefined ? undefined : this.latest.get(entry.taskId) ?? entry;
  }

  start(request: StartRequest): AgentEntry {
    const previous = request.previous;
    const parentTools = typeof this.options.allowedTools === "function" ? this.options.allowedTools() : this.options.allowedTools ?? ["read_file"];
    if (request.allowedTools?.some(name => !parentTools.includes(name))) {
      throw new SubagentGovernanceError("subagent_permission_denied", "allowed_tools contains tools unavailable to this parent");
    }
    const role = previous?.resolved ?? resolveRole(this.options.roles ?? [], request.agentType, {
      model: this.options.model, allowedTools: [...(request.allowedTools ?? parentTools)],
      maxIterations: this.options.childMaxIterations,
    });
    const resolved = request.model === undefined ? role : { ...role, model: request.model };
    const channel = createSubagentInputChannel();
    const priorBudget = previous?.observation.currentBudget();
    const roundOffset = previous === undefined ? 0 : previous.roundOffset + previous.observation.lastRound;
    const observation = new AgentRoundObservation(channel, previous?.observation.transcript, previous?.observation.cursor, priorBudget);
    const governance = priorBudget === undefined ? request.governance ?? { timeoutMode: "active" } : {
      timeoutMode: "active" as const,
      tokenBudget: request.governance?.tokenBudget ?? priorBudget.tokensRemaining,
      timeoutMs: request.governance?.timeoutMs ?? priorBudget.timeRemainingMs,
    };
    if (governance.tokenBudget !== undefined && governance.tokenBudget <= 0) {
      throw new SubagentGovernanceError("token_budget_exhausted", "Task budget exhausted; resume_agent can explicitly allocate token_budget");
    }
    if (priorBudget !== undefined && priorBudget.timeoutMs > 0 && governance.timeoutMs === 0) {
      throw new SubagentGovernanceError("subagent_timed_out", "Task execution time exhausted; resume_agent can explicitly allocate timeout_ms");
    }
    const idleTimeoutMs = request.idleTimeoutMs ?? previous?.idleTimeoutMs ?? DEFAULT_AGENT_IDLE_MS;
    const forkMessages = previous?.forkMessages ?? (request.forkMessages === undefined ? undefined : structuredClone(request.forkMessages));
    const worker = createInteractiveChildWorker({
      provider: this.options.provider, permission: this.options.permission,
      ...(this.options.execPolicy === undefined ? {} : { execPolicy: this.options.execPolicy }),
      ...(this.options.sandbox === undefined ? {} : { sandbox: this.options.sandbox }),
      ...(this.options.profile === undefined ? {} : { profile: this.options.profile }),
      message: resolved.role.prompt === undefined ? request.message : `${resolved.role.prompt}\n\nTask:\n${request.message}`,
      ...(resolved.maxIterations === undefined ? {} : { budget: { maxIterations: resolved.maxIterations } }),
      onRoundStarted: (round, prompt) => {
        observation.startRound(round);
        this.options.runtime.reportRound(handle.subagentId, { status: "running", round: roundOffset + round, prompt,
          ...(entry.nickname === entry.taskId ? {} : { displayName: entry.nickname }) });
      },
      onCheckpoint: transcript => { observation.checkpoint(transcript); },
      onRoundReady: report => {
        observation.publish(report);
        this.notify();
        this.options.runtime.reportRound(handle.subagentId, { status: "waiting", round: roundOffset + report.rounds, result: report.output });
      },
      idleTimeoutMs, onIdle: () => { entry.parked = true; },
      isParked: () => entry.parked,
      ...(this.options.scheduler === undefined ? {} : { scheduler: this.options.scheduler }),
      ...(forkMessages === undefined ? {} : { forkMessages }),
      ...(previous === undefined ? {} : { forkTranscript: previous.observation.transcript }),
      ...(resolved.model === undefined ? {} : { model: resolved.model }),
      ...(this.options.sessionId === undefined ? {} : { sessionId: this.options.sessionId }),
      ...(this.options.onEnvelope === undefined ? {} : { onEnvelope: this.options.onEnvelope }),
    });
    const handle = this.options.runtime.spawn<InteractiveChildResult>({ name: previous?.nickname ?? "subagent",
      budgetBefore: priorBudget,
      ...(previous === undefined ? {} : { continuation: { taskId: previous.taskId, resumedFrom: previous.agentId,
        roundOffset, ...(previous.nickname === previous.taskId ? {} : { displayName: previous.nickname }) } }),
      agentType: resolved.role.name, prompt: request.message,
      lineage: { parentAgentId: "main-agent", rootAttemptId: `att-root-${request.toolCallId}`, toolCallId: request.toolCallId },
      permissions: { allowedTools: [...resolved.allowedTools], inheritedGrants: this.options.grants }, governance, input: channel, worker });
    const taken = new Set([...this.agents.values()].map(other => other.nickname));
    const entry: AgentEntry = { agentId: handle.subagentId, taskId: previous?.taskId ?? handle.subagentId, roundOffset,
      nickname: previous?.nickname ?? uniqueNicknameFor(resolved.role, handle.subagentId, taken),
      instruction: previous?.instruction ?? request.message, channel, handle, observation, resolved,
      governance, idleTimeoutMs, forkMessages, parked: false };
    this.agents.set(entry.agentId, entry);
    this.latest.set(entry.taskId, entry);
    this.remember(entry);
    this.notify();
    return entry;
  }

  async resume(entry: AgentEntry, message: string | undefined, toolCallId: string, signal: AbortSignal,
    governance?: SubagentGovernance): Promise<AgentEntry | "cancelled"> {
    if (this.recovering.has(entry.taskId)) throw new SubagentGovernanceError("agent_recovery_in_progress", "This task already has a continuation pending");
    this.recovering.add(entry.taskId);
    try {
      const retired = await this.options.runtime.waitForRetirement(entry.agentId, AGENT_CLEANUP_WAIT_MS, signal);
      if (retired === "cancelled" || signal.aborted) return "cancelled";
      if (retired === "timeout") throw new SubagentGovernanceError("agent_stopping", "Worker cleanup is still pending; no replacement was started");
      entry.observation.accountSettled(await this.options.runtime.settled<InteractiveChildResult>(entry.agentId));
      if (signal.aborted) return "cancelled";
      return this.start({ previous: entry, toolCallId, governance,
        message: message ?? `Continue the assigned task using the recorded progress. Original assignment:\n${entry.instruction}\nCheck existing effects before repeating any action.` });
    } finally { this.recovering.delete(entry.taskId); }
  }

  park(entry: AgentEntry): void {
    if (entry.handle.status() !== "running" || !entry.channel.open) return;
    entry.parked = true;
    entry.channel.close();
  }

  private remember(entry: AgentEntry): void {
    void entry.handle.wait().then(result => {
      entry.channel.close();
      if (result.status !== "completed") entry.parked = false;
      entry.observation.finish(result);
      this.notify();
      void this.options.runtime.settled<InteractiveChildResult>(entry.agentId).then(settled => {
        entry.observation.accountSettled(settled);
        this.finished.push(entry.agentId);
        while (this.finished.length > SUBAGENT_HISTORY_LIMIT) {
          const oldest = this.finished.shift();
          if (oldest === undefined) break;
          const removed = this.agents.get(oldest);
          this.agents.delete(oldest);
          if (removed !== undefined && this.latest.get(removed.taskId) === removed) this.latest.delete(removed.taskId);
        }
        this.notify();
      });
    });
  }
}
