import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import {
  JOB_LOG_MAX_BYTES,
  JOB_LOG_READ_MAX_BYTES,
  JOB_RETENTION_MS,
  JOBS_DIR_REL,
  type BackgroundJobRead,
  type BackgroundJobRecord,
  type BackgroundJobStart,
  type JobStore,
} from "../../ports/background-job.js";
import type { ProcessSessionEndReason, ProcessSessionId } from "../../ports/process-session.js";
import { isTerminalProcessStatus } from "../../ports/process-session.js";

/**
 * The job table on disk (WP26 / A04): `~/.trylo/jobs/<id>/{job.json,output.log}`.
 *
 * This is the **only** module allowed to write those files. The rule it exists to
 * enforce is a shape this repo has been caught by twice: a second writer with a
 * second opinion about the same lifecycle. So the registry publishes through here,
 * `trylo bg` reads through here, and neither carries its own idea of where a job
 * record lives.
 *
 * ## Why the log is not inherited stdio
 *
 * Handing the child a file descriptor would survive the owner's death, but the
 * registry's output buffer is what the model reads, and the buffer is fed by the
 * pipes. So the owner tees each chunk here instead, and the record says plainly
 * that `droppedOutput` is the owner's account. The cost is stated: if the owner
 * dies, the log stops growing while the job may still be running — which is what
 * `lost` is for.
 */
export type JobStoreOptions = {
  /**
   * Where the table lives, relative to nothing else: pass `tryloHome(...)`.
   */
  readonly home: string;
  /**
   * The clock. Optional with a seam default, the same shape `session-registry.ts`
   * uses, so the ambient read lives in exactly one recognised place.
   */
  readonly now?: () => number;
  /** The starting process. Read at the seam, never at a call site. */
  readonly ownerPid?: number;
  readonly maxLogBytes?: number;
  readonly readMaxBytes?: number;
  readonly retentionMs?: number;
};

type Writer = {
  fd: number;
  bytes: number;
  dropped: boolean;
};

export function jobsDir(home: string): string {
  return `${home}/${JOBS_DIR_REL}`;
}

function jobDir(home: string, id: ProcessSessionId): string {
  return `${jobsDir(home)}/${id}`;
}

function recordFile(home: string, id: ProcessSessionId): string {
  return `${jobDir(home, id)}/job.json`;
}

function logFile(home: string, id: ProcessSessionId): string {
  return `${jobDir(home, id)}/output.log`;
}

/**
 * Is this decoded JSON a job record?
 *
 * Persistence read boundaries validate rather than cast: a truncated file, a hand
 * edit, or a future format must produce an `unreadable` answer, not an object with
 * `undefined` where a pid should be.
 */
function isRecord(value: unknown): value is BackgroundJobRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.pid === "number" &&
    typeof record.ownerPid === "number" &&
    typeof record.command === "string" &&
    typeof record.cwd === "string" &&
    typeof record.startedAtMs === "number" &&
    (record.status === "running" ||
      record.status === "exited" ||
      record.status === "failed" ||
      record.status === "lost") &&
    typeof record.logPath === "string" &&
    typeof record.logBytes === "number" &&
    typeof record.droppedOutput === "boolean"
  );
}

