import type { ExpertIdentity } from "./experts/contracts.js";
import type { ExpertTeamAdoption } from "./experts/index.js";
import { resolveRole, type ResolvedRole, type SubagentRole } from "./role.js";
import { fixedTeamModel, narrowTeamMemberToolNames, selectTeamMember, type TeamMemberIdentity, type SubagentTeamMember } from "./team.js";
import { SubagentGovernanceError } from "./governance.js";
import type { AgentEntry, StartRequest, SubagentControlOptions } from "./control-session.js";
import { handoffMessage, isSubagentHandoff, type SubagentHandoff } from "../protocol/subagent-handoff.js";
import type { SubagentGovernance } from "./types.js";
import type { JsonObject } from "../protocol/envelope.js";
import type { ToolPort } from "../ports/tools.js";

export type SubagentMemberConfigurationMetadata = {
  /** Original admission boundary; old in-memory hosts may omit it. */
  readonly boundary?: "composition" | "handoff";
  readonly expertAdoption?: ExpertTeamAdoption;
  readonly configurationRef: string; readonly configurationVersion: string; readonly identity: ExpertIdentity;
  readonly experienceVersionIds: readonly string[]; readonly profileId?: string;
};

export type ReadyMemberConfiguration = { readonly kind: "ready"; readonly role: SubagentRole; readonly identity: ExpertIdentity;
  readonly expertAdoption?: ExpertTeamAdoption;
  readonly experienceVersionIds: readonly string[]; readonly configurationVersion: string; readonly profileId?: string;
  readonly dispatchTools?: ToolPort };

export type SubagentMemberConfigurationPort = {
  /** The host resolves an opaque selection through the authoritative expert library and current resource/approval services. */
  resolve(input: { readonly configurationRef: string; readonly baseRole: string; readonly teamMember?: TeamMemberIdentity;
    readonly boundary: "composition" | "handoff";
    readonly profileId?: string; readonly taskId?: string; readonly task: string; readonly signal: AbortSignal }): Promise<
      ReadyMemberConfiguration | { readonly kind: "waiting" | "unavailable"; readonly reason: string }>;
};

export type AdmittedMemberConfiguration = { readonly metadata: SubagentMemberConfigurationMetadata; readonly role: SubagentRole;
  readonly dispatchTools?: ToolPort };

/** Resolve one immutable dispatch image. An explicit configuration is a new image; ordinary continuation retains the old one. */
export function resolveDispatchRole(options: SubagentControlOptions, request: StartRequest,
  member: SubagentTeamMember | undefined, parentTools: readonly string[]): ResolvedRole {
  if (request.allowedTools?.some(name => !parentTools.includes(name))) {
    throw new SubagentGovernanceError("subagent_permission_denied", "allowed_tools contains tools unavailable to this parent");
  }

  const parent = { model: options.model, allowedTools: [...(request.allowedTools ?? parentTools)], maxIterations: options.childMaxIterations };
  const adoption = request.configuration?.metadata.expertAdoption;
  const frozenMember = adoption === undefined ? undefined : options.team?.runId === adoption.runId
    ? options.team.members.find(candidate => candidate.memberId === adoption.memberId) : undefined;
  if (adoption !== undefined && frozenMember === undefined) {
    throw new SubagentGovernanceError("member_configuration_invalid", "Expert configuration lost its original frozen member constraint baseline");
  }

  const role = request.configuration === undefined ? request.previous?.resolved ?? resolveRole(member === undefined ? options.roles ?? [] : [member.role],
    member?.role.name ?? request.agentType, parent)
    : resolveConfiguredRole(request.configuration, request.previous?.resolved.role.name ?? member?.baseRole ?? request.agentType ?? "default",
      parent, options.team?.surface, frozenMember?.role ?? request.previous?.resolved.role ?? member?.role);
  const frozenModel = fixedTeamModel(member);
  const migration = request.configuration === undefined && request.previous?.configuration === undefined ? options.modelMigration : undefined;
  if (migration !== undefined && request.model !== undefined && request.model !== migration) {
    throw new SubagentGovernanceError("team_model_migration_target", "This resumed connection uses the host's explicitly accepted target model; omit the model override or use that target");
  }

  if (migration === undefined && request.configuration === undefined && frozenModel !== undefined && request.model !== undefined && request.model !== frozenModel) {
    throw new SubagentGovernanceError("team_model_frozen", "The member model is frozen by the team profile");
  }

  if (request.configuration !== undefined && request.model !== undefined && request.model !== role.model) {
    throw new SubagentGovernanceError("member_configuration_invalid", "A model override cannot replace the resolved expert configuration");
  }

  const model = migration ?? request.model;

  return model === undefined ? role : { ...role, model };
}

