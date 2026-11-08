/**
 * One writer per queue file, across processes.
 *
 * Codex's queue service wraps every mutation in a per-thread mutex and calls the
 * result a queue model. That is enough for two coroutines in one process and
 * not enough for two `trylo` processes, which is the entire point of a
 * *background* queue: `trylo queue --message ...` in one terminal while the
 * session it belongs to runs in another. The lock therefore lives in the
 * filesystem, next to the file it protects, and is taken by creating a file that
 * must not already exist (`O_CREAT | O_EXCL`).
 *
 * The alternatives were rejected on evidence rather than taste:
 *
 *  - **Advisory locking** (`flock`/`LockFileEx`) has no portable Node API, so it
 *    would mean a native dependency for a P2 capability.
 *  - **A timestamp-and-steal lock** recovers from a crashed holder, but it also
 *    steals the lock from a *slow* holder — and the holder here is another agent
 *    writing a person's words. Preferring liveness over safety here would trade
 *    a lost message for a lost message.
 *
 * So a lock left behind by a dead process is a *refusal*, not something to guess
 * about, exactly as the permission ledger already does it
 * (`adapters/permission-store/lock.ts`): `queue_locked` says "someone else is
 * writing", and the person can see that and retry. What this file must never do
 * is decide the lock is stale and take it — that is the one behaviour that turns
 * a denial of service into silent corruption.
 */

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export type QueueLock = {
  /**
   * Runs `body` holding the lock, and gives it back whatever happens —
   * including when `body` returns a refusal rather than throwing.
   */
  readonly run: <T>(body: () => Promise<T>) => Promise<T | { readonly ok: false; readonly code: "queue_locked" }>;
  readonly release: () => Promise<void>;
};

/** Held by this process only; released by whoever took it, never by a guesser. */
type Held = { readonly fd: number; readonly lockPath: string };

/**
 * Takes the lock, or reports that someone else holds it.
 *
 * The pid is written into the lock file for one reason: so a human staring at a
 * stuck queue can find out which process to look at. Nothing reads it back for
 * a decision — a pid in a file is not evidence that the process is alive.
 */
function acquire(lockPath: string): { readonly ok: true; readonly held: Held } | { readonly ok: false } {
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true });
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, `${process.pid}\n`);
    return { ok: true, held: { fd, lockPath } };
  } catch {
    return { ok: false };
  }
}

function release(held: Held | undefined): void {
  if (held === undefined) {
    return;
  }

  closeSync(held.fd);

  try {
    unlinkSync(held.lockPath);
  } catch {
    // Releasing a lock we no longer hold is a no-op, not a failure.
  }
}

/**
 * A queue-wide lock, not a per-operation one.
 *
 * One `QueueLock` per queue object, and the same lock object serves every verb —
 * which is what makes the guarantee checkable: two concurrent `enqueue` calls in
 * one process serialise here exactly as two processes' calls do at the file.
 * The cost is that a slow caller delays the next one; the alternative (a lock per
 * call) is the same file contended anyway, and would buy nothing but the
 * *appearance* of concurrency.
 */
export function writerLock(queueFile: string): QueueLock {
  const lockPath = `${queueFile}.lock`;
  let held: Held | undefined;
  let depth = 0;

  return {
    async run<T>(body: () => Promise<T>) {
      if (depth > 0) {
        // Re-entrant call from inside a held operation. The outer one owns the
        // lock and this body is its continuation, so taking it again would
        // deadlock against ourselves.
        depth++;
        try {
          return await body();
        } finally {
          depth--;
        }
      }

      const took = acquire(lockPath);
      if (!took.ok) {
        return { ok: false, code: "queue_locked" } as const;
      }

      held = took.held;
      depth = 1;

      try {
        return await body();
      } finally {
        depth = 0;
        held = undefined;
        release(took.held);
      }
    },
    async release() {
      release(held);
      held = undefined;
      depth = 0;
    },
  };
}

/** Whether the lock file still names this process. Diagnostics only. */
export function lockHeldByThisProcess(lockPath: string): boolean {
  try {
    return readFileSync(lockPath, "utf8").trim() === `${process.pid}`;
  } catch {
    return false;
  }
}