function publishAtomic(file: string, text: string, ownerPid: number, seq: number): boolean {
  const dir = path.dirname(file);
  try {
    mkdirSync(dir, { recursive: true });
    // `wx` on a name only this process can invent: two writers for the same record
    // stay separate until the rename, so a reader never sees a partial file.
    const temp = `${file}.${ownerPid}.${seq}.tmp`;
    const fd = openSync(temp, "w");

    try {
      writeFileSync(fd, text, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    renameSync(temp, file);

    try {
      // fsyncing the directory is what makes the rename survive a crash. win32
      // cannot open a directory for sync, and that is a platform fact rather than
      // a failed contract: the file itself is already durable.
      const dirFd = openSync(dir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Best-effort on Windows; the record is published either way.
    }

    return true;
  } catch {
    // A record that cannot be written must not be reported as written: `bg ps`
    // then honestly shows fewer jobs than the owner thinks it started.
    return false;
  }
}

export function createJobStore(options: JobStoreOptions): JobStore {
  const ownerPid = options.ownerPid ?? process.pid;
  const now = options.now ?? ((): number => Date.now());
  const maxLogBytes = options.maxLogBytes ?? JOB_LOG_MAX_BYTES;
  const readMaxBytes = options.readMaxBytes ?? JOB_LOG_READ_MAX_BYTES;
  const retentionMs = options.retentionMs ?? JOB_RETENTION_MS;
  const writers = new Map<ProcessSessionId, Writer>();
  const published = new Map<ProcessSessionId, BackgroundJobRecord>();
  let seq = 0;

  function write(record: BackgroundJobRecord): boolean {
    seq += 1;
    const file = recordFile(options.home, record.id);
    const ok = publishAtomic(file, `${JSON.stringify(record)}\n`, ownerPid, seq);
    if (ok) {
      published.set(record.id, record);
    }

    return ok;
  }

  function read(id: ProcessSessionId): BackgroundJobRead {
    let text: string;

    try {
      text = readFileSync(recordFile(options.home, id), "utf8");
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "unreadable";
      return {
        ok: false,
        code,
        detail: code === "missing" ? "no job record for this id" : `cannot read the job record: ${String(error)}`,
      };
    }

    let decoded: unknown;

    try {
      decoded = JSON.parse(text);
    } catch (error: unknown) {
      // Half-written, edited, or from a format this build does not know. Saying so
      // beats returning a record with an undefined pid.
      return { ok: false, code: "unreadable", detail: `the job record is not decodable: ${String(error)}` };
    }

    if (!isRecord(decoded)) {
      return { ok: false, code: "unreadable", detail: "the job record does not match its shape" };
    }

    return { ok: true, record: decoded, raw: text };
  }

  return {
    publish(start: BackgroundJobStart): boolean {
      if (published.has(start.id)) {
        // Restarting the same id is a different process; a second running record
        // would be a second truth. The owner must mint a new id.
        return false;
      }

      const record: BackgroundJobRecord = {
        id: start.id,
        pid: start.pid,
        ownerPid,
        command: start.command,
        cwd: start.cwd,
        startedAtMs: start.startedAtMs,
        status: "running",
        logPath: logFile(options.home, start.id),
        logBytes: 0,
        droppedOutput: false,
      };
      if (!write(record)) {
        return false;
      }

      try {
        // Created eagerly so `bg logs <id>` can say "no output yet" instead of
        // "there is no such job".
        const fd = openSync(record.logPath, "wx");
        closeSync(fd);
      } catch {
        // Already there (a retried id) or the directory is not writable; the
        // append path opens on demand either way.
      }

      return true;
    },

    append(id: ProcessSessionId, chunk: Buffer): void {
      let writer = writers.get(id);
      if (writer === undefined) {
        try {
          const fd = openSync(logFile(options.home, id), "a");
          const existing = statSync(logFile(options.home, id)).size;
          writer = { fd, bytes: existing, dropped: false };
          writers.set(id, writer);
        } catch {
          // No log file and no way to open one: the session keeps running with its
          // in-memory buffer, which is what it did before this table existed.
          return;
        }
      }

      if (writer.bytes + chunk.length > maxLogBytes) {
        // Said once, in the record, rather than silently truncating: a log that
        // looks complete when it is not is how a person concludes a command
        // printed nothing after it printed a megabyte.
        writer.dropped = true;
        const known = published.get(id);
        if (known !== undefined && !known.droppedOutput) {
          write({ ...known, droppedOutput: true });
        }

        return;
      }

      try {
        writeSync(writer.fd, chunk);
        writer.bytes += chunk.length;
      } catch {
        // The descriptor went away (swept, unmounted). Drop it; the next append
        // reopens, and the in-memory buffer is still feeding the model.
        writers.delete(id);
      }
    },

    settle(id: ProcessSessionId, end: ProcessSessionEndReason): boolean {
      let base = published.get(id);
      if (base === undefined) {
        const found = read(id);
        base = found.ok ? found.record : undefined;
      }

      if (base === undefined) {
        return false;
      }

      const writer = writers.get(id);
      const endedAtMs = now();
      const record: BackgroundJobRecord = {
        ...base,
        status: end.kind,
        endedAtMs,
        logBytes: writer?.bytes ?? base.logBytes,
        droppedOutput: writer?.dropped ?? base.droppedOutput,
        ...(end.kind === "exited" ? { exitCode: end.exitCode } : {}),
        ...(end.kind === "exited" && end.signal !== undefined ? { signal: end.signal } : {}),
        ...(end.kind === "failed" ? { failure: `${end.code}: ${end.message}` } : {}),
      };
      const ok = write(record);

      // Nothing will ever append to this id again.
      writers.delete(id);
      published.delete(id);

      return ok;
    },

    read,

    readOutput(id: ProcessSessionId) {
      return readLogTail(logFile(options.home, id), readMaxBytes);
    },

    list(): ReadonlyArray<BackgroundJobRead> {
      let names: ReadonlyArray<string>;

      try {
        names = readdirSync(jobsDir(options.home));
      } catch {
        // No jobs directory is the normal state on a machine that has never run a
        // background command.
        return [];
      }

      const reads = names.filter((name) => !name.startsWith(".")).map((name) => read(name));
      const byNewest = (a: BackgroundJobRead, b: BackgroundJobRead): number => {
        const left = a.ok ? a.record.startedAtMs : Number.NEGATIVE_INFINITY;
        const right = b.ok ? b.record.startedAtMs : Number.NEGATIVE_INFINITY;
        return right - left;
      };

      return reads.sort(byNewest);
    },

    markLost(id: ProcessSessionId, expectedRaw: string): boolean {
      const fresh = read(id);
      if (!fresh.ok || fresh.raw !== expectedRaw) {
        // Someone wrote between our read and now — almost always the owner
        // reporting a real exit. Its answer is better than ours, so we do nothing.
        return false;
      }

      const record: BackgroundJobRecord = {
        ...fresh.record,
        status: "lost",
        // `endedAtMs` and `exitCode` stay absent on purpose: we observed the
        // *absence of the process*, not an ending.
      };

      seq += 1;

      return publishAtomic(recordFile(options.home, id), `${JSON.stringify(record)}\n`, ownerPid, seq);
    },

    sweep(nowMs: number): number {
      let removed = 0;

      for (const entry of this.list()) {
        if (!entry.ok || !isTerminalProcessStatus(entry.record.status)) {
          // A running job is never swept, and an unreadable one is left where it is
          // so `bg ps` can still report that something is wrong with it.
          continue;
        }

        const ended = entry.record.endedAtMs ?? entry.record.startedAtMs;
        if (nowMs - ended <= retentionMs) {
          continue;
        }

        try {
          rmSync(jobDir(options.home, entry.record.id), { recursive: true, force: true });
          removed += 1;
        } catch {
          // A job we cannot delete is reported by the next `ps`, not hidden by a
          // sweep that pretends it succeeded.
        }
      }

      return removed;
    },
  };
}

/**
 * The last `maxBytes` of a job's log, or a refusal.
 *
 * Reads backwards from the end so a chatty job cannot turn `bg logs` into a memory
 * problem, and refuses anything that is not a regular file: the surveyed tail
 * readers reach for `O_NOFOLLOW`, which is not portable to win32, so the check is
 * made on the stat instead.
 */
export function readLogTail(
  file: string,
  maxBytes: number = JOB_LOG_READ_MAX_BYTES,
): { readonly ok: true; readonly text: string; readonly truncatedFromStart: boolean } | { readonly ok: false; readonly detail: string } {
  let info;

  try {
    info = lstatSync(file);
  } catch (error: unknown) {
    return { ok: false, detail: `no output log at ${file}: ${String(error)}` };
  }

  if (!info.isFile()) {
    return { ok: false, detail: `${file} is not a regular file, so its output is not read` };
  }

  const size = info.size;
  const length = Math.min(size, maxBytes);
  let fd: number | undefined;

  try {
    fd = openSync(file, "r");
    const buffer = Buffer.allocUnsafe(length);
    readSync(fd, buffer, 0, length, size - length);
    return { ok: true, text: buffer.toString("utf8"), truncatedFromStart: size > length };
  } catch (error: unknown) {
    return { ok: false, detail: `cannot read ${file}: ${String(error)}` };
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}