export async function configurationForSpawn(options: SubagentControlOptions, occupied: ReadonlySet<string>, reference: string,
  request: { readonly message: string; readonly agentType?: string | undefined; readonly memberId?: string | undefined }, signal: AbortSignal) {
  const member = selectTeamMember(options.team, request.agentType, request.memberId, occupied);
  const baseRole = member?.baseRole ?? request.agentType ?? "default";
  const result = await resolveMemberConfiguration(options, { configurationRef: reference, baseRole, task: request.message, signal, boundary: "composition",
    ...(member === undefined ? {} : { teamMember: { teamRunId: options.team!.runId, memberId: member.memberId } }) });
  return "kind" in result ? result : { kind: "ready" as const, configuration: result, agentType: baseRole,
    ...(member === undefined ? {} : { memberId: member.memberId }) };
}

export async function reconfigureMemberAtHandoff(input: { readonly options: SubagentControlOptions; readonly entry: AgentEntry;
  readonly reference: string; readonly message: string; readonly handoff: SubagentHandoff; readonly toolCallId: string;
  readonly signal: AbortSignal; readonly governance?: SubagentGovernance | undefined;
  readonly isCurrent: () => boolean; readonly start: (request: StartRequest) => AgentEntry }):
  Promise<AgentEntry | "cancelled" | { readonly kind: "waiting" | "unavailable"; readonly reason: string }> {
  const { options, entry, signal } = input;

  if (!isSubagentHandoff(input.handoff)) throw new SubagentGovernanceError("invalid_handoff", "A configuration change requires a complete typed handoff");

  if (!entry.observation.isReady()) return { kind: "waiting", reason: "waiting_handoff" };

  const configuration = await resolveMemberConfiguration(options, { configurationRef: input.reference, baseRole: entry.resolved.role.name,
    task: input.message, taskId: entry.taskId, signal, boundary: "handoff", ...(entry.teamMember === undefined ? {} : { teamMember: entry.teamMember }) });

  if (signal.aborted) return "cancelled";

  if ("kind" in configuration) return configuration;

  if (!input.isCurrent() || !entry.observation.isReady()) return { kind: "waiting", reason: "waiting_handoff" };

  if (await retireMemberAtHandoff(options, entry, signal) === "cancelled") return "cancelled";

  const next = input.start({ previous: entry, configuration, toolCallId: input.toolCallId,
    message: handoffMessage(input.message, input.handoff), handoff: input.handoff,
    ...(input.governance === undefined ? {} : { governance: input.governance }) });

  entry.providerSession.close();
  return next;
}

export function memberConfigurationReceipt(metadata: SubagentMemberConfigurationMetadata | undefined): JsonObject {
  return metadata === undefined ? {} : { configuration: { configuration_ref: metadata.configurationRef,
    configuration_version: metadata.configurationVersion, expert: { ...metadata.identity },
    experience_version_ids: [...metadata.experienceVersionIds], ...(metadata.profileId === undefined ? {} : { profile_id: metadata.profileId }),
    ...(metadata.expertAdoption === undefined ? {} : { expert_adoption: { boundary: metadata.expertAdoption.boundary,
      team_run_id: metadata.expertAdoption.runId, member_id: metadata.expertAdoption.memberId } }) } };
}

export async function resolveMemberConfiguration(options: SubagentControlOptions, input: {
  readonly configurationRef: string; readonly baseRole: string; readonly teamMember?: TeamMemberIdentity; readonly taskId?: string;
  readonly boundary: "composition" | "handoff";
  readonly task: string; readonly signal: AbortSignal }): Promise<AdmittedMemberConfiguration | { readonly kind: "waiting" | "unavailable"; readonly reason: string }> {
  if (options.memberConfigurations === undefined) return { kind: "unavailable", reason: "member_configuration_port_unavailable" };

  let result: Awaited<ReturnType<SubagentMemberConfigurationPort["resolve"]>>;

  try { result = await options.memberConfigurations.resolve({ ...input,
    ...(options.teamProfileId === undefined ? {} : { profileId: options.teamProfileId }) }); }
  catch { return input.signal.aborted ? { kind: "waiting", reason: "configuration_cancelled" }
    : { kind: "unavailable", reason: "member_configuration_resolution_failed" }; }

  if (input.signal.aborted) return { kind: "waiting", reason: "configuration_cancelled" };

  if (!result || typeof result !== "object") throw new SubagentGovernanceError("member_configuration_invalid", "Configuration resolver returned no typed result");

  if (result.kind !== "ready") {
    if ((result.kind !== "waiting" && result.kind !== "unavailable") || typeof result.reason !== "string" || !result.reason || result.reason.length > 1000) {
      throw new SubagentGovernanceError("member_configuration_invalid", "Configuration resolver returned an invalid wait result");
    }
    return result;
  }

  if (!validReadyConfiguration(result) || result.role.name !== input.baseRole) {
    throw new SubagentGovernanceError("member_configuration_invalid", "An expert may specialize the selected base role, never replace its authority role");
  }

  if (result.expertAdoption !== undefined && (result.expertAdoption.boundary !== input.boundary
    || result.expertAdoption.runId !== input.teamMember?.teamRunId || result.expertAdoption.memberId !== input.teamMember?.memberId
    || !sameExpertIdentity(result.expertAdoption.identity, result.identity)
    || JSON.stringify(result.expertAdoption.experienceVersionIds) !== JSON.stringify(result.experienceVersionIds))) {
    throw new SubagentGovernanceError("member_configuration_invalid", "Expert adoption does not belong to this member dispatch boundary");
  }

  return { role: result.role, ...(result.dispatchTools === undefined ? {} : { dispatchTools: result.dispatchTools }),
    metadata: { boundary: input.boundary, configurationRef: input.configurationRef, configurationVersion: result.configurationVersion,
    ...(result.expertAdoption === undefined ? {} : { expertAdoption: structuredClone(result.expertAdoption) }),
    identity: result.identity, experienceVersionIds: [...result.experienceVersionIds],
    ...(result.profileId === undefined && options.teamProfileId === undefined ? {} : { profileId: result.profileId ?? options.teamProfileId! }) } };
}

