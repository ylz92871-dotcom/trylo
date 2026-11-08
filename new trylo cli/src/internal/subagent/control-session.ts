import type { ProfilePort } from "../contract/profile.js";
import type { PermissionPort } from "../ports/permission.js";
import type { ProviderMessage, ProviderPort } from "../ports/provider.js";
import type { SandboxVerdict, ToolCallRequest, ToolPort, ToolSandbox } from "../ports/tools.js";
import { AgentRoundObservation } from "./control-observation.js";
import { createSubagentInputChannel, type SubagentInput, type SubagentInputChannel } from "./input-channel.js";
import type { InteractiveChildResult } from "./interactive-worker.js";
import { uniqueNicknameFor, type ResolvedRole, type SubagentRole } from "./role.js";
import { SUBAGENT_HISTORY_LIMIT, type SubagentRuntime } from "./runtime.js";
import type { SubagentGovernance, SubagentHandle } from "./types.js";
import type { TimerScheduler } from "./scheduler.js";
import { SubagentGovernanceError } from "./governance.js";
import type { PermissionGrantCache } from "../loop/permission-grants.js";
import type { LoopPorts } from "../loop/runner.js";
import type { Message } from "../contract/execution.js";
import type { IterationBudget } from "../domain/iteration.js";
import { createChildProviderSession, type ChildProviderSession } from "./child-provider-session.js";
import { selectTeamMember, type SubagentTeam, type TeamMemberIdentity } from "./team.js";
import { TaskResourceStop, type SubagentTaskResources } from "./task-resources.js";
import { TeamRepresentationControl } from "./team-representation-control.js";
import { createSubagentApprovalScope, type ParentActionApproval } from "./parent-approval.js";
import { constrainSubagentSandbox } from "./inherited-authority.js";
import type { SubagentCheckpointPort } from "./checkpoint.js";
import type { AgentContinuation } from "./control-checkpoint.js";

import { createControlChildWorker } from "./control-worker.js";
import { listRecoveredTasks, restoreAgent } from "./control-recovery.js";
import { guardCollaborationPort, type CollaborationObserverPhase } from "./collaboration.js";
import type { SubagentRoutingPort, SubagentRoutingReceipt } from "../ports/subagent-routing.js";
import { createSubagentRoutingObserver, type SubagentRoutingObserver } from "./routing.js";
import { resolveDispatchRole, configurationForSpawn, reconfigureMemberAtHandoff, type AdmittedMemberConfiguration,
  type SubagentMemberConfigurationMetadata, type SubagentMemberConfigurationPort } from "./member-configuration.js";
import type { SubagentHandoff } from "../protocol/subagent-handoff.js";

export const DEFAULT_AGENT_IDLE_MS = 30_000;
export const AGENT_CLEANUP_WAIT_MS = 5_000;

export type SubagentControlOptions = {
  /** Host-admitted provider+model migration, never model-selected authority. */
  readonly modelMigration?: string;
  readonly onChildRequestDispatched?: import("./request-dispatched.js").ChildRequestDispatchedObserver;
  readonly memberConfigurations?: SubagentMemberConfigurationPort;
  readonly teamProfileId?: string;
  readonly onMemberCollaborationReport?: import("../protocol/member-collaboration-report.js").MemberCollaborationReportObserver;
  readonly routing?: SubagentRoutingPort;
  readonly routingNow?: () => number;
  readonly collaboration?: import("./collaboration.js").SubagentCollaborationPort;
  readonly onCollaborationFailure?: (phase: CollaborationObserverPhase) => void;
  readonly checkpoints?: SubagentCheckpointPort;
  readonly parentApproval?: ParentActionApproval;
  readonly taskResources?: SubagentTaskResources;
  /** The task owner retains these reducers across rounds and recovery. */
  readonly createLocalTools?: () => ToolPort;
  readonly team?: SubagentTeam;
  readonly runtime: SubagentRuntime;
  readonly provider: ProviderPort;
  readonly callerMessages?: ReadonlyArray<Message>;
  readonly childBudget?: IterationBudget;
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
  readonly dispatchTools?: ToolPort;
  readonly configuration?: SubagentMemberConfigurationMetadata;
  readonly routing?: SubagentRoutingReceipt;
  readonly routingObserver?: SubagentRoutingObserver;
  readonly dependencies: readonly string[];
  readonly resourceStop: TaskResourceStop;
  readonly localTools?: ToolPort;
  readonly teamMember?: TeamMemberIdentity;
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
  readonly providerSession: ChildProviderSession;
  /** Only automatic parking permits send_input to reopen a closed task. */
  parked: boolean;
};

