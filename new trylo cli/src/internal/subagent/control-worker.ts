import type { ToolSandbox } from "../ports/tools.js";
import type { TeamRepresentation } from "../protocol/team-representation.js";
import type { SubagentApprovalScope } from "./parent-approval.js";
import type { SubagentInput } from "./input-channel.js";
import type { AgentEntry, SubagentControlOptions } from "./control-session.js";
import type { TeamRepresentationControl } from "./team-representation-control.js";
import { saveAgentCheckpoint, type AgentContinuation } from "./control-checkpoint.js";
import { createInteractiveChildWorker } from "./interactive-worker.js";
import type { CollaborationRound } from "./collaboration.js";
import { dispatchToolPort } from "./dispatch-tool-port.js";

type WorkerPlan = Pick<AgentEntry, "resolved" | "observation" | "roundOffset" | "idleTimeoutMs" | "forkMessages" | "providerSession"> & {
  readonly teamMember: AgentEntry["teamMember"];
  readonly message: string;
  readonly previous?: AgentContinuation | undefined;
  readonly receipt?: SubagentInput["receipt"];
  readonly handoff?: SubagentInput["handoff"] | undefined;
  readonly approvalScope: SubagentApprovalScope | undefined;
  readonly sandbox: ToolSandbox | undefined;
};

