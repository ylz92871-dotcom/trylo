import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { canonicalJson } from "../../learning/control/hash.js";
import { releaseLock, tryAcquireLock, type LockHandle } from "../../adapters/learning-store/lock.js";
import type { SkillTaskQueueEntry, SkillTaskQueueEvent, SkillTaskQueueOptions, SkillTaskQueueOutcome, SkillTaskQueueResult } from "./task-queue-contract.js";
import { integer, keys, parseTaskQueueInput, parseTaskQueueOutcome, record, skillTaskQueueKey, text } from "./task-queue-parse.js";
import { queueFailure, queueIoFailure, readTaskQueueText, TASK_QUEUE_LIMITS } from "./task-queue-io.js";
import { decodeTaskQueueLog, encodeTaskQueueEvent, type SkillTaskQueueLog } from "./task-queue-log.js";

export type { SkillTaskQueueEntry, SkillTaskQueueInput, SkillTaskQueueOptions, SkillTaskQueueOutcome } from "./task-queue-contract.js";
export { skillTaskQueueKey } from "./task-queue-parse.js";

export const SKILL_TASK_QUEUE_FILE = "task-intake.ndjson";
export const SKILL_TASK_QUEUE_LOCK = "task-intake.lock";

type Status = SkillTaskQueueResult<{ readonly status: "recorded" | "duplicate" | "disabled" }>;

type Claim = SkillTaskQueueResult<{ readonly status: "claimed" | "already_claimed" | "waiting" | "disabled"; readonly entry?: SkillTaskQueueEntry }>;

type Pending = SkillTaskQueueResult<{ readonly entries: readonly SkillTaskQueueEntry[]; readonly totalPending: number; readonly blocked: number }>;

/** Facts awaiting journal-backed extraction, never assets or permission grants.
 * An extraction attempt is claimed durably before the provider is called.
 */
