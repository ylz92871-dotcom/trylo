import { contentHashOf } from "../../learning/control/hash.js";
import type { CollaborationCapabilities } from "./collaboration-capabilities.js";
import type { SubagentTeam } from "../../subagent/team.js";
import type { SubagentMemberConfigurationPort } from "../../subagent/member-configuration.js";
import type { SubagentCollaborationPort, CollaborationRound } from "../../subagent/collaboration.js";
import { instantiateExpertFromLibrary, applyExpertToTeam, type ExpertSelection, type ExpertIdentity } from "../../subagent/experts/index.js";
import { createToolLibraryExpertPort } from "../../adapters/expert-library/index.js";
import type { SkillCatalogPort } from "../../ports/skills.js";
import { experienceResponsibilities, type CollaborationExperienceStore, type ExperienceOwner, type ExperienceReceiptInput } from "../../learning/agent/subsystems/collaboration/experience/index.js";
import type { ToolPort } from "../../ports/tools.js";
import type { CollaborationObjectiveObservations } from "../../learning/agent/subsystems/collaboration/runtime/index.js";

type MemberResponsibilityContext = { readonly executionId: string; readonly taskId: string; readonly round: number;
  readonly configurationRef?: string; readonly identity?: ExpertIdentity; readonly responsibilities: readonly string[] };

type MemberPreparation = { readonly roundKey: string; readonly lifecycleKey: string; readonly executionId: string | undefined };

