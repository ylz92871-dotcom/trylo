import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The single-writer lease for the scheduler (WP26 / A06).
 *
 * ## Why a lease and not a lock file
 *
 * The reused source (`utils/cronTasksLock.ts`) used `O_EXCL` plus a PID
 * liveness probe: if the lock's PID was gone, unlink it and take the lock. That
 * recovers from a crash, and it also steals the lock from a holder that is
 * **slow** — and the holder here is another `trylo` writing a person's
 * scheduled work. Worse, PID liveness is not identity: PIDs are reused, so a
 * live-but-unrelated process can keep a dead scheduler's lock alive, and a dead
 * one can be mistaken for the owner.
 *
 * So the lease carries three things instead:
 *
 *  - an **owner id**, chosen by the caller, so "who" is answerable without
 *    guessing from a pid;
 *  - an opaque **token**, which every write must present, so a process that lost
 *    the lease cannot keep writing — the fencing property, and the thing that
 *    makes a stale holder harmless rather than merely discouraged;
 *  - the pid, written for a human staring at a stuck scheduler and read back by
 *    nobody for a decision.
 *
 * A token is compared, never guessed. This is the same refusal the queue lock
 * already makes (`adapters/queue-store/queue-writer.ts`): a lock left by an
 * unknown holder is `not_owner`, not something to take over. Recovery from a
 * genuinely dead owner is the *host's* decision — it can see that the daemon is
 * gone — and this file only ever hands out the facts needed to make it.
 */

export type LeaseState =
  | { readonly held: false }
  | {
      readonly held: true;
      readonly ownerId: string;
      readonly token: string;
      readonly pid: number;
      readonly acquiredAtMs: number;
    };

export type LeaseIo = {
  readonly now: () => number;
  readonly newToken: () => string;
};

/**
 * Read the lease. An absent or unparseable file reads as **not held**, because
 * an unreadable lock is exactly the case where taking the lease is the only way
 * to make progress — but the caller is told nothing was held, so a scheduler that
 * was actually running finds out that it lost the lease rather than continuing
 * to believe it holds one.
 */
export function readLease(lockPath: string): LeaseState {
  let raw: string;

  try {
    raw = readFileSync(lockPath, "utf8");
  } catch {
    return { held: false };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return { held: false };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { held: false };
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record["ownerId"] !== "string" || typeof record["token"] !== "string") {
    return { held: false };
  }

  return {
    held: true,
    ownerId: record["ownerId"],
    token: record["token"],
    pid: typeof record["pid"] === "number" ? record["pid"] : -1,
    acquiredAtMs: typeof record["acquiredAtMs"] === "number" ? record["acquiredAtMs"] : 0,
  };
}

/**
 * Take the lease, or report who holds it.
 *
 * `O_EXCL` (`wx`) is the atomic test-and-set; there is no read-then-write window
 * for two processes to slip through.
 */
export function acquireLease(
  lockPath: string,
  ownerId: string,
  pid: number,
  io: LeaseIo,
): { readonly ok: true; readonly token: string } | { readonly ok: false; readonly held: LeaseState } {
  const existing = readLease(lockPath);
  if (existing.held) {
    return { ok: false, held: existing };
  }

  const token = io.newToken();
  const body = JSON.stringify(
    { ownerId, token, pid, acquiredAtMs: io.now() },
    null,
    2,
  );

  try {
    mkdirSync(path.dirname(lockPath), { recursive: true });
    const handle = openSync(lockPath, "wx");

    try {
      writeFileSync(handle, body);
    } finally {
      closeSync(handle);
    }

    return { ok: true, token };
  } catch {
    // Another process won the create between the read and the write. Reporting
    // the refusal is correct; deciding the winner's lease is stale is not ours.
    return { ok: false, held: readLease(lockPath) };
  }
}

/**
 * Give the lease back, but only if we still hold it.
 *
 * The ownership check is the point: a process that lost the lease and then exited
 * must not delete the *new* holder's lease on its way out, which would hand the
 * scheduler to whoever asked next while two processes believe they own it.
 */
export function releaseLease(
  lockPath: string,
  ownerId: string,
  token: string,
): { readonly released: true } | { readonly released: false; readonly reason: string } {
  const current = readLease(lockPath);
  if (!current.held) {
    return { released: true };
  }

  if (current.ownerId !== ownerId || current.token !== token) {
    return {
      released: false,
      reason: `lease belongs to ${current.ownerId}; not removing another owner's lease`,
    };
  }

  try {
    unlinkSync(lockPath);
  } catch {
    // Already gone — the desired state either way.
  }

  return { released: true };
}

/** Whether the lease file still names this owner. Diagnostics only. */
export function leaseHeldBy(lockPath: string, ownerId: string, token: string): boolean {
  const current = readLease(lockPath);
  return current.held && current.ownerId === ownerId && current.token === token;
}
