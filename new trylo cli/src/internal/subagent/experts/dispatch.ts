import { ExpertLibraryError } from "./contracts.js";
import type { ExpertLibrary } from "./library.js";
import { instantiateExpert } from "./instantiate.js";
import type { ExpertInstantiation, InstantiateExpertInput } from "./instantiate.js";
import type { ExpertIdentity, ExpertToolResolution } from "./contracts.js";
import type { SubagentTeam, SubagentTeamMember } from "../team.js";
import { resolveRole } from "../role.js";

export type ExpertSelection = { readonly expertId: string; readonly version?: number }
  | { readonly requestId: string };

/** Resolve from the authoritative library at the next dispatch boundary. Never trust model-supplied config or approval receipts. */
export function instantiateExpertFromLibrary(library: ExpertLibrary, selection: ExpertSelection,
  dispatch: Omit<InstantiateExpertInput, "expert">): Promise<ExpertInstantiation> {
  if ("requestId" in selection) {
    const request = library.request(selection.requestId);
    return instantiateExpert({ ...dispatch, expert: { request } });
  }

  const version = library.get(selection.expertId, selection.version);
  if (version === undefined) throw new ExpertLibraryError("not_found", "Selected expert version is absent or archived");

  return instantiateExpert({ ...dispatch, expert: version });
}

/** This receipt describes one adoption; expert/experience authorities stay in their owning libraries. */
export type ExpertTeamAdoption = {
  readonly runId: string; readonly memberId: string; readonly boundary: "composition" | "handoff";
  readonly identity: ExpertIdentity; readonly experienceVersionIds: readonly string[];
  readonly toolResolutions: readonly ExpertToolResolution[];
};

/** Runtime-only provenance prevents another adoption from retaining stale specialist experience. */
export type ExpertTeamMember = SubagentTeamMember & { readonly expertAdoption: ExpertTeamAdoption };

/** Adopt into a fresh team image while retaining all existing member and team constraints. */
export function applyExpertToTeam(input: { readonly team: SubagentTeam; readonly instance: ExpertInstantiation;
  readonly boundary: "composition" | "handoff"; readonly occupiedMemberIds: ReadonlySet<string> }): {
    readonly team: SubagentTeam; readonly adoption: ExpertTeamAdoption } {
  const { team, instance } = input;

  if (!["composition", "handoff"].includes(input.boundary) || team.runId !== instance.runId
    || (team.surface ?? "code") !== instance.surface) {
    throw new ExpertLibraryError("invalid_input", "Expert adoption must match the team run, surface and dispatch boundary");
  }

  const targets = team.members.filter(member => member.memberId === instance.member.memberId);
  const target = targets[0];
  if (targets.length !== 1 || target === undefined || target.baseRole !== instance.member.baseRole) {
    throw new ExpertLibraryError("invalid_input", "Expert adoption requires one matching member identity and base role");
  }

  if (input.occupiedMemberIds.has(target.memberId)) {
    throw new ExpertLibraryError("invalid_state", "A running member cannot adopt a new expert configuration; wait for its handoff boundary");
  }

  if ("expertAdoption" in target) {
    throw new ExpertLibraryError("invalid_state", "This member already contains an expert adoption; reload its pristine frozen member configuration before the next adoption");
  }

  const targetModel = fixedModel(target.role.model);
  const expertModel = fixedModel(instance.member.role.model);
  if (targetModel !== undefined && expertModel !== undefined && targetModel !== expertModel) {
    throw new ExpertLibraryError("conflict", "The expert model differs from the fixed team member model; explicitly reconfigure the member at this boundary first");
  }

  const requestedTools = instance.member.role.allowedTools;
  if (requestedTools === undefined) throw new ExpertLibraryError("invalid_input", "Expert instance has not resolved its dispatch tool ceiling");

  const combinedRole = { ...target.role, ...instance.member.role,
    name: target.baseRole, model: targetModel ?? instance.member.role.model,
    prompt: [target.role.prompt, instance.member.role.prompt
      ? `Expert specialization must obey the existing team instructions and user constraints:\n${instance.member.role.prompt}` : ""].filter(Boolean).join("\n\n"),
    skills: [...new Set([...(target.role.skills ?? []), ...(instance.member.role.skills ?? [])])],
    disallowedTools: [...new Set([...(target.role.disallowedTools ?? []), ...(instance.member.role.disallowedTools ?? [])])] };
  const resolved = resolveRole([combinedRole], target.baseRole, { model: target.role.model,
    allowedTools: target.role.allowedTools ?? requestedTools, maxIterations: target.role.maxIterations });
  const adoption: ExpertTeamAdoption = { runId: team.runId, memberId: target.memberId, boundary: input.boundary,
      identity: { ...instance.identity, ...(instance.identity.draft === undefined ? {} : { draft: { ...instance.identity.draft } }) },
      experienceVersionIds: [...instance.experienceVersionIds],
      toolResolutions: instance.toolResolutions.map(item => item.state !== "resolved" ? item :
        item.toolNames.some(name => resolved.allowedTools.includes(name))
          ? { ...item, toolNames: item.toolNames.filter(name => resolved.allowedTools.includes(name)) }
          : { ref: item.ref, state: "unavailable", reason: "The existing team member configuration withholds this tool" }) };
  const member: ExpertTeamMember = { ...target, ...instance.member, expertAdoption: adoption,
    role: { ...combinedRole, model: resolved.model, allowedTools: resolved.allowedTools, maxIterations: resolved.maxIterations } };

  return { team: { ...team, members: team.members.map(candidate => candidate === target ? member : candidate) }, adoption };
}

function fixedModel(model: string | undefined): string | undefined { return model === "inherit" ? undefined : model; }