/** Conversation hooks translate facts; Runtime remains the execution owner. */
export function createControlChildWorker(options: SubagentControlOptions, plan: WorkerPlan,
  entry: () => AgentEntry, representation: TeamRepresentationControl, isCurrent: () => boolean, notify: () => void): ReturnType<typeof createInteractiveChildWorker> {
  const { resolved, observation, teamMember, roundOffset, idleTimeoutMs, forkMessages, providerSession, approvalScope, sandbox, previous } = plan;
  let collaborationRound: CollaborationRound | undefined;
  let currentDelivery = plan.receipt;
  const worker = createInteractiveChildWorker({
    ...(options.routing === undefined ? {} : {
      onRequestUsage: (requestId: string) => { entry().routingObserver?.usageReported(requestId); },
    }),
    ...(options.routing === undefined && options.onChildRequestDispatched === undefined ? {} : {
      onRequestDispatched: async (round: number, requestId: string, request: import("../ports/provider.js").ProviderRequest) => {
        const current = entry();

        await current.routingObserver?.dispatched({ taskId: current.taskId, agentId: current.agentId,
          round: roundOffset + round }, requestId);

        if (current.handle.status() !== "running" || !isCurrent()) return;

        const lineage = current.handle.lineage;

        await options.onChildRequestDispatched?.({ request, taskId: current.taskId, agentId: current.agentId,
          round: roundOffset + round, rootAttemptId: lineage.rootAttemptId,
          ...(lineage.toolCallId === undefined ? {} : { parentToolCallId: lineage.toolCallId }),
          ...(current.teamMember === undefined ? {} : { teamMember: current.teamMember }) });
      },
    }),
    ...(approvalScope === undefined ? {} : { approvalScope }),
    provider: options.provider, permission: options.permission,
    providerSession,
    ...(plan.receipt === undefined ? {} : { initialSubmission: plan.receipt }),
    ...(plan.handoff === undefined ? {} : { initialHandoff: plan.handoff }),
    ...(options.onMemberCollaborationReport === undefined && options.collaboration?.report === undefined ? {} : {
      onCollaborationReport: async (report: import("../protocol/member-collaboration-report.js").MemberCollaborationReport, requestId?: string, requestSequence?: number) => {
        if (entry().handle.status() !== "running" || !isCurrent()) return;
        await options.onMemberCollaborationReport?.({ executionId: entry().agentId, taskId: entry().taskId,
          round: roundOffset + observation.lastRound, role: resolved.role.name,
          ...(requestId === undefined ? {} : { requestId }), ...(requestSequence === undefined ? {} : { requestSequence }),
          ...(teamMember === undefined ? {} : { teamRunId: teamMember.teamRunId, memberId: teamMember.memberId }) }, structuredClone(report));
        if (collaborationRound !== undefined) await options.collaboration?.report?.(collaborationRound, structuredClone(report));
      },
    }),
    ...(teamMember === undefined || options.collaboration === undefined ? {} : {
      prepareRound: async (round: number, assignment: string, handoff: SubagentInput["handoff"], signal: AbortSignal,
        dependencies?: readonly string[]) => {
        if (signal.aborted || !isCurrent()) return undefined;

        collaborationRound = { ...teamMember, executionId: entry().agentId, taskId: entry().taskId, role: resolved.role.name,
          roleDescription: resolved.role.description,
          ...(entry().configuration === undefined ? {} : { configuration: entry().configuration }),
          round: roundOffset + round, dependencies: dependencies ?? entry().dependencies, assignment,
          ...(currentDelivery === undefined ? {} : { delivery: currentDelivery }),
          ...(handoff === undefined ? {} : { handoff }) };
        const guidance = await options.collaboration!.prepare(collaborationRound, signal);

        return signal.aborted || !isCurrent() ? undefined : guidance;
      },
      onRoundDispatched: async (_round: number, requestId: string, guidance: string | undefined) => {
        if (collaborationRound !== undefined) await options.collaboration!.dispatched(collaborationRound, requestId, guidance);
      },
    }),
    ...(options.callerMessages === undefined ? {} : { callerMessages: options.callerMessages }),
    ...(options.execPolicy === undefined ? {} : { execPolicy: options.execPolicy }),
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(options.profile === undefined ? {} : { profile: options.profile }),
    message: resolved.role.prompt === undefined ? plan.message : `${resolved.role.prompt}\n\nTask:\n${plan.message}`,
    budget: { ...options.childBudget, ...(resolved.maxIterations === undefined ? {} : { maxIterations: resolved.maxIterations }) },
    onRoundStarted: async (round, prompt, receipt) => {
      currentDelivery = receipt;

      if (resolved.role.name === "person") representation.inputQueued(resolved.role.name, entry().teamMember?.memberId ?? entry().taskId);

      observation.startRound(round);
      await saveAgentCheckpoint(options, entry(), "interrupted", round);

      if (receipt !== undefined) observation.recordDelivery({ ...receipt, round: roundOffset + round, state: "started" });

      options.runtime.reportRound(entry().agentId, { status: "running", round: roundOffset + round, prompt,
        ...(receipt === undefined ? {} : { delivery: observation.delivery }),
        ...(entry().nickname === entry().taskId ? {} : { displayName: entry().nickname }) });
    },
    onCheckpoint: async (transcript, window, phase, round) => {
      observation.checkpoint(transcript, window);
      await saveAgentCheckpoint(options, entry(), phase, round);
    },
    ...(teamMember !== undefined && resolved.role.name === "person" && options.team?.inspectRepresentation !== undefined ? {
      onRepresentation: async (value: TeamRepresentation, round: number) => {
        if (entry().handle.status() !== "running" || !isCurrent() || entry().channel.requestedRound !== round) return false;
        await representation.submit(teamMember.memberId, value);
        return true;
      },
      formatOutput: (_round: number, output: string) => representation.formatOutput("person", teamMember.memberId, output),
    } : {}),
    onProgressReport: report => {
      if (entry().handle.status() !== "running" || !isCurrent()) return;
      if (observation.publishProgress({ ...report, round: roundOffset + report.round })) notify();
    },
    onRoundReady: async report => {
      if (collaborationRound !== undefined && entry().handle.status() === "running" && isCurrent()) {
        if (report.envelopes.some(event => event.kind === "usage" && event.turnId === `trn-sub-${entry().agentId}-r${report.rounds}`)) {
          await options.collaboration?.accountUsage?.(collaborationRound, report.usage);
        }
        await options.collaboration?.completed(collaborationRound, report.output);
      }

      const delivery = observation.delivery;
      if (delivery?.round === roundOffset + report.rounds && delivery.state === "started") {
        observation.recordDelivery({ ...delivery, state: "answered" });
      }

      // The mailbox owns which input still needs representation. A prior
      // answer, or an execution already cancelled by restart, cannot clear it.
      if (entry().handle.status() === "running" && report.rounds >= entry().channel.requestedRound) {
        await representation.observe(resolved.role.name, report.output, entry().teamMember?.memberId ?? entry().taskId);
      }

      observation.publish(report);
      notify();
      options.runtime.reportRound(entry().agentId, { status: "waiting", round: roundOffset + report.rounds, result: report.output,
        ...(delivery?.round === roundOffset + report.rounds ? { delivery: observation.delivery } : {}) });
    },
    idleTimeoutMs, onIdle: () => { entry().parked = true; },
    isParked: () => entry().parked,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    ...(forkMessages === undefined ? {} : { forkMessages }),
    ...(previous === undefined ? {} : { forkTranscript: previous.observation.transcript }),
    ...(previous?.observation.promptView === undefined ? {} : { forkWindow: previous.observation.promptView }),
    ...(resolved.model === undefined ? {} : { model: resolved.model }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.onEnvelope === undefined ? {} : { onEnvelope: options.onEnvelope }),
    ...(options.collaboration?.capture === undefined ? {} : { onExecutionEnvelope: (event: import("../protocol/envelope.js").Envelope) => {
      if (collaborationRound !== undefined) void options.collaboration?.capture?.(collaborationRound, event);
    } }),
  });

  return context => worker(entry().dispatchTools === undefined ? context
    : { ...context, tools: dispatchToolPort(context.tools, entry().dispatchTools!) });
}
