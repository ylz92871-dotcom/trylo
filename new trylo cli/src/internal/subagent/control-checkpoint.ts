import { AgentRoundObservation } from "./control-observation.js";
import { createSubagentInputChannel } from "./input-channel.js";
import { createChildProviderSession } from "./child-provider-session.js";
import { roleBinding, portableFork, type SubagentCheckpoint } from "./checkpoint.js";
import type { AgentEntry, SubagentControlOptions } from "./control-session.js";
import { SubagentGovernanceError } from "./governance.js";
import { resolveRole } from "./role.js";
import { TaskResourceStop } from "./task-resources.js";

/** Continuation data contains no Runtime handle and cannot pretend an old execution is alive. */
export type AgentContinuation = Pick<AgentEntry, "dependencies" | "resourceStop" | "localTools" | "teamMember" | "agentId" | "taskId"
  | "roundOffset" | "nickname" | "instruction" | "observation" | "resolved" | "idleTimeoutMs" | "forkMessages" | "providerSession">;

export function checkpointContinuation(options: SubagentControlOptions, checkpoint: SubagentCheckpoint): AgentContinuation {
  const member = options.team?.members.find(candidate => candidate.memberId === checkpoint.teamMember?.memberId);
  if (checkpoint.teamMember !== undefined ? options.team?.runId !== checkpoint.teamMember.teamRunId || member === undefined
    : options.team !== undefined) throw new SubagentGovernanceError("agent_recovery_profile_mismatch", "The saved task does not belong to this frozen team");
  if (member !== undefined && options.team?.heldRoles?.includes(member.baseRole)) {
    throw new SubagentGovernanceError("team_role_held", "This role is held pending clarification");
  }
  const parentTools = typeof options.allowedTools === "function" ? options.allowedTools() : options.allowedTools ?? ["read_file"];
  const resolved = resolveRole(member === undefined ? options.roles ?? [] : [member.role], member?.role.name ?? checkpoint.role,
    { model: options.model, allowedTools: parentTools.filter(tool => checkpoint.allowedTools.includes(tool)), maxIterations: options.childMaxIterations });
  if (resolved.role.name !== checkpoint.role || roleBinding(resolved) !== checkpoint.roleBinding
    || (member?.role.model && member.role.model !== "inherit" && member.role.model !== checkpoint.model)) {
    throw new SubagentGovernanceError("agent_recovery_profile_mismatch", "Role instructions or frozen model changed; start a new task instead");
  }
  if (checkpoint.contextUnavailable) throw new SubagentGovernanceError("agent_recovery_context_unavailable", "The fork included image bytes that v1 journals deliberately do not persist; supply that context in a new task");
  const channel = createSubagentInputChannel();
  return { dependencies: checkpoint.dependencies, resourceStop: new TaskResourceStop(),
    ...(options.createLocalTools === undefined ? {} : { localTools: options.createLocalTools() }),
    ...(checkpoint.teamMember === undefined ? {} : { teamMember: checkpoint.teamMember }),
    agentId: checkpoint.agentId, taskId: checkpoint.taskId, roundOffset: checkpoint.round - 1,
    nickname: checkpoint.nickname, instruction: checkpoint.instruction,
    observation: new AgentRoundObservation(channel, checkpoint.transcript, checkpoint.cursor, checkpoint.budget),
    resolved: { ...resolved, model: checkpoint.model ?? resolved.model }, idleTimeoutMs: checkpoint.idleTimeoutMs,
    forkMessages: checkpoint.forkMessages, providerSession: createChildProviderSession(options.provider, checkpoint.forkMessages) };
}

export async function saveAgentCheckpoint(options: SubagentControlOptions, entry: AgentEntry,
  phase: SubagentCheckpoint["phase"], round: number): Promise<void> {
  if (options.checkpoints === undefined) return;
  const budget = entry.observation.currentBudget(options.runtime.getGovernance().snapshot(entry.agentId));
  if (budget === undefined) throw new SubagentGovernanceError("agent_checkpoint_unavailable", "Runtime budget is unavailable at the checkpoint boundary");
  await options.checkpoints.save({ version: 1, taskId: entry.taskId, agentId: entry.agentId, round: entry.roundOffset + round,
    phase, nickname: entry.nickname, instruction: entry.instruction, role: entry.resolved.role.name,
    roleBinding: roleBinding(entry.resolved), ...(entry.resolved.model === undefined ? {} : { model: entry.resolved.model }),
    ...(entry.teamMember === undefined ? {} : { teamMember: entry.teamMember }),
    allowedTools: [...entry.resolved.allowedTools], dependencies: entry.dependencies, idleTimeoutMs: entry.idleTimeoutMs,
    budget, cursor: entry.observation.cursor, transcript: entry.observation.transcript, ...portableFork(entry.forkMessages) });
}
