import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { splitLines } from "./codec.js";
import { acquireWriterLock, ownsWriterLock, releaseWriterLock, type ProcessStatus, type WriterLock } from "./writer-lock.js";

/**
 * The filesystem mechanics of the NDJSON session journal: the writer lock, the
 * append, the raw read, and the one repair that is allowed to remove bytes.
 *
 * Split out of `ndjson.ts` so that file can stay about *what the session port
 * promises* while this one is about *how bytes reach the disk*. Three rules are
 * load-bearing and are the reason these functions are small and separate:
 *
 *  - **Single writer, proven not assumed.** `held` records whether *this*
 *    instance took the lock. Existence of the lock file alone would let any
 *    second writer append as soon as someone else held it, which is the
 *    opposite of a single-writer guarantee. Only the owner token releases a
 *    lock; a guarded recovery may reclaim a provably dead process's lock.
 *  - **Every append is fsynced before it is acknowledged**, so a crash cannot
 *    leave a record the process believed was durable.
 *  - **Repair is a truncation to the last newline, never a rewrite of earlier
 *    records.** The bytes kept are handed in by the caller, which is where the
 *    decision about *what* is a torn tail lives.
 */

export type NdjsonStoreConfig = {
  readonly path: string;
  readonly lockPath?: string;
  readonly ownerPid?: number;
  readonly ownerToken?: string;
  readonly processStatus?: (pid: number) => ProcessStatus;
};

export type JournalIo = {
  readonly file: string;
  readonly lockPath: string;
  readonly writerLock: WriterLock;
  /** Whether *this* instance took the lock. See the module comment. */
  held: boolean;
  /** Cursor belongs only to this locked writer; reads/recovery still decode the full journal. */
  position?: { readonly sequence: number; readonly size: number; readonly modifiedMs: number; readonly tornTail: boolean } | undefined;
};

export type LockOutcome = { ok: true } | { ok: false; code: string };

export function createJournalIo(config: NdjsonStoreConfig): JournalIo {
  const lockPath = config.lockPath ?? `${config.path}.lock`;
  return {
    file: config.path,
    lockPath,
    writerLock: { path: lockPath, identity: { pid: config.ownerPid ?? process.pid, token: config.ownerToken ?? randomUUID() },
      processStatus: config.processStatus ?? processStatus },
    held: false,
  };
}

export function journalExists(io: JournalIo): boolean {
  return existsSync(io.file);
}

/**
 * The sessions directory is the store's own business: without it the writer
 * lock cannot be taken and every run would look like a conflict.
 */
export function ensureJournalDirectory(io: JournalIo): boolean {
  try {
    mkdirSync(path.dirname(io.file), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(io: JournalIo): LockOutcome {
  if (!acquireWriterLock(io.writerLock)) return { ok: false, code: "lock_conflict" };
  io.held = true;
  io.position = undefined;
  return { ok: true };
}

/** Held by us, and the lock file is still the one we wrote. */
export function stillHoldingLock(io: JournalIo): boolean {
  return io.held && ownsWriterLock(io.writerLock);
}

export function releaseLock(io: JournalIo): void {
  if (!io.held) {
    return;
  }
  io.held = false;
  io.position = undefined;
  releaseWriterLock(io.writerLock);
}

function processStatus(pid: number): ProcessStatus {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return "dead";
    return "unknown"; // Permission errors and reused live PIDs never authorize reclamation.
  }
}

export function readJournalRaw(io: JournalIo): string {
  return existsSync(io.file) ? readFileSync(io.file, "utf8") : "";
}

/** Re-scan after external file changes or repairs, otherwise advance the owned cursor. */
export function journalPosition(io: JournalIo): { readonly sequence: number; readonly tornTail: boolean } {
  const current = journalExists(io) ? statSync(io.file) : undefined;
  const size = current?.size ?? 0;
  const modifiedMs = current?.mtimeMs ?? 0;
  if (io.position === undefined || io.position.size !== size || io.position.modifiedMs !== modifiedMs) {
    const { lines, tornTail } = splitLines(readJournalRaw(io));
    io.position = { sequence: lines.length, size, modifiedMs, tornTail };
  }

  return io.position;
}

export function appendJournalLine(io: JournalIo, text: string): boolean {
  try {
    const handle = openSync(io.file, "a");

    try {
      writeSync(handle, text);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }

    if (io.position !== undefined) {
      const current = statSync(io.file);
      io.position = { sequence: io.position.sequence + 1, size: current.size, modifiedMs: current.mtimeMs, tornTail: false };
    }

    return true;
  } catch {
    // A failed write may have left a partial tail; the next append must inspect it.
    io.position = undefined;
    return false;
  }
}

/**
 * Replaces the journal with `kept` and fsyncs it. Used only by the torn-tail
 * repair, and only ever with a prefix of what was already there.
 */
export function rewriteJournal(io: JournalIo, kept: string): boolean {
  io.position = undefined;
  try {
    writeFileSync(io.file, kept);
    const handle = openSync(io.file, "r+");

    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }

    return true;
  } catch {
    return false;
  }
}
