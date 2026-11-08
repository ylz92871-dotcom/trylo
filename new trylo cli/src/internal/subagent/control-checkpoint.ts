import { AgentRoundObservation } from "./control-observation.js";
import { createSubagentInputChannel } from "./input-channel.js";
import { createChildProviderSession } from "./child-provider-session.js";
import { roleBinding, portableFork, type SubagentCheckpoint } from "./checkpoint.js";
import type { AgentEntry, SubagentControlOptions } from "./control-session.js";
import { SubagentGovernanceError } from "./governance.js";
import { resolveRole } from "./role.js";
import { TaskResourceStop } from "./task-resources.js";
import { configurationCheckpoint, matchesConfigurationCheckpoint } from "./configuration-checkpoint.js";
import { resolveConfiguredRole, resolveMemberConfiguration, type AdmittedMemberConfiguration } from "./member-configuration.js";

/** Continuation data contains no Runtime handle and cannot pretend an old execution is alive. */
export type AgentContinuation = Pick<AgentEntry, "configuration" | "dispatchTools" | "dependencies" | "resourceStop" | "localTools" | "teamMember" | "agentId" | "taskId"
  | "roundOffset" | "nickname" | "instruction" | "observation" | "resolved" | "idleTimeoutMs" | "forkMessages" | "providerSession" | "routing">;

export async function checkpointContinuation(options: SubagentControlOptions, checkpoint: SubagentCheckpoint, signal: AbortSignal): Promise<AgentContinuation> {
  const member = options.team?.members.find(candidate => candidate.memberId === checkpoint.teamMember?.memberId);
  if (checkpoint.teamMember !== undefined ? options.team?.runId !== checkpoint.teamMember.teamRunId || member === undefined
    : options.team !== undefined) throw new SubagentGovernanceError("agent_recovery_profile_mismatch", "The saved task does not belong to this frozen team");

  if (member !== undefined && options.team?.heldRoles?.includes(member.baseRole)) {
    throw new SubagentGovernanceError("team_role_held", "This role is held pending clarification");
  }

  if (checkpoint.contextUnavailable) throw new SubagentGovernanceError("agent_recovery_context_unavailable", "The fork included image bytes that v1 journals deliberately do not persist; supply that context in a new task");

  const configuration = await recoverConfiguration(options, checkpoint, signal);

  signal.throwIfAborted();
  const parentTools = typeof options.allowedTools === "function" ? options.allowedTools() : options.allowedTools ?? ["read_file"];
  const parent = { model: options.model, allowedTools: parentTools.filter(tool => checkpoint.allowedTools.includes(tool)), maxIterations: options.childMaxIterations };
  const resolved = configuration === undefined
    ? resolveRole(member === undefined ? options.roles ?? [] : [member.role], member?.role.name ?? checkpoint.role, parent)
    : resolveConfiguredRole(configuration, checkpoint.role, parent, options.team?.surface, member?.role);
  const migration = configuration === undefined ? options.modelMigration : undefined;
  if (resolved.role.name !== checkpoint.role || roleBinding(resolved) !== checkpoint.roleBinding
    || configuration !== undefined && resolved.model !== checkpoint.model
    || (migration === undefined && member?.role.model && member.role.model !== "inherit" && member.role.model !== checkpoint.model)) {
    throw new SubagentGovernanceError("agent_recovery_profile_mismatch", "Role instructions or frozen model changed; start a new task instead");
  }

  const model = migration ?? checkpoint.model ?? resolved.model;
  const channel = createSubagentInputChannel();

  return { dependencies: checkpoint.dependencies, resourceStop: new TaskResourceStop(),
    ...(configuration === undefined ? {} : { configuration: configuration.metadata,
      ...(configuration.dispatchTools === undefined ? {} : { dispatchTools: configuration.dispatchTools }) }),
    ...(checkpoint.routing === undefined ? {} : { routing: checkpoint.routing }),
    ...(options.createLocalTools === undefined ? {} : { localTools: options.createLocalTools() }),
    ...(checkpoint.teamMember === undefined ? {} : { teamMember: checkpoint.teamMember }),
    agentId: checkpoint.agentId, taskId: checkpoint.taskId, roundOffset: checkpoint.round - 1,
    nickname: checkpoint.nickname, instruction: checkpoint.instruction,
    observation: new AgentRoundObservation(channel, checkpoint.transcript, checkpoint.cursor, checkpoint.budget),
    resolved: { ...resolved, model }, idleTimeoutMs: checkpoint.idleTimeoutMs,
    forkMessages: checkpoint.forkMessages, providerSession: createChildProviderSession(options.provider, checkpoint.forkMessages, model) };
}

