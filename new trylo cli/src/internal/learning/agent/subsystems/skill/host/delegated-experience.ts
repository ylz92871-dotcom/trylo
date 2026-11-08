import { createSubagentCheckpointJournal } from "../../../../../adapters/subagent-checkpoints/journal.js";
import type { SessionRecord } from "../../../../../ports/session.js";
import type { JsonObject } from "../../../../../protocol/envelope.js";
import type { TranscriptItem } from "../../../../../protocol/transcript.js";
import { isSubagentObservation } from "../../../../../protocol/subagent-observation.js";
import { delegatedTranscriptExperience } from "./delegated-transcript.js";
import { journalChildEnvelope, type DelegatedTask } from "./journal-delegation.js";
import { delegatedProvidedSkills } from "./provision-observation.js";

/** An end event is a lifecycle observation, never an acceptance verdict. */
function observedTaskEnd(records: readonly SessionRecord[], task: DelegatedTask): JsonObject {
  const latest = task.latest;

  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record === undefined) continue;

    const envelope = journalChildEnvelope(record);
    if (envelope?.kind !== "subagent_end" || envelope.attemptId !== latest.rootAttemptId || record.turnId !== latest.parentTurnId
      || record.sequence <= latest.spawnedAt || envelope.payload.taskId !== latest.taskId || envelope.payload.subagentId !== latest.agentId
      || envelope.payload.toolCallId !== latest.parentToolCallId) continue;

    const status = envelope.payload.status;
    if (status === "completed" || status === "failed" || status === "cancelled" || status === "timed_out") {
      return { terminalObserved: true, terminalStatus: status };
    }
  }

  return { terminalObserved: false };
}

/** Only paired visible tool observations are eligible when a full checkpoint is absent. */
function observationTranscript(records: readonly SessionRecord[], task: DelegatedTask): readonly TranscriptItem[] {
  const calls = new Map<string, Extract<TranscriptItem, { kind: "tool_call" }>>();
  const transcript: TranscriptItem[] = [];

  for (const record of records) {
    const envelope = journalChildEnvelope(record);
    if (envelope?.kind !== "subagent_update" || envelope.payload.taskId !== task.latest.taskId) continue;

    const execution = task.latest;
    if (execution.agentId !== envelope.payload.subagentId || execution.rootAttemptId !== envelope.attemptId
      || execution.parentTurnId !== record.turnId || execution.spawnedAt >= record.sequence) continue;

    const observation = envelope.payload.observation;
    if (!isSubagentObservation(observation) || (observation.kind !== "tool" && observation.kind !== "result")) continue;

    const key = JSON.stringify([execution.agentId, observation.round, observation.id]);

    if (observation.kind === "tool") {
      if (typeof observation.tool !== "string" || observation.input === undefined) continue;
      calls.set(key, { sequence: record.sequence, kind: "tool_call", toolCallId: observation.id,
        name: observation.tool, arguments: observation.input });
    } else {
      const call = calls.get(key);
      calls.delete(key);

      if (call === undefined || observation.tool !== call.name || typeof observation.text !== "string") continue;

      transcript.push(call, { sequence: record.sequence, kind: "tool_result", toolCallId: call.toolCallId, name: call.name,
        output: observation.text, outcome: observation.ok === true ? "succeeded" : "unknown",
        // The observer omits oversized inputs and caps result text near 6000.
        // Conservatively reject long native bodies as complete instruction reads.
        truncated: observation.text.length >= 5940 });
    }
  }

  return transcript;
}

/** Checkpoint decoding remains owned by the existing public canonical adapter. */
export function delegatedTaskExperiences(records: readonly SessionRecord[], sessionId: string, tasks: readonly DelegatedTask[]): readonly JsonObject[] {
  const checkpointRecords = records.filter(record => {
    const envelope = journalChildEnvelope(record);
    if (envelope?.kind !== "observation" || envelope.payload.component !== "checkpoint" || envelope.payload.scope !== "subagent"
      || envelope.attemptId !== `att-checkpoint-${record.turnId}`) return false;

    const rawPart = envelope.payload.checkpointPart;
    if (rawPart === null || typeof rawPart !== "object" || Array.isArray(rawPart)) return false;

    const part = rawPart as JsonObject; // The runtime object guard excludes readonly JSON arrays too.

    return tasks.some(task => task.executions.some(execution => execution.agentId === envelope.payload.subagentId
      && execution.taskId === part.taskId && (part.agentId === undefined || part.agentId === execution.agentId)
      && execution.parentTurnId === record.turnId && execution.spawnedAt < record.sequence));
  });
  const checkpoints = createSubagentCheckpointJournal(checkpointRecords, sessionId, async () => { throw new Error("skill_checkpoint_read_only"); });

  return tasks.map((task): JsonObject => {
    const latest = task.latest, lookup = checkpoints.read(latest.taskId);
    const provision = delegatedProvidedSkills(records, task);
    const lifecycle: JsonObject = { ...observedTaskEnd(records, task),
      lifecycleInterpretation: "A checkpoint may be an in-flight snapshot. A matched runtime end describes lifecycle only, not verified task quality or complete operation coverage." };
    const namespace = { parentSessionId: sessionId, parentTurnId: latest.parentTurnId, parentToolCallId: latest.parentToolCallId,
      rootAttemptId: latest.rootAttemptId, taskId: latest.taskId, agentId: latest.agentId };

    if (lookup.kind === "invalid" || lookup.kind === "ready" && lookup.checkpoint.agentId !== latest.agentId) {
      return { namespace, ...lifecycle, ...provision, source: "checkpoint_unavailable", partial: true,
        interpretation: "Latest checkpoint is invalid or belongs to a different execution; older content was not substituted." };
    }

    if (lookup.kind === "ready") return { namespace, ...lifecycle, ...provision, source: "checkpoint", round: lookup.checkpoint.round, phase: lookup.checkpoint.phase,
      partial: lifecycle.terminalObserved !== true || lookup.checkpoint.phase === "interrupted",
      transcriptScope: "Cumulative stable-task assistant/tool history owned by this checkpoint execution. Child user inputs are withheld; actual assignments remain in parent tool arguments.",
      experience: delegatedTranscriptExperience(lookup.checkpoint.transcript, 12_000) };

    return { namespace, ...lifecycle, ...provision, source: "bounded_observations", partial: true, omittedEarlierExecutions: task.executions.length - 1,
      transcriptScope: "Latest admitted execution tool/result observations only; user inputs are withheld. Local call sequences remain inside this execution namespace.",
      interpretation: "Visible paired tool observations only; text may be truncated and missing data was not reconstructed.",
      experience: delegatedTranscriptExperience(observationTranscript(records, task), 12_000) };
  });
}
