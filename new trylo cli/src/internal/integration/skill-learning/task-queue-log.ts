import { canonicalJson, sha256Hex } from "../../learning/control/hash.js";
import type { SkillTaskQueueEntry, SkillTaskQueueEvent, SkillTaskQueueResult } from "./task-queue-contract.js";
import { integer, keys, parseTaskQueueEvent, record, text } from "./task-queue-parse.js";
import { queueFailure } from "./task-queue-io.js";

export type SkillTaskQueueLog = {
  readonly entries: Map<string, SkillTaskQueueEntry>;
  readonly sequence: number;
  readonly checksum: string;
  readonly bytes: number;
};

export function encodeTaskQueueEvent(log: SkillTaskQueueLog, event: SkillTaskQueueEvent): string {
  const payload = { schemaVersion: 1, sequence: log.sequence + 1, previousChecksum: log.checksum, event };
  return `${canonicalJson({ ...payload, checksum: sha256Hex(canonicalJson(payload)) })}\n`;
}

export function decodeTaskQueueLog(raw: string, workspaceId: string, limits: { maxRecords: number; maxRecordBytes: number }): SkillTaskQueueResult<SkillTaskQueueLog> {
  const entries = new Map<string, SkillTaskQueueEntry>();
  let sequence = 0, checksum = "0".repeat(64);

  if (raw.length > 0 && !raw.endsWith("\n")) return queueFailure("task_intake_corrupt", "incomplete final event");

  const lines = raw.length === 0 ? [] : raw.slice(0, -1).split("\n");
  if (lines.length > limits.maxRecords) return queueFailure("task_intake_capacity", "records");

  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") + 1 > limits.maxRecordBytes) return queueFailure("task_intake_capacity", "record_bytes");

    let value: unknown;

    try { value = JSON.parse(line); }
    catch { return queueFailure("task_intake_corrupt", "invalid JSON event"); }

    if (!record(value) || !keys(value, ["schemaVersion", "sequence", "previousChecksum", "event", "checksum"])
      || value.schemaVersion !== 1 || !integer(value.sequence, 1) || value.sequence !== sequence + 1
      || value.previousChecksum !== checksum || !text(value.checksum, 64)) return queueFailure("task_intake_corrupt", "invalid event identity");

    const event = parseTaskQueueEvent(value.event, workspaceId);
    if (event === undefined) return queueFailure("task_intake_corrupt", "invalid event metadata");

    const payload = { schemaVersion: 1, sequence: value.sequence, previousChecksum: value.previousChecksum, event };
    if (sha256Hex(canonicalJson(payload)) !== value.checksum) return queueFailure("task_intake_corrupt", "event checksum mismatch");

    const reduced = reduceTaskQueueEvent(entries.get(event.key), event);
    if (reduced === undefined) return queueFailure("task_intake_corrupt", "illegal event transition");

    entries.set(event.key, reduced);
    sequence = value.sequence;
    checksum = value.checksum;
  }

  return { ok: true, entries, sequence, checksum, bytes: Buffer.byteLength(raw, "utf8") };
}

function reduceTaskQueueEvent(previous: SkillTaskQueueEntry | undefined, event: SkillTaskQueueEvent): SkillTaskQueueEntry | undefined {
  if (event.kind === "enqueue") return previous === undefined
    ? { key: event.key, task: event.task, state: "queued", attempt: 0, maxAttempts: event.maxAttempts } : undefined;

  if (previous === undefined || previous.state === "processed") return undefined;

  if (event.kind === "claim") {
    if (event.attempt !== previous.attempt + 1 || event.attempt > previous.maxAttempts || previous.lastRevision === event.retryRevision) return undefined;
    return { ...previous, state: "running", attempt: event.attempt, lastRevision: event.retryRevision };
  }

  if (previous.state !== "running" || event.attempt !== previous.attempt || event.retryRevision !== previous.lastRevision) return undefined;

  return event.result.kind === "processed" ? { ...previous, state: "processed", experienceId: event.result.experienceId,
    ...(event.result.experienceHash === undefined ? {} : { experienceHash: event.result.experienceHash }) }
    : { ...previous, state: event.result.kind, lastFailure: event.result.reason };
}
