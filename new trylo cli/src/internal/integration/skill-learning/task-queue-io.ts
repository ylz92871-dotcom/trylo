import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { SkillTaskQueueFailure, SkillTaskQueueResult } from "./task-queue-contract.js";

export const TASK_QUEUE_LIMITS = { maxBytes: 64 * 1024 * 1024, maxRecords: 65536, maxRecordBytes: 65_536 };

export function queueFailure(code: string, message: string): SkillTaskQueueFailure { return { ok: false, code, message }; }

export function queueIoFailure(operation: string, error: unknown): SkillTaskQueueFailure {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "unknown";
  return queueFailure("task_intake_io_failed", `${operation}:${code}`);
}

/** Read from the same open descriptor, allocating at most the configured cap. */
export function readTaskQueueText(file: string, maxBytes: number): SkillTaskQueueResult<{ readonly text: string; readonly bytes: number }> {
  let fd: number | undefined;
  let result: SkillTaskQueueResult<{ readonly text: string; readonly bytes: number }>;

  try {
    fd = openSync(file, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile()) result = queueFailure("task_intake_io_failed", "queue is not a regular file");
    else if (stat.size > maxBytes) result = queueFailure("task_intake_capacity", "bytes");
    else {
      const bytes = Buffer.alloc(stat.size + 1);
      let used = 0, count: number;
      do {
        count = readSync(fd, bytes, used, bytes.length - used, null);
        used += count;
      }
      while (count > 0 && used < bytes.length);
      result = used !== stat.size ? queueFailure("task_intake_changed_during_read", "queue changed while reading")
        : { ok: true, text: bytes.subarray(0, used).toString("utf8"), bytes: used };
    }
  } catch (error) {
    result = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
      ? { ok: true, text: "", bytes: 0 } : queueIoFailure("read", error);
  }

  if (fd !== undefined) {
    try { closeSync(fd); }
    catch (error) { return queueIoFailure("close", error); }
  }

  return result;
}
