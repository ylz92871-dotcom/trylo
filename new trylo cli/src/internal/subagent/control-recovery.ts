import type { JsonObject } from "../protocol/envelope.js";
import { checkpointContinuation, type AgentContinuation } from "./control-checkpoint.js";
import { SubagentGovernanceError } from "./governance.js";
import type { AgentEntry, SubagentControlOptions, StartRequest } from "./control-session.js";

export function listRecoveredTasks(options: SubagentControlOptions, latest: ReadonlyMap<string, AgentEntry>): JsonObject[] {
  return (options.checkpoints?.list() ?? []).flatMap(item => {
    const taskId = item.kind === "ready" ? item.checkpoint.taskId : item.taskId;
    if (latest.has(taskId)) return [];
    return [item.kind === "invalid" ? { task_id: taskId, recovery: "invalid", message: item.message }
      : { task_id: taskId, agent_id: item.checkpoint.agentId, nickname: item.checkpoint.nickname.slice(0, 160),
        role: item.checkpoint.role, round: item.checkpoint.round,
        recovery: item.checkpoint.contextUnavailable ? "context_unavailable" : item.checkpoint.phase,
        ...(item.checkpoint.teamMember === undefined ? {} : { team_run_id: item.checkpoint.teamMember.teamRunId, member_id: item.checkpoint.teamMember.memberId }) }];
  });
}

/** Cold recovery prepares data; only ControlAgentSessions.start admits a real execution. */
export async function restoreAgent(options: SubagentControlOptions, request: {
  readonly target: string; readonly message: string | undefined; readonly toolCallId: string; readonly signal: AbortSignal;
  readonly governance: StartRequest["governance"];
  readonly latest: ReadonlyMap<string, AgentEntry>; readonly recovering: Set<string>;
  readonly start: (request: StartRequest) => AgentEntry;
}): Promise<AgentEntry | "cancelled"> {
  const saved = options.checkpoints?.read(request.target);
  if (saved === undefined || saved.kind === "missing") throw new SubagentGovernanceError("unknown_agent", `No live task or durable checkpoint with id '${request.target}'`);
  if (saved.kind === "invalid") throw new SubagentGovernanceError("agent_checkpoint_invalid", saved.message);
  const checkpoint = saved.checkpoint;
  if (checkpoint.phase === "interrupted" && request.message === undefined) {
    throw new SubagentGovernanceError("agent_recovery_instruction_required", "Interrupted work may have unrecorded effects. Inspect the task's files and external effects, then provide an explicit continuation message; no action was replayed");
  }
  if (checkpoint.phase === "interrupted" && (request.governance?.tokenBudget === undefined || request.governance.timeoutMs === undefined)) {
    throw new SubagentGovernanceError("agent_recovery_budget_required", "Usage after the interrupted boundary is unknown. Explicitly allocate token_budget and timeout_ms for recovery; the saved allowance was not silently reused");
  }
  if (request.recovering.has(checkpoint.taskId)) throw new SubagentGovernanceError("agent_recovery_in_progress", "This task already has a continuation pending");
  if ([...request.latest.values()].some(entry => checkpoint.teamMember !== undefined && entry.teamMember?.memberId === checkpoint.teamMember.memberId)) {
    throw new SubagentGovernanceError("team_member_busy", "This frozen member already has a live task");
  }
  request.recovering.add(checkpoint.taskId);
  let previous: AgentContinuation | undefined;
  try {
    previous = checkpointContinuation(options, checkpoint);
    await previous.resourceStop.stop(async () => { await options.taskResources?.stop(checkpoint.taskId); });
    if (request.signal.aborted) return "cancelled";
    return request.start({ previous, toolCallId: request.toolCallId, governance: request.governance, message: [
      "Continue from a durable canonical checkpoint using a fresh execution. In-flight provider state, pending input and approval grants were not restored.",
      "Verify existing files and external effects before repeating any action; the previous execution may have done work after its last checkpoint.",
      request.message ?? `Continue the assigned task. Original assignment:\n${checkpoint.instruction}`,
    ].join("\n") });
  } finally {
    if (previous !== undefined && !request.latest.has(checkpoint.taskId)) previous.providerSession.close();
    request.recovering.delete(checkpoint.taskId);
  }
}