/** Re-admit an opaque locator through the original host; never infer latest versions or deserialize authority. */
async function recoverConfiguration(options: SubagentControlOptions, checkpoint: SubagentCheckpoint, signal: AbortSignal): Promise<AdmittedMemberConfiguration | undefined> {
  const saved = checkpoint.configuration;
  if (saved === undefined) return undefined;

  const currentProfile = options.teamProfileId ?? options.team?.profileId;
  if (saved.profileId !== undefined && saved.profileId !== currentProfile) {
    throw new SubagentGovernanceError("agent_recovery_configuration_changed", "The saved expert profile no longer matches this host");
  }

  const configuration = await resolveMemberConfiguration(options, { configurationRef: saved.configurationRef, baseRole: checkpoint.role,
    boundary: saved.boundary, task: checkpoint.instruction, taskId: checkpoint.taskId, signal,
    ...(checkpoint.teamMember === undefined ? {} : { teamMember: checkpoint.teamMember }) });
  if ("kind" in configuration) {
    throw new SubagentGovernanceError("agent_recovery_configuration_unavailable", `The saved expert configuration cannot be re-admitted: ${configuration.reason}`);
  }

  if (!matchesConfigurationCheckpoint(configuration.metadata, saved)) {
    throw new SubagentGovernanceError("agent_recovery_configuration_changed", "The saved expert, configuration or experience versions changed; start a new task instead");
  }

  return configuration;
}

export async function saveAgentCheckpoint(options: SubagentControlOptions, entry: AgentEntry,
  phase: SubagentCheckpoint["phase"], round: number): Promise<void> {
  if (options.checkpoints === undefined) return;

  const budget = entry.observation.currentBudget(options.runtime.getGovernance().snapshot(entry.agentId));
  if (budget === undefined) throw new SubagentGovernanceError("agent_checkpoint_unavailable", "Runtime budget is unavailable at the checkpoint boundary");

  const configuration = entry.configuration === undefined ? undefined : configurationCheckpoint(entry.configuration);
  if (entry.configuration !== undefined && configuration === undefined) {
    throw new SubagentGovernanceError("agent_checkpoint_unavailable", "The expert admission boundary is unavailable; its configuration cannot be checkpointed safely");
  }

  await options.checkpoints.save({ version: 1, taskId: entry.taskId, agentId: entry.agentId, round: entry.roundOffset + round,
    ...(configuration === undefined ? {} : { configuration }),
    ...(entry.routing === undefined ? {} : { routing: entry.routing }),
    phase, nickname: entry.nickname, instruction: entry.instruction, role: entry.resolved.role.name,
    roleBinding: roleBinding(entry.resolved), ...(entry.resolved.model === undefined ? {} : { model: entry.resolved.model }),
    ...(entry.teamMember === undefined ? {} : { teamMember: entry.teamMember }),
    allowedTools: [...entry.resolved.allowedTools], dependencies: entry.dependencies, idleTimeoutMs: entry.idleTimeoutMs,
    budget, cursor: entry.observation.cursor, transcript: entry.observation.transcript, ...portableFork(entry.forkMessages) });
}