function sameExpertIdentity(left: ExpertIdentity, right: ExpertIdentity): boolean {
  return left.expertId === right.expertId && left.version === right.version && left.experienceKey === right.experienceKey
    && left.draft?.requestId === right.draft?.requestId && left.draft?.revision === right.draft?.revision;
}

export function resolveConfiguredRole(configuration: AdmittedMemberConfiguration, baseRole: string,
  parent: { readonly model: string | undefined; readonly allowedTools: readonly string[]; readonly maxIterations: number | undefined },
  surface: "code" | "work" | undefined, previousRole?: SubagentRole): ResolvedRole {
  if (configuration.role.name !== baseRole) throw new SubagentGovernanceError("member_configuration_invalid", "The base role cannot change through configuration");
  const role = { ...configuration.role, disallowedTools: [...new Set([...(previousRole?.disallowedTools ?? []), ...(configuration.role.disallowedTools ?? [])])] };
  const allowedTools = narrowTeamMemberToolNames({ baseRole, role }, parent.allowedTools, surface);
  return resolveRole([{ ...role, allowedTools }], baseRole, parent);
}

export async function retireMemberAtHandoff(options: SubagentControlOptions, entry: AgentEntry, signal: AbortSignal): Promise<"ready" | "cancelled"> {
  entry.channel.close();
  await entry.resourceStop.stop(async () => {
    const retired = await options.runtime.waitForRetirement(entry.agentId, 5000, new AbortController().signal);
    if (retired !== "ready") throw new SubagentGovernanceError("agent_stopping", "The old worker has not retired; no configuration was applied");
    await options.taskResources?.stop(entry.taskId);
  });
  entry.observation.accountSettled(await options.runtime.settled<import("./interactive-worker.js").InteractiveChildResult>(entry.agentId));

  return signal.aborted ? "cancelled" : "ready";
}

function validReadyConfiguration(v: ReadyMemberConfiguration): boolean {
  const id = v.identity, role = v.role;
  const text = (value: unknown, max: number): value is string => typeof value === "string" && !!value.trim() && value.length <= max;
  const names = (value: readonly string[] | undefined): boolean => value === undefined || Array.isArray(value) && value.length <= 256 && value.every(name => text(name, 512));

  return !!id && Object.keys(id).every(k => ["expertId", "version", "experienceKey", "draft"].includes(k)) && text(id.expertId, 512) && text(id.experienceKey, 512)
    && Number.isSafeInteger(id.version) && id.version > 0 && text(v.configurationVersion, 512)
    && (id.draft === undefined || text(id.draft.requestId, 512) && Number.isSafeInteger(id.draft.revision) && id.draft.revision > 0)
    && (v.profileId === undefined || typeof v.profileId === "string" && v.profileId.length > 0 && v.profileId.length <= 512)
    && Array.isArray(v.experienceVersionIds) && v.experienceVersionIds.length <= 32 && v.experienceVersionIds.every(ref => typeof ref === "string" && ref.length > 0 && ref.length <= 512)
    && !!role && typeof role.name === "string" && typeof role.description === "string"
    && (role.prompt === undefined || typeof role.prompt === "string" && role.prompt.length <= 131072)
    && (role.model === undefined || text(role.model, 200))
    && (role.maxIterations === undefined || Number.isSafeInteger(role.maxIterations) && role.maxIterations > 0)
    && names(role.allowedTools) && names(role.disallowedTools) && names(role.skills);
}