export function createSkillTaskQueue(options: SkillTaskQueueOptions) {
  const limits = queueLimits(options.limits), maxAttempts = options.maxAttempts ?? 3;
  if (!integer(maxAttempts, 1, 8) || !text(options.workspaceId, 512)) throw new Error("task_intake_invalid_options");

  const file = path.join(options.root, SKILL_TASK_QUEUE_FILE), lock = path.join(options.root, SKILL_TASK_QUEUE_LOCK);
  const read = (): SkillTaskQueueResult<SkillTaskQueueLog> => {
    const raw = readTaskQueueText(file, limits.maxBytes);
    return raw.ok ? decodeTaskQueueLog(raw.text, options.workspaceId, limits) : raw;
  };
  const append = (log: SkillTaskQueueLog, event: SkillTaskQueueEvent): Status => {
    if (options.collection() === "disabled") return { ok: true, status: "disabled" };
    const encoded = encodeTaskQueueEvent(log, event), bytes = Buffer.byteLength(encoded, "utf8");
    if (log.sequence >= limits.maxRecords || log.bytes + bytes > limits.maxBytes || bytes > limits.maxRecordBytes) return queueFailure("task_intake_capacity", "append");
    appendFileSync(file, encoded, "utf8");
    return { ok: true, status: "recorded" };
  };
  const mutate = <T extends { readonly status: string }>(run: (log: SkillTaskQueueLog) => SkillTaskQueueResult<T>): SkillTaskQueueResult<T | { readonly status: "disabled" }> => {
    if (options.collection() === "disabled") return { ok: true, status: "disabled" };

    let held: LockHandle;

    try {
      mkdirSync(options.root, { recursive: true });
      const acquired = tryAcquireLock(lock);
      if ("ok" in acquired) return queueFailure("task_intake_locked", acquired.detail);
      held = acquired;
    } catch (error) { return queueIoFailure("lock", error); }

    let result: SkillTaskQueueResult<T | { readonly status: "disabled" }>;

    try {
      const log = options.collection() === "disabled" ? undefined : read();
      result = log === undefined ? { ok: true, status: "disabled" } : log.ok ? run(log) : log;
    } catch (error) { result = queueIoFailure("write", error); }

    try { releaseLock(held); }
    catch (error) { return queueIoFailure("lock_release", error); }

    return result;
  };

  return {
    enqueue(raw: unknown): SkillTaskQueueResult<{ readonly status: "queued" | "duplicate" | "disabled"; readonly key?: string }> {
      if (options.collection() === "disabled") return { ok: true, status: "disabled" };

      const task = parseTaskQueueInput(raw, options.workspaceId);
      if (task === undefined) return queueFailure("task_intake_invalid", "invalid recovery metadata");

      const key = skillTaskQueueKey(task);
      const result = mutate(log => {
        const previous = log.entries.get(key);
        if (previous !== undefined) return canonicalJson(previous.task) === canonicalJson(task) ? { ok: true, status: "duplicate" as const }
          : queueFailure("task_intake_conflict", key);
        return append(log, { kind: "enqueue", key, task, maxAttempts });
      });

      return result.ok ? { ok: true, status: result.status === "recorded" ? "queued" : result.status, key } : result;
    },

    pending(input: { readonly limit: number; readonly maxBytes?: number; readonly retryRevision?: string; readonly includeRecovery?: boolean }): Pending {
      if (options.collection() === "disabled") return { ok: true, entries: [], totalPending: 0, blocked: 0 };

      if (!record(input) || !integer(input.limit, 0, 128) || (input.maxBytes !== undefined && !integer(input.maxBytes, 1, 1_048_576))
        || (input.retryRevision !== undefined && !text(input.retryRevision, 512))
        || (input.includeRecovery !== undefined && typeof input.includeRecovery !== "boolean")) return queueFailure("task_intake_invalid", "invalid pending allowance");

      if (input.limit === 0) return { ok: true, entries: [], totalPending: 0, blocked: 0 };

      const log = read();
      if (!log.ok) return log;

      const entries: SkillTaskQueueEntry[] = [];
      const unfinished = [...log.entries.values()].filter(entry => entry.state !== "processed");
      // Recovery-only rows must not occupy every bounded slot forever and
      // prevent unrelated fresh tasks from reaching the model allowance.
      const ordered = [...unfinished.filter(entry => retryable(entry, input.retryRevision)),
        ...unfinished.filter(entry => !retryable(entry, input.retryRevision))];
      let blocked = 0, bytes = 0;

      for (const entry of ordered) {
        const canClaim = retryable(entry, input.retryRevision);
        if (!canClaim) blocked += 1;

        // Inspection cannot spend another attempt. It allows the runtime to
        // reconcile a fact already committed on the last permitted attempt.
        if (!canClaim && !(input.includeRecovery === true && entry.state === "running")) continue;

        const size = Buffer.byteLength(canonicalJson(entry), "utf8");
        if (entries.length >= input.limit || bytes + size > (input.maxBytes ?? 262_144)) continue;

        entries.push(entry);
        bytes += size;
      }

      return { ok: true, entries, totalPending: unfinished.length, blocked };
    },

    claim(key: string, input: { readonly retryRevision: string }): Claim {
      if (options.collection() === "disabled") return { ok: true, status: "disabled" };

      if (!text(key, 128) || !record(input) || !keys(input, ["retryRevision"]) || !text(input.retryRevision, 512)) return queueFailure("task_intake_invalid", "claim needs task key and grant revision");

      return mutate(log => {
        const entry = log.entries.get(key);
        if (entry === undefined) return queueFailure("task_intake_missing", key);

        if (entry.lastRevision === input.retryRevision) return { ok: true, status: "already_claimed" as const, entry };

        if (!retryable(entry, input.retryRevision)) return { ok: true, status: "waiting" as const, entry };

        const event: SkillTaskQueueEvent = { kind: "claim", key, attempt: entry.attempt + 1, retryRevision: input.retryRevision };
        const result = append(log, event);

        return result.ok ? result.status === "disabled" ? { ok: true, status: "disabled" as const }
          : { ok: true, status: "claimed" as const, entry: { ...entry, state: "running" as const, attempt: event.attempt, lastRevision: input.retryRevision } } : result;
      });
    },

    ack(key: string, input: { readonly attempt: number; readonly retryRevision: string; readonly result: SkillTaskQueueOutcome }): Status {
      if (options.collection() === "disabled") return { ok: true, status: "disabled" };

      if (!text(key, 128) || !record(input) || !keys(input, ["attempt", "retryRevision", "result"]) || !integer(input.attempt, 1, 8) || !text(input.retryRevision, 512)) return queueFailure("task_intake_invalid", "invalid acknowledgement identity");

      const result = parseTaskQueueOutcome(input.result);
      if (result === undefined) return queueFailure("task_intake_invalid", "invalid extraction result");

      return mutate(log => {
        const entry = log.entries.get(key);
        if (entry === undefined) return queueFailure("task_intake_missing", key);
        if (entry.attempt !== input.attempt || entry.lastRevision !== input.retryRevision) return queueFailure("task_intake_stale_ack", key);
        if (entry.state !== "running") return outcomeMatches(entry, result) ? { ok: true, status: "duplicate" as const } : queueFailure("task_intake_conflict", "terminal result differs");
        return append(log, { kind: "settle", key, attempt: input.attempt, retryRevision: input.retryRevision, result });
      });
    },
  };
}

function retryable(entry: SkillTaskQueueEntry, revision: string | undefined): boolean {
  return entry.state !== "processed" && entry.attempt < entry.maxAttempts && (entry.state === "queued" || (revision !== undefined && revision !== entry.lastRevision));
}

function outcomeMatches(entry: SkillTaskQueueEntry, result: SkillTaskQueueOutcome): boolean {
  return entry.state === result.kind && (result.kind === "processed" ? entry.experienceId === result.experienceId && entry.experienceHash === result.experienceHash : entry.lastFailure === result.reason);
}

function queueLimits(input: SkillTaskQueueOptions["limits"]) {
  const choose = (value: number | undefined, cap: number) => {
    if (value === undefined) return cap;
    if (!integer(value, 1, cap)) throw new Error("task_intake_invalid_limits");
    return value;
  };
  return { maxBytes: choose(input?.maxBytes, TASK_QUEUE_LIMITS.maxBytes), maxRecords: choose(input?.maxRecords, TASK_QUEUE_LIMITS.maxRecords), maxRecordBytes: choose(input?.maxRecordBytes, TASK_QUEUE_LIMITS.maxRecordBytes) };
}
