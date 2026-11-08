import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { SkillCatalogPort } from "../../../../../ports/skills.js";
import type { ChildRequestDispatch, ChildRequestObservation } from "../../../../../subagent/request-dispatched.js";
import { contentHashOf } from "../../../../control/hash.js";
import type { HermesExplicitProvided } from "./explicit-resolver.js";

type Candidate = { readonly name: string; readonly contentHash: string; readonly injectedText: string };

/** Keep matching text in memory only; a selected/resolved asset is not yet a provision fact. */
export function createTeamSkillProvisionObserver(input: {
  readonly teamRunId: string;
  readonly members: readonly { readonly memberId: string; readonly names: readonly string[] }[];
  readonly catalog: SkillCatalogPort;
  readonly resolved: readonly HermesExplicitProvided[];
  readonly warn?: (code: string) => void;
}): ChildRequestObservation | undefined {
  const resolved = new Map(input.resolved.map(item => [item.requestedName, item]));
  const members = new Map<string, readonly Candidate[]>();

  for (const member of input.members) {
    const candidates = member.names.flatMap(requested => {
      const receipt = resolved.get(requested), loaded = input.catalog.load(requested, undefined);
      if (receipt === undefined || loaded.kind !== "loaded" || loaded.skill.descriptor.name !== receipt.name
        || contentHashOf(loaded.skill.content) !== receipt.contentHash) return [];
      return [{ name: receipt.name, contentHash: receipt.contentHash,
        injectedText: `Selected member skill: ${requested}\n${loaded.skill.content}` }];
    });
    if (candidates.length > 0) members.set(member.memberId, candidates);
  }

  if (members.size === 0) return undefined;

  const sent = new Set<string>();
  let warned = false;

  return async (dispatch: ChildRequestDispatch): Promise<readonly JsonObject[]> => {
    if (dispatch.teamMember?.teamRunId !== input.teamRunId) return [];

    const candidates = members.get(dispatch.teamMember.memberId);
    if (candidates === undefined) return [];

    const skills: JsonObject[] = [];

    for (const candidate of candidates) {
      const key = JSON.stringify([dispatch.agentId, dispatch.taskId, candidate.name, candidate.contentHash]);
      if (sent.has(key) || !dispatch.request.messages.some(message => message.role === "user" && message.content.includes(candidate.injectedText))) continue;

      if (sent.size >= 4096) {
        if (!warned) {
          warned = true;
          input.warn?.("hermes_skill_provision_observation_limit");
        }
        break;
      }

      sent.add(key);
      skills.push({ name: candidate.name, contentHash: candidate.contentHash });
    }

    if (skills.length === 0) return [];

    // This callback is invoked only after a real provider response. Never emit
    // the request, the matcher text, a skill_view receipt or a success verdict.
    return [{ kind: "skill_context_provided", version: 1, origin: "hermes", source: "team_selection",
      teamRunId: input.teamRunId, memberId: dispatch.teamMember.memberId, taskId: dispatch.taskId, subagentId: dispatch.agentId,
      rootAttemptId: dispatch.rootAttemptId,
      ...(dispatch.parentToolCallId === undefined ? {} : { parentToolCallId: dispatch.parentToolCallId }),
      requestId: dispatch.request.attemptId, round: dispatch.round, skills }];
  };
}