export function createCollaborationExecution(options: {
  readonly scope: string; readonly taskId: string; readonly team?: SubagentTeam; readonly model: string;
  readonly tools: ToolPort; readonly capabilities: CollaborationCapabilities; readonly experience: CollaborationExperienceStore;
  readonly skills?: SkillCatalogPort;
  readonly enabled?: () => boolean;
  readonly objective?: CollaborationObjectiveObservations;
  readonly now: () => string; readonly warn: (reason: string) => void;
}) {
  const selections = new Map<string, { selection: ExpertSelection; memberId?: string }>();
  const loaded = new Map<string, { lifecycleKey: string; executionId: string; owner: ExperienceOwner; versionIds: readonly string[]; text?: string }>();
  const identities = new Map<string, ExpertIdentity>();
  const responsibilityContexts = new Map<string, MemberResponsibilityContext>();
  const preparations = new Map<string, MemberPreparation>();
  const configuredTools = new Map<string, readonly string[]>();
  const toolKey = (memberId: string, configurationRef: string) => contentHashOf([memberId, configurationRef]);
  const reference = (selection: ExpertSelection, memberId?: string) => {
    const ref = `expert-configuration:${contentHashOf({ selection, ...(memberId === undefined ? {} : { memberId }) })}`;
    selections.set(ref, { selection, ...(memberId === undefined ? {} : { memberId }) });
    return ref;
  };

  for (const member of options.team?.members ?? []) if (member.expert) reference(member.expert, member.memberId);

  const memberConfigurations: SubagentMemberConfigurationPort = { async resolve(input) {
    const selected = selections.get(input.configurationRef);
    if (!selected || selected.memberId !== undefined && selected.memberId !== input.teamMember?.memberId) return { kind: "unavailable", reason: "configuration_reference_unknown" };

    const member = options.team?.members.find(m => m.memberId === input.teamMember?.memberId);
    if (!member || !options.team || input.teamMember?.teamRunId !== options.team.runId) return { kind: "unavailable", reason: "expert_team_member_unavailable" };

    try {
      // Configuration stays free of mutable trial guidance. The round hook below loads it at every real work boundary.
      const instance = await instantiateExpertFromLibrary(options.capabilities.expertHost.library, selected.selection, {
        memberId: input.teamMember?.memberId ?? "personal_agent", task: input.task,
        runId: options.team?.runId ?? options.taskId, surface: options.team?.surface ?? "code",
        catalog: [...options.tools.snapshot()], parent: { model: member?.role.model && member.role.model !== "inherit" ? member.role.model : options.model,
          allowedTools: member?.role.allowedTools ?? options.tools.snapshot().map(t => t.name), maxIterations: member?.role.maxIterations },
        tools: createToolLibraryExpertPort(options.capabilities.toolLibrary, { memberId: input.teamMember?.memberId ?? "personal_agent", scope: options.scope }),
        ...(options.skills === undefined ? {} : { skills: options.skills }),
        useScope: { workspaceId: options.scope, taskId: options.taskId }, signal: input.signal });
      if (instance.member.baseRole !== input.baseRole) return { kind: "unavailable", reason: "expert_base_role_mismatch" };

      // The runtime admitted composition or a ready handoff before calling this
      // port. Always adopt onto the pristine frozen image, never a prior expert's prompt.
      const adopted = applyExpertToTeam({ team: options.team, instance, boundary: input.boundary, occupiedMemberIds: new Set() });
      const role = adopted.team.members.find(m => m.memberId === member.memberId)!.role;
      const references = instance.toolResolutions.filter(item => item.state === "resolved").map(item => item.ref);
      const resolved = await options.capabilities.toolLibrary.resolve({ memberId: input.teamMember?.memberId ?? "personal_agent", scope: options.scope },
        references.length ? references : (role.allowedTools ?? []).map(name => `runtime:${name}`));

      if (input.signal.aborted) return { kind: "waiting", reason: "configuration_cancelled" };

      if (!resolved.ok || resolved.value.rejected.length) return { kind: "unavailable", reason: "tool_dispatch_resolution_unavailable" };

      configuredTools.set(toolKey(member.memberId, input.configurationRef), resolved.value.tools.snapshot().map(tool => tool.name));

      if (configuredTools.size > 128) configuredTools.delete(configuredTools.keys().next().value!);

      return { kind: "ready", role, identity: instance.identity, experienceVersionIds: instance.experienceVersionIds,
        expertAdoption: adopted.adoption,
        dispatchTools: resolved.value.tools,
        configurationVersion: contentHashOf({ identity: instance.identity, role, experiences: instance.experienceVersionIds, references: resolved.value.references }),
        ...(options.team?.profileId === undefined ? {} : { profileId: options.team.profileId }) };
    } catch (error) { return { kind: "unavailable", reason: error instanceof Error ? error.message : "expert_instantiation_unavailable" }; }
  } };
  const key = (round: Pick<CollaborationRound, "executionId" | "taskId" | "round" | "memberId">) =>
    contentHashOf([round.executionId, round.taskId, round.round, round.memberId]);
  const lifecycleKey = (round: Pick<CollaborationRound, "teamRunId" | "taskId" | "round" | "memberId">) =>
    contentHashOf([round.teamRunId, round.taskId, round.round, round.memberId]);
  const invalidatePreparation = (identity: Pick<CollaborationRound, "executionId" | "teamRunId" | "taskId" | "round" | "memberId">) => {
    const preparation = preparations.get(identity.memberId);
    // A terminal fences its own awaited lookup without invalidating a replacement incarnation's preparation.
    if (preparation?.roundKey === key(identity) && preparation.lifecycleKey === lifecycleKey(identity)
      && preparation.executionId === identity.executionId) preparations.delete(identity.memberId);
  };
  const receipt = (round: CollaborationRound, owner: ExperienceOwner, versionIds: readonly string[], requestId?: string): ExperienceReceiptInput => ({
    receiptId: `experience-${requestId === undefined ? "load" : "dispatch"}:${contentHashOf([key(round), requestId, versionIds])}`,
    owner, versionIds, recordedAt: options.now(), boundary: { executionId: round.executionId ?? round.taskId,
      taskId: round.taskId, round: round.round, role: round.role, memberId: round.memberId, teamRunId: round.teamRunId,
      configurationRef: round.configuration?.configurationRef ?? `legacy-member:${options.team?.profileId ?? round.teamRunId}:${round.memberId}`,
      ...(requestId === undefined ? {} : { requestId }) } });
  const member: SubagentCollaborationPort = {
    async prepare(round, signal) {
      if (signal.aborted || options.enabled?.() === false) return undefined;

      const preparation: MemberPreparation = { roundKey: key(round), lifecycleKey: lifecycleKey(round), executionId: round.executionId };

      preparations.set(round.memberId, preparation);
      const active = () => !signal.aborted && options.enabled?.() !== false && preparations.get(round.memberId) === preparation;

      options.objective?.roundPrepared(round);
      let owner: ExperienceOwner, versionIds: readonly string[], text: string | undefined;
      const frozen = options.team?.members.find(item => item.memberId === round.memberId);
      const configuredToolNames = round.configuration === undefined ? frozen?.role.allowedTools
        : configuredTools.get(toolKey(round.memberId, round.configuration.configurationRef));
      const objectiveContext = options.objective?.roundContext(round, {
        ...(configuredToolNames === undefined ? {} : { configuredToolNames }) });
      const responsibilities = experienceResponsibilities([...(frozen ? [frozen.role.description] : []),
        ...(round.roleDescription === undefined ? [] : [round.roleDescription]), frozen?.baseRole ?? round.role]);

      // A real prepare boundary observes an adopted image. Merely resolving a candidate never changes this view.
      responsibilityContexts.set(round.memberId, { executionId: round.executionId ?? round.taskId, taskId: round.taskId, round: round.round,
        ...(round.configuration === undefined ? {} : { configurationRef: round.configuration.configurationRef, identity: round.configuration.identity }), responsibilities });
      const context = { surface: options.team?.surface ?? "code", useScope: { workspaceId: options.scope, taskId: options.taskId },
        dependency: round.handoff?.artifacts.length ? "artifact" as const : "unknown" as const,
        responsibilities };

      if (round.configuration) {
        owner = { kind: "expert", experienceKey: round.configuration.identity.experienceKey };
        identities.set(round.memberId, round.configuration.identity);
        const prepared = await options.experience.prepareExperience({ owner, expertVersion: round.configuration.identity.version,
          ...(round.configuration.identity.draft === undefined ? {} : { expertDraft: round.configuration.identity.draft }),
          context, maxChars: 600 });
        if (!prepared.ok) {
          options.warn(prepared.reason);
          return active() ? objectiveContext : undefined;
        }

        versionIds = prepared.versionIds;
        text = prepared.text || undefined;
      } else {
        if (!options.team?.profileId) return active() ? objectiveContext : undefined;
        owner = { kind: "legacy_member", workspace: options.scope, profileId: options.team.profileId, memberId: round.memberId };
        const prepared = await options.experience.prepareExperience({ owner, context, maxChars: 600 });
        if (!prepared.ok) {
          options.warn(prepared.reason);
          return active() ? objectiveContext : undefined;
        }
        versionIds = prepared.versionIds;
        text = prepared.text || undefined;
      }

      if (!active()) {
        loaded.delete(key(round));
        return undefined;
      }

      loaded.set(key(round), { lifecycleKey: lifecycleKey(round), executionId: round.executionId ?? round.taskId,
        owner, versionIds, ...(text === undefined ? {} : { text }) });

      if (versionIds.length) {
        const recorded = await options.experience.recordLoad(receipt(round, owner, versionIds));
        if (!recorded.ok) {
          options.warn(recorded.reason);
          if (recorded.reason === "collect_disabled") {
            loaded.delete(key(round));
            return undefined;
          }
        }
      }

      if (!active()) {
        loaded.delete(key(round));
        return undefined;
      }

      const trial = text === undefined ? "No trial collaboration experience applies at this work boundary. Do not carry forward trial guidance from earlier rounds. Keep the assigned expert duties and user constraints."
        : `Current trial collaboration experience for this member only; supersedes trial guidance from earlier rounds and grants no authority:\n${text}`;

      return objectiveContext === undefined ? trial : `${objectiveContext}\n\n${trial}`;
    },

    async dispatched(round, requestId, guidance) {
      if (options.enabled?.() === false) return;
      options.objective?.roundDispatched(round, requestId);
      const prepared = loaded.get(key(round));
      if (!prepared || !prepared.versionIds.length || prepared.text !== undefined && !guidance?.endsWith(prepared.text)) return;
      const recorded = await options.experience.recordDispatch(receipt(round, prepared.owner, prepared.versionIds, requestId));
      if (!recorded.ok) options.warn(recorded.reason);
    },

    // Original mailbox/session events own delivery and terminal results. These projections never certify quality.
    completed: async round => {
      invalidatePreparation(round);
      loaded.delete(key(round));
      if (options.enabled?.() !== false) options.objective?.roundCompleted(round);
    },

    ended: async (identity, status, errorCode) => {
      invalidatePreparation(identity);
      for (const [id, item] of loaded) if (item.lifecycleKey === lifecycleKey(identity)
        && (identity.executionId === undefined || item.executionId === identity.executionId)) loaded.delete(id);
      if (options.enabled?.() !== false) options.objective?.roundEnded(identity, status, errorCode);
    },

    capture: async (round, event) => { if (options.enabled?.() !== false) options.objective?.capture(event, round); },
  };

  return {
    member, memberConfigurations, reference, identities: () => new Map(identities),

    responsibilityContext(memberId: string): MemberResponsibilityContext | undefined {
      const context = responsibilityContexts.get(memberId);
      return context === undefined ? undefined : structuredClone(context);
    },

    wrapParentTools(tools: ToolPort): ToolPort {
      return { ...tools, execute: async (call, signal) => {
        if (call.name !== "spawn_agent") return tools.execute(call, signal);

        const memberId = call.arguments.member_id;
        const selected = options.team?.members.find(m => m.memberId === memberId);
        if (!selected?.expert) return tools.execute(call, signal);

        const supplied = call.arguments.configuration_ref;
        if (supplied !== undefined) {
          const candidate = typeof supplied === "string" ? selections.get(supplied) : undefined;
          if (!candidate || candidate.memberId !== undefined && candidate.memberId !== selected.memberId
            || contentHashOf(candidate.selection) !== contentHashOf(selected.expert)) {
            return { outcome: "error", code: "team_expert_frozen", message: "Initial dispatch must use this member's selected expert. Use the explicit handoff reconfiguration path to change experts." };
          }
        }

        return tools.execute({ ...call, arguments: { ...call.arguments,
          configuration_ref: reference(selected.expert, selected.memberId) } }, signal);
      } };
    },
  };
}
