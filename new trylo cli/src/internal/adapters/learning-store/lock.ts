import { randomUUID } from "node:crypto";
import { closeSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { ReasonCode } from "../../learning/control/reasons.js";
import { isLockIoCode, publishStamp, readStamp, type LockStamp } from "./lock-files.js";

export type ProcessStatus = "alive" | "dead" | "unknown";

export type LockStage = "writer_published" | "recovery_intent_published" | "stale_lock_removed" | "release_intent_published";

export type BoardLockOptions = {
  readonly ownerPid?: number;
  readonly createToken?: () => string;
  readonly processStatus?: (pid: number) => ProcessStatus;
  readonly probe?: (pid: number, signal: 0) => unknown;
  /** Atomic-publication seam; unsupported hardlinks fail closed, without wx fallback. */
  readonly link?: (source: string, target: string) => void;
  /** Synchronous fault-injection boundary, never a production policy hook. */
  readonly onStage?: (stage: LockStage) => void;
};

export type LockHandle = { readonly path: string; readonly fd: number };

export type LockErr = {
  readonly ok: false;
  readonly reason: Extract<ReasonCode, "multi_writer" | "board_unavailable">;
  readonly detail: string;
};

type Context = { readonly pid: number; readonly token: () => string; readonly status: (pid: number) => ProcessStatus; readonly options: BoardLockOptions };

type Lease = { readonly stamp: LockStamp; readonly context: Context; held: boolean };

const leases = new WeakMap<LockHandle, Lease>();

/** Cooperative writers only: every unlink is fenced by a complete, unique intent. */
export function tryAcquireLock(lockPath: string, options: BoardLockOptions = {}): LockHandle | LockErr {
  const probe = options.probe ?? process.kill;
  const context: Context = {
    pid: options.ownerPid ?? process.pid,
    token: options.createToken ?? randomUUID,
    status: options.processStatus ?? ((pid) => probeProcess(pid, probe)),
    options,
  };

  try {
    // One stale-owner recovery and one fresh publication; contention belongs to callers.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (hasBlockingIntent(lockPath, context)) return busy(lockPath, "recovery_in_progress");

      const stamp = newStamp(context, "writer");
      const fd = publishStamp(lockPath, stamp, options.link);
      if (fd !== undefined) {
        const handle: LockHandle = { path: lockPath, fd };

        leases.set(handle, { stamp, context, held: true });

        try {
          options.onStage?.("writer_published");
          if (ownsLock(handle)) return handle;
        } catch (error) {
          // Cleanup follows the same intent protocol; propagate the original fault.
          releaseLock(handle);
          throw error;
        }

        releaseLock(handle);

        return busy(lockPath, "publication_fenced");
      }

      const current = readStamp(lockPath);
      if (current.kind === "missing") continue;

      if (current.kind === "invalid") return busy(lockPath, "manual_recovery_required");

      if (current.stamp.role !== "writer") return busy(lockPath, "manual_recovery_required");

      if (statusOf(context, current.stamp.pid) !== "dead") return busy(lockPath, "owner_alive_or_unknown");

      withIntent(lockPath, context, "recovery_intent_published", () => {
        const latest = readStamp(lockPath);
        if (latest.kind !== "valid" || !sameStamp(current.stamp, latest.stamp)) return;
        // Re-probe immediately before unlink. PID reuse errs towards refusing recovery.
        if (statusOf(context, latest.stamp.pid) !== "dead") return;
        unlinkIfPresent(lockPath);
        options.onStage?.("stale_lock_removed");
      });
      // No main-lock operation after this actor's intent was removed.
      // The next iteration is a fresh acquisition, including both fence checks.
    }
    return busy(lockPath, "contention");
  } catch (error) {
    return { ok: false, reason: "board_unavailable", detail: `board_lock_io: ${errorMessage(error)}` };
  }
}

/** Checked synchronously immediately before append/rename, with no intervening await. */
export function ownsLock(handle: LockHandle): boolean {
  const lease = leases.get(handle);
  if (lease?.held !== true) return false;

  try {
    if (hasBlockingIntent(handle.path, lease.context)) return false;
    const current = readStamp(handle.path);
    return current.kind === "valid" && sameStamp(current.stamp, lease.stamp);
  } catch {
    // Ownership cannot be proved; the durable caller returns multi_writer and writes nothing.
    return false;
  }
}

export function lockToken(handle: LockHandle): string {
  return leases.get(handle)?.stamp.token ?? "reader";
}

export function releaseLock(handle: LockHandle): void {
  const lease = leases.get(handle);
  if (lease?.held !== true) return;

  lease.held = false;

  try {
    withIntent(handle.path, lease.context, "release_intent_published", () => {
      const current = readStamp(handle.path);
      if (current.kind === "valid" && sameStamp(current.stamp, lease.stamp)) unlinkIfPresent(handle.path);
    });
  } finally {
    // held is cleared first, so repeated close cannot close a reused numeric descriptor.
    closeSync(handle.fd);
  }
}

function withIntent(lockPath: string, context: Context, stage: LockStage, run: () => void): void {
  const stamp = newStamp(context, "intent");
  const intentPath = `${lockPath}.intent-${stamp.token}`;
  const fd = publishStamp(intentPath, stamp, context.options.link);
  if (fd === undefined) throw new Error("unique Board recovery intent already exists");

  closeSync(fd);

  try {
    context.options.onStage?.(stage);
    run();
  } finally {
    // This immutable nonce path is never reused. No main access is allowed after cleanup.
    unlinkIfPresent(intentPath);
  }
}

function hasBlockingIntent(lockPath: string, context: Context): boolean {
  const prefix = `${path.basename(lockPath)}.intent-`;
  const intents = readdirSync(path.dirname(lockPath)).filter(name => name.startsWith(prefix));
  if (intents.length > 1_024) return true;

  for (const name of intents) {
    const file = path.join(path.dirname(lockPath), name);
    const read = readStamp(file);
    if (read.kind === "missing") continue;

    if (read.kind === "invalid" || read.stamp.role !== "intent" || name !== `${prefix}${read.stamp.token}`) return true;

    if (statusOf(context, read.stamp.pid) !== "dead") return true;

    // A unique dead-owner intent can be removed without a new reclaim guard.
    unlinkIfPresent(file);
  }

  return false;
}

function newStamp(context: Context, role: LockStamp["role"]): LockStamp {
  const token = context.token();
  if (!Number.isSafeInteger(context.pid) || context.pid <= 0 || !/^[a-zA-Z0-9-]{8,128}$/.test(token)) {
    throw new Error("invalid Board lock identity");
  }
  return { formatVersion: 1, role, pid: context.pid, token };
}

function statusOf(context: Context, pid: number): ProcessStatus {
  try {
    const status = context.status(pid);
    return status === "alive" || status === "dead" ? status : "unknown";
  } catch {
    // Permission/probe failures are never evidence of process death.
    return "unknown";
  }
}

function probeProcess(pid: number, probe: (pid: number, signal: 0) => unknown): ProcessStatus {
  try {
    probe(pid, 0);
    return "alive";
  } catch (error) {
    return isLockIoCode(error, "ESRCH") ? "dead" : "unknown";
  }
}

function sameStamp(left: LockStamp, right: LockStamp): boolean {
  return left.role === right.role && left.pid === right.pid && left.token === right.token;
}

function unlinkIfPresent(file: string): void {
  try {
    unlinkSync(file);
  } catch (error) {
    if (!isLockIoCode(error, "ENOENT")) throw error;
  }
}

function busy(file: string, reason: string): LockErr {
  return { ok: false, reason: "multi_writer", detail: `${reason}: ${file}` };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
