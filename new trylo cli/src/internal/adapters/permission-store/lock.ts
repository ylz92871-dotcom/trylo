import { closeSync, openSync, unlinkSync } from "node:fs";
import type { ApprovalConsumptionFailure } from "../../ports/approval-consumption.js";

export type LedgerLockErr = Extract<
  ApprovalConsumptionFailure,
  "ledger_lock_conflict" | "ledger_write_failed"
>;

export type LedgerLock =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly reason: LedgerLockErr; readonly detail: string };

/**
 * Single-writer lock. Acquired immediately before a read-validate-append cycle
 * and released in a `finally`, so a normal return never leaves a stale lock.
 *
 * A process that dies *inside* the critical section leaves the lock file behind;
 * the next consume then reports `ledger_lock_conflict` instead of guessing
 * whether the interrupted append actually happened.
 */
export function tryAcquireLedgerLock(lockPath: string): LedgerLock {
  let fd: number;

  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if (isCode(error, "EEXIST")) {
      return { ok: false, reason: "ledger_lock_conflict", detail: lockPath };
    }
    return { ok: false, reason: "ledger_write_failed", detail: describe(error) };
  }

  return {
    ok: true,
    release() {
      closeSync(fd);
      try {
        unlinkSync(lockPath);
      } catch (error) {
        if (!isCode(error, "ENOENT")) {
          throw error;
        }
      }
    },
  };
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
