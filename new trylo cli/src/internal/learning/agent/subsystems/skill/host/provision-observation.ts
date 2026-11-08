import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { SessionRecord } from "../../../../../ports/session.js";
import { journalChildEnvelope, type DelegatedTask } from "./journal-delegation.js";

type Provision = {
  readonly kind: "skill_context_provided"; readonly version: 1; readonly origin: "hermes"; readonly source: "team_selection";
  readonly teamRunId: string; readonly memberId: string; readonly taskId: string; readonly subagentId: string;
  readonly rootAttemptId: string; readonly parentToolCallId?: string; readonly requestId: string; readonly round: number;
  readonly skills: readonly { readonly name: string; readonly contentHash: string }[];
};

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 1024 && !value.includes("\0");

/** Whitelisted metadata only. A provision receipt is never an actual skill_view or approval. */
export function isSkillContextProvided(value: unknown): value is Provision {
  if (!record(value) || Object.keys(value).some(key => !["kind", "version", "origin", "source", "teamRunId", "memberId", "taskId", "subagentId",
    "rootAttemptId", "parentToolCallId", "requestId", "round", "skills"].includes(key))) return false;
  return value.kind === "skill_context_provided" && value.version === 1 && value.origin === "hermes" && value.source === "team_selection"
    && [value.teamRunId, value.memberId, value.taskId, value.subagentId, value.rootAttemptId, value.requestId].every(identity)
    && (value.parentToolCallId === undefined || identity(value.parentToolCallId))
    && typeof value.round === "number" && Number.isSafeInteger(value.round) && value.round > 0
    && Array.isArray(value.skills) && value.skills.length > 0 && value.skills.length <= 32 && value.skills.every(skill => record(skill)
      && Object.keys(skill).length === 2 && identity(skill.name) && skill.name.length <= 512
      && typeof skill.contentHash === "string" && /^[a-f0-9]{64}$/.test(skill.contentHash));
}

/** Read the single canonical observation source through already admitted parent/child lineages. */
export function delegatedProvidedSkills(records: readonly SessionRecord[], task: DelegatedTask): JsonObject {
  const provided: JsonObject[] = [], seen = new Set<string>();

  for (const record of records) {
    const envelope = journalChildEnvelope(record);
    if (envelope?.kind !== "observation" || !isSkillContextProvided(envelope.payload)) continue;

    const fact = envelope.payload;
    const execution = task.executions.find(item => item.taskId === fact.taskId && item.agentId === fact.subagentId
      && item.parentTurnId === record.turnId && item.spawnedAt < record.sequence && item.rootAttemptId === fact.rootAttemptId
      && item.rootAttemptId === envelope.attemptId && (fact.parentToolCallId === undefined || fact.parentToolCallId === item.parentToolCallId)
      && item.teamMember !== undefined && item.teamMember.teamRunId === fact.teamRunId && item.teamMember.memberId === fact.memberId);
    if (execution === undefined) continue;

    for (const skill of fact.skills) {
      const key = JSON.stringify([fact.taskId, fact.subagentId, skill.name, skill.contentHash]);
      if (seen.has(key)) continue;
      seen.add(key);
      provided.push({ name: skill.name, contentHash: skill.contentHash, origin: fact.origin, source: fact.source,
        teamRunId: fact.teamRunId, memberId: fact.memberId, taskId: fact.taskId, subagentId: fact.subagentId,
        rootAttemptId: fact.rootAttemptId, parentToolCallId: execution.parentToolCallId, requestId: fact.requestId, round: fact.round });
    }
  }

  return provided.length === 0 ? {} : { providedSkills: provided.slice(-32), omittedProvidedSkills: Math.max(0, provided.length - 32),
    providedSkillsInterpretation: "Native content supplied in an acknowledged compiled child request; not a skill_view, usage counter, task success or independent verification." };
}
