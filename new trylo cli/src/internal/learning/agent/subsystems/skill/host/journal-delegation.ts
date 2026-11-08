import type { SessionRecord } from "../../../../../ports/session.js";
import type { JsonObject, JsonValue } from "../../../../../protocol/envelope.js";
import type { Transcript } from "../../../../../protocol/transcript.js";
import { toolCallIndexByResult } from "../../../../../protocol/tool-pairing.js";
import { SUBAGENT_TOOL_NAME } from "../../../../../subagent/names.js";
import { SPAWN_AGENT_TOOL, RESUME_AGENT_TOOL, SEND_INPUT_TOOL, RECONFIGURE_AGENT_TOOL } from "../../../../../subagent/control-bindings.js";
import type { TeamMemberIdentity } from "../../../../../subagent/team.js";

export type JournalExperienceSource = { readonly sessionId: string; readonly turnId: string; readonly terminalSequence: number };

export type DelegatedExecution = {
  readonly taskId: string; readonly agentId: string; readonly parentTurnId: string;
  readonly parentToolCallId: string; readonly rootAttemptId: string; readonly spawnedAt: number;
  readonly teamMember?: TeamMemberIdentity;
};

export type DelegatedTask = { readonly latest: DelegatedExecution; readonly executions: readonly DelegatedExecution[] };

export type JournalChildEnvelope = {
  readonly record: SessionRecord; readonly kind: string; readonly attemptId: string; readonly payload: JsonObject;
};

const DELEGATION_TOOLS = new Set<string>([SUBAGENT_TOOL_NAME, SPAWN_AGENT_TOOL, RESUME_AGENT_TOOL, SEND_INPUT_TOOL, RECONFIGURE_AGENT_TOOL]);
const identity = (value: JsonValue | undefined): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024;
const object = (value: JsonValue | undefined): JsonObject | undefined => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as JsonObject : undefined; // Array.isArray does not narrow readonly JSON arrays in TypeScript.

/** Embedded locators must agree with their canonical record, never just its payload task id. */
export function journalChildEnvelope(record: SessionRecord): JournalChildEnvelope | undefined {
  if (record.type !== "envelope") return undefined;
  const envelope = object(record.payload.envelope), payload = object(envelope?.payload);
  return envelope?.producerId === "subagent" && envelope.sessionId === record.sessionId && envelope.turnId === record.turnId
    && typeof envelope.kind === "string" && typeof envelope.attemptId === "string" && payload !== undefined
    ? { record, kind: envelope.kind, attemptId: envelope.attemptId, payload } : undefined;
}

/** This prefix is a view of one already validated snapshot, not another read or writer. */
export function journalExperiencePrefix(records: readonly SessionRecord[], source: JournalExperienceSource): readonly SessionRecord[] {
  return records.filter(record => record.sessionId === source.sessionId && record.sequence <= source.terminalSequence);
}

export function journalSourceStart(records: readonly SessionRecord[], source: JournalExperienceSource): number {
  return records.find(record => record.turnId === source.turnId)?.sequence ?? source.terminalSequence;
}

/** Admit only real spawn lineages enclosed by the matching settled parent tool exchange. */
export function journalDelegatedTasks(records: readonly SessionRecord[], history: Transcript): readonly DelegatedTask[] {
  const writtenItems = new Map(records.filter(record => record.type === "transcript_item")
    .flatMap(record => typeof record.payload.sequence === "number" ? [[record.payload.sequence, record] as const] : []));
  const settled = [...toolCallIndexByResult(history)].flatMap(([resultIndex, callIndex]) => {
    const call = history[callIndex], result = history[resultIndex];
    if (call?.kind !== "tool_call" || result?.kind !== "tool_result" || call.name !== result.name || !DELEGATION_TOOLS.has(call.name)) return [];
    const issued = writtenItems.get(call.sequence), answered = writtenItems.get(result.sequence);
    return issued !== undefined && answered !== undefined && issued.turnId !== undefined && answered.turnId === issued.turnId
      ? [{ id: call.toolCallId, turnId: issued.turnId, issuedAt: issued.sequence, answeredAt: answered.sequence }] : [];
  });
  const tasks = new Map<string, DelegatedTask>();

  for (const record of records) {
    const envelope = journalChildEnvelope(record);
    if (envelope?.kind !== "subagent_spawn") continue;

    const { taskId, subagentId, toolCallId, resumedFrom } = envelope.payload;

    if (!identity(taskId) || !identity(subagentId) || !identity(toolCallId)
      || envelope.attemptId !== `att-root-${toolCallId}`) continue;

    const parent = settled.find(pair => pair.id === toolCallId && pair.turnId === record.turnId
      && pair.issuedAt < record.sequence && pair.answeredAt > record.sequence);
    if (parent === undefined) continue;

    // A stable task can change execution only through an actual continuation.
    const previous = tasks.get(taskId);
    if (previous === undefined ? taskId !== subagentId || resumedFrom !== undefined
      : previous.latest.agentId !== subagentId && resumedFrom !== previous.latest.agentId) continue;

    const execution: DelegatedExecution = { taskId, agentId: subagentId, parentTurnId: parent.turnId,
      parentToolCallId: toolCallId, rootAttemptId: envelope.attemptId, spawnedAt: record.sequence,
      ...(identity(envelope.payload.teamRunId) && identity(envelope.payload.memberId)
        ? { teamMember: { teamRunId: envelope.payload.teamRunId, memberId: envelope.payload.memberId } } : {}) };
    const executions = previous?.executions.filter(item => item.agentId !== subagentId) ?? [];

    tasks.delete(taskId);
    tasks.set(taskId, { latest: execution, executions: [...executions, execution] });
  }

  return [...tasks.values()];
}