export type StartRequest = {
  readonly configuration?: AdmittedMemberConfiguration;
  readonly routing?: SubagentRoutingReceipt;
  readonly routingDiagnostics?: readonly string[];
  readonly handoff?: import("../protocol/subagent-handoff.js").SubagentHandoff | undefined;
  readonly dependencies?: readonly string[] | undefined;
  readonly receipt?: SubagentInput["receipt"];
  readonly memberId?: string | undefined;
  readonly message: string;
  readonly toolCallId: string;
  readonly forkMessages?: ReadonlyArray<ProviderMessage> | undefined;
  readonly agentType?: string | undefined;
  readonly model?: string | undefined;
  readonly governance?: SubagentGovernance | undefined;
  readonly idleTimeoutMs?: number | undefined;
  readonly allowedTools?: ReadonlyArray<string> | undefined;
  readonly previous?: AgentContinuation | undefined;
};

/** Owns bounded conversations and continuation identity; Runtime owns execution. */
export class ControlAgentSessions {
  private readonly agents = new Map<string, AgentEntry>();
  private readonly latest = new Map<string, AgentEntry>();
  private readonly finished: string[] = [];
  private readonly recovering = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly representation: TeamRepresentationControl;

  constructor(private readonly options: SubagentControlOptions) {
    this.options = options.collaboration === undefined ? options : { ...options,
      collaboration: guardCollaborationPort(options.collaboration, options.onCollaborationFailure, options.scheduler) };
    this.representation = new TeamRepresentationControl(options.team?.inspectRepresentation,
      () => [...this.latest.values()].filter(entry => entry.teamMember && entry.resolved.role.name === "worker")
        .map(entry => ({ resourceStop: entry.resourceStop, stop: (reason: string) => this.stop(entry, reason) })),
      () => { this.notify(); }, options.team?.members.filter(member => member.baseRole === "person").map(member => member.memberId));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private notify(): void { for (const listener of this.listeners) listener(); }

  get(target: string): AgentEntry | undefined {
    const task = this.latest.get(target);
    if (task !== undefined) return task;
    const entry = this.agents.get(target);
    if (entry !== undefined) return this.latest.get(entry.taskId) ?? entry;
    const saved = this.options.checkpoints?.read(target);
    return saved?.kind === "ready" ? this.latest.get(saved.checkpoint.taskId) : undefined;
  }

  listRecoverable(): import("../protocol/envelope.js").JsonObject[] {
    return listRecoveredTasks(this.options, this.latest);
  }

  listLive(): import("../protocol/envelope.js").JsonObject[] {
    return [...this.latest.values()].map(entry => ({ task_id: entry.taskId, agent_id: entry.agentId,
      nickname: entry.nickname.slice(0, 160), status: entry.handle.status(), role: entry.resolved.role.name.slice(0, 128),
      round: entry.roundOffset + entry.observation.lastRound }));
  }

  async restore(target: string, message: string | undefined, toolCallId: string, signal: AbortSignal,
    governance?: SubagentGovernance): Promise<AgentEntry | "cancelled"> {
    return restoreAgent(this.options, { target, message, toolCallId, signal, governance,
      latest: this.latest, recovering: this.recovering, start: request => this.start(request) });
  }

  assertInputAllowed(entry: AgentEntry): void {
    if (this.recovering.has(entry.taskId)) throw new SubagentGovernanceError("agent_recovery_in_progress", "The task is at a dispatch or configuration boundary");
    entry.resourceStop.assertReady();
    this.assertImplementationAllowed(entry.resolved.role.name);
  }

  inputQueued(entry: AgentEntry): void {
    this.representation.inputQueued(entry.resolved.role.name, entry.teamMember?.memberId ?? entry.taskId);
  }

  assertDependencies(targets: readonly string[] = [], self?: string): readonly string[] {
    return targets.map(target => {
      const entry = this.get(target);
      if (entry === undefined) throw new SubagentGovernanceError("agent_dependency_unknown", `Unknown dependency '${target}'`);

      if (entry.taskId === self) throw new SubagentGovernanceError("agent_dependency_cycle", "A task cannot depend on itself");

      if (["failed", "cancelled", "timed_out"].includes(entry.handle.status())) {
        throw new SubagentGovernanceError("agent_dependency_failed", `Dependency '${entry.taskId}' did not finish successfully`);
      }

      if (!entry.observation.isReady()) throw new SubagentGovernanceError("agent_dependency_pending", `Wait for dependency '${entry.taskId}' before dispatching this work`);

      return entry.taskId;
    });
  }

  private assertImplementationAllowed(role: string): void {
    const failure = this.representation.failure(role);
    if (failure !== undefined) throw failure;
  }

  private constrainMemberTool(role: string, memberId: string, call: ToolCallRequest): SandboxVerdict {
    const failure = this.representation.failure(role);
    if (failure !== undefined) return { ok: false, code: failure.code, message: failure.message };
    const policy = this.options.execPolicy?.(call);
    if (policy?.kind === "denied") return { ok: false, code: policy.code, message: policy.message };
    return this.options.team?.constrainTool?.(memberId, call) ?? { ok: true };
  }

  async configurationForSpawn(reference: string, request: { readonly message: string; readonly agentType?: string | undefined; readonly memberId?: string | undefined }, signal: AbortSignal) {
    const occupied = new Set([...this.latest.values()].flatMap(entry => entry.teamMember === undefined ? [] : [entry.teamMember.memberId]));
    return configurationForSpawn(this.options, occupied, reference, request, signal);
  }

  async reconfigure(entry: AgentEntry, reference: string, message: string, handoff: SubagentHandoff, toolCallId: string,
    signal: AbortSignal, governance?: SubagentGovernance): Promise<AgentEntry | "cancelled" | { readonly kind: "waiting" | "unavailable"; readonly reason: string }> {
    if (this.recovering.has(entry.taskId)) return { kind: "waiting", reason: "agent_recovery_in_progress" };
    this.recovering.add(entry.taskId);
    try {
      return await reconfigureMemberAtHandoff({ options: this.options, entry, reference, message, handoff, toolCallId, signal, governance,
        isCurrent: () => this.get(entry.taskId) === entry, start: request => this.start(request) });
    } finally { this.recovering.delete(entry.taskId); }
  }

  start(request: StartRequest): AgentEntry {
    const previous = request.previous;
    // Reconfiguration starts a fresh context; the predecessor's choice cannot describe its dispatch.
    const routing = request.configuration === undefined ? previous?.routing ?? request.routing : request.routing;
    const routingObserver = routing === undefined || this.options.routing === undefined ? undefined : createSubagentRoutingObserver({
      port: this.options.routing, receipt: routing, executionId: request.toolCallId,
      ...(request.routingDiagnostics === undefined ? {} : { diagnostics: request.routingDiagnostics }),
      ...(this.options.routingNow === undefined ? {} : { now: this.options.routingNow }),
      ...(this.options.scheduler === undefined ? {} : { scheduler: this.options.scheduler }),
    });
    const dependencies = this.assertDependencies(request.dependencies ?? previous?.dependencies, previous?.taskId);

    previous?.resourceStop.assertReady();

    if (previous === undefined && [...this.latest.values()].filter(entry => entry.resourceStop.isHeld()).length >= SUBAGENT_HISTORY_LIMIT) {
      throw new SubagentGovernanceError("agent_cleanup_capacity", "Resolve retained task cleanup failures before starting another task");
    }

    const occupied = new Set([...this.latest.values()].flatMap(entry =>
      entry.teamMember === undefined ? [] : [entry.teamMember.memberId]));
    const member = previous === undefined
      ? selectTeamMember(this.options.team, request.agentType, request.memberId, occupied) : undefined;
    const teamMember = previous?.teamMember ?? (member === undefined ? undefined
      : { teamRunId: this.options.team!.runId, memberId: member.memberId });
    const parentTools = typeof this.options.allowedTools === "function" ? this.options.allowedTools() : this.options.allowedTools ?? ["read_file"];
    const resolved = resolveDispatchRole(this.options, request, member, parentTools);

    this.assertImplementationAllowed(resolved.role.name);
    const channel = createSubagentInputChannel();
    const priorBudget = previous?.observation.currentBudget();
    const roundOffset = previous === undefined ? 0 : previous.roundOffset + previous.observation.lastRound;
    const observation = new AgentRoundObservation(channel, request.configuration === undefined ? previous?.observation.transcript : [], previous?.observation.cursor, priorBudget,
      previous?.observation.reportHistory);
    const governance = priorBudget === undefined ? request.governance ?? { timeoutMode: "active" } : {
      timeoutMode: "active" as const,
      tokenBudget: request.governance?.tokenBudget ?? priorBudget.tokensRemaining,
      timeoutMs: request.governance?.timeoutMs ?? priorBudget.timeRemainingMs,
    };
    if (governance.tokenBudget !== undefined && governance.tokenBudget <= 0) {
      throw new SubagentGovernanceError("token_budget_exhausted", "Task budget exhausted; resume_agent can explicitly allocate token_budget");
    }

    if (priorBudget?.timeoutMs !== undefined && priorBudget.timeoutMs > 0 && governance.timeoutMs === 0) {
      throw new SubagentGovernanceError("subagent_timed_out", "Task execution time exhausted; resume_agent can explicitly allocate timeout_ms");
    }

    const idleTimeoutMs = request.idleTimeoutMs ?? previous?.idleTimeoutMs ?? DEFAULT_AGENT_IDLE_MS;
    const forkMessages = request.configuration === undefined ? previous?.forkMessages ?? (request.forkMessages === undefined ? undefined : structuredClone(request.forkMessages))
      : request.forkMessages === undefined ? undefined : structuredClone(request.forkMessages);
    const localTools = request.configuration === undefined ? previous?.localTools ?? this.options.createLocalTools?.() : this.options.createLocalTools?.();
    const providerSession = request.configuration === undefined ? previous?.providerSession ?? createChildProviderSession(this.options.provider, forkMessages, resolved.model)
      : createChildProviderSession(this.options.provider, forkMessages, resolved.model);
    const parentApproval = this.options.parentApproval;
    const approvalScope = parentApproval === undefined || teamMember === undefined ? undefined : createSubagentApprovalScope({
      parent: parentApproval, permission: this.options.permission, grants: this.options.grants, execPolicy: this.options.execPolicy,
      constrain: call => this.constrainMemberTool(resolved.role.name, teamMember.memberId, call),
      requester: context => ({ kind: "subagent", executionId: context.subagentId, taskId: previous?.taskId ?? context.subagentId,
        teamRunId: teamMember.teamRunId, memberId: teamMember.memberId,
        displayName: previous?.nickname ?? member?.displayName ?? resolved.role.name, role: resolved.role.name }),
      onCancelled: () => {
        void this.stop(entry, "parent_approval_cancelled").catch(error => {
          if (!(error instanceof SubagentGovernanceError) || error.code !== "agent_cleanup_failed") throw error;
          // The task retains the native failure and blocks further implementation.
          this.notify();
        });
      },
    });
    const sandbox = teamMember === undefined ? this.options.sandbox : constrainSubagentSandbox(this.options.sandbox,
      call => this.constrainMemberTool(resolved.role.name, teamMember.memberId, call));
    const worker = createControlChildWorker(this.options, { resolved, observation, teamMember, roundOffset, idleTimeoutMs,
      forkMessages, providerSession, approvalScope, sandbox, previous: request.configuration === undefined ? previous : undefined,
      message: request.message, receipt: request.receipt,
      handoff: request.handoff },
    () => entry, this.representation, () => this.latest.get(entry.taskId) === entry, () => this.notify());
    const handle = this.options.runtime.spawn<InteractiveChildResult>({ name: previous?.nickname ?? "subagent",
      ...(localTools === undefined ? {} : { localTools }),
      ...(teamMember === undefined ? {} : { teamMember }),
      budgetBefore: priorBudget,
      ...(previous === undefined ? {} : { continuation: { taskId: previous.taskId, resumedFrom: previous.agentId,
        roundOffset, ...(previous.nickname === previous.taskId ? {} : { displayName: previous.nickname }) } }),
      agentType: resolved.role.name, prompt: request.message,
      lineage: { parentAgentId: "main-agent", rootAttemptId: `att-root-${request.toolCallId}`, toolCallId: request.toolCallId },
      permissions: { allowedTools: [...resolved.allowedTools], inheritedGrants: this.options.grants,
        ...(approvalScope === undefined ? {} : { approvedAction: { consume: call => approvalScope.consume(call) } }),
        ...(this.options.sandbox?.requiresApproval === undefined ? {} : { requiresApproval: call => this.options.sandbox?.requiresApproval?.(call) === true }),
        ...(this.options.permission.isDenied === undefined ? {} : { inheritedDenial: name => this.options.permission.isDenied?.(name) === true }),
        ...(teamMember === undefined ? {} : { constrainTool: call => this.constrainMemberTool(resolved.role.name, teamMember.memberId, call) }),
        ...(this.options.permission.inheritance === undefined ? {} : { inheritedPolicy: this.options.permission.inheritance }) }, governance, input: channel, worker });
    const taken = new Set([...this.agents.values()].map(other => other.nickname));
    const dispatchTools = request.configuration === undefined ? previous?.dispatchTools : request.configuration.dispatchTools;
    const entry: AgentEntry = { agentId: handle.subagentId, taskId: previous?.taskId ?? handle.subagentId, roundOffset,
      ...(dispatchTools === undefined ? {} : { dispatchTools }),
      ...(request.configuration === undefined ? previous?.configuration === undefined ? {} : { configuration: previous.configuration }
        : { configuration: request.configuration.metadata }),
      ...(routing === undefined ? {} : { routing }), ...(routingObserver === undefined ? {} : { routingObserver }),
      resourceStop: previous?.resourceStop ?? new TaskResourceStop(),
      ...(localTools === undefined ? {} : { localTools }),
      ...(teamMember === undefined ? {} : { teamMember }),
      nickname: previous?.nickname ?? member?.displayName ?? uniqueNicknameFor(resolved.role, handle.subagentId, taken),
      instruction: request.configuration === undefined ? previous?.instruction ?? request.message : request.message, channel, handle, observation, resolved, dependencies,
      governance, idleTimeoutMs, forkMessages, providerSession, parked: false };

    this.inputQueued(entry);
    this.agents.set(entry.agentId, entry);
    this.latest.set(entry.taskId, entry);
    this.remember(entry);
    this.notify();

    return entry;
  }

  async resume(entry: AgentEntry, message: string | undefined, toolCallId: string, signal: AbortSignal,
    options?: { readonly governance?: SubagentGovernance | undefined; readonly receipt?: SubagentInput["receipt"];
      readonly handoff?: SubagentInput["handoff"]; readonly dependencies?: readonly string[] }): Promise<AgentEntry | "cancelled"> {
    entry.resourceStop.assertReady();

    if (this.recovering.has(entry.taskId)) throw new SubagentGovernanceError("agent_recovery_in_progress", "This task already has a continuation pending");

    this.recovering.add(entry.taskId);

    try {
      this.inputQueued(entry);
      const retired = await this.options.runtime.waitForRetirement(entry.agentId, AGENT_CLEANUP_WAIT_MS, signal);
      if (retired === "cancelled" || signal.aborted) return "cancelled";

      if (retired === "timeout") throw new SubagentGovernanceError("agent_stopping", "Worker cleanup is still pending; no replacement was started");

      entry.observation.accountSettled(await this.options.runtime.settled<InteractiveChildResult>(entry.agentId));

      if (signal.aborted) return "cancelled";

      return this.start({ previous: entry, toolCallId, governance: options?.governance, receipt: options?.receipt, handoff: options?.handoff,
        ...(options?.dependencies === undefined ? {} : { dependencies: options.dependencies }),
        message: message ?? `Continue the assigned task using the recorded progress. Original assignment:\n${entry.instruction}\nCheck existing effects before repeating any action.` });
    } finally { this.recovering.delete(entry.taskId); }
  }

  park(entry: AgentEntry): void {
    if (entry.handle.status() !== "running" || !entry.channel.open) return;
    entry.parked = true;
    entry.channel.close();
  }

  stop(entry: AgentEntry, reason: string): Promise<void> {
    entry.parked = false;
    entry.channel.close();

    return entry.resourceStop.stop(async () => {
      await this.options.runtime.cancel(entry.agentId, reason);
      const [retired] = await Promise.all([
        this.options.runtime.waitForRetirement(entry.agentId, AGENT_CLEANUP_WAIT_MS, new AbortController().signal),
        this.options.taskResources?.stop(entry.taskId),
      ]);
      if (retired !== "ready") throw new Error("Worker cleanup is still pending; no replacement was started");
    });
  }

  private remember(entry: AgentEntry): void {
    void entry.handle.wait().then(result => {
      entry.channel.close();

      if (result.status !== "completed") entry.parked = false;

      entry.observation.finish(result);
      this.notify();

      // Publishing execution and retiring its resources never await an optional observer.
      // The constructor's guard owns rejection handling, including a broken diagnostic sink.
      if (entry.teamMember !== undefined) void this.options.collaboration?.ended({ ...entry.teamMember,
        executionId: entry.agentId, taskId: entry.taskId, round: entry.roundOffset + entry.observation.lastRound }, result.status, result.error?.code);

      void this.options.runtime.settled<InteractiveChildResult>(entry.agentId).then(settled => {
        entry.observation.accountSettled(settled);
        void entry.routingObserver?.finished({ taskId: entry.taskId, agentId: entry.agentId,
          round: entry.roundOffset + entry.observation.lastRound }, settled).then(() => { this.notify(); });
        this.finished.push(entry.agentId);

        while (this.finished.length > SUBAGENT_HISTORY_LIMIT) {
          const index = this.finished.findIndex(id => {
            const candidate = this.agents.get(id);
            return candidate === undefined || this.latest.get(candidate.taskId) !== candidate || !candidate.resourceStop.isHeld();
          });
          if (index === -1) break;

          const [oldest] = this.finished.splice(index, 1);

          if (oldest === undefined) break;

          const removed = this.agents.get(oldest);

          this.agents.delete(oldest);

          if (removed !== undefined && this.latest.get(removed.taskId) === removed) {
            this.latest.delete(removed.taskId);
            removed.providerSession.close();
          }
        }

        this.notify();
      });
    });
  }
}
