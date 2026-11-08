import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  encodeIdentity,
  readIdentityFile,
  type DaemonIdentity,
} from "../../domain/daemon-identity.js";

/**
 * Where the daemon advertises itself, and what it says when it is asked
 * (WP26 / A04).
 *
 * ## Two files, because they answer different questions
 *
 * - `daemon.json` — **discovery**: pid plus start time. Written once at spawn,
 *   read by every `trylo daemon status`. It is tiny on purpose, because it is read
 *   often and it must be readable even when the daemon is in trouble.
 * - `state.json` — **heartbeat**: last tick and fire count. Written every tick.
 *
 * They are separate because they have opposite failure modes. Discovery must
 * survive a daemon that cannot write its own heartbeat — a daemon wedged in a
 * tick still needs to be *findable* so somebody can stop it. And the heartbeat
 * must never be mistaken for proof of life: a file saying "last tick at T" is
 * evidence about the past, while the identity pair is evidence about now.
 *
 * ## Atomicity, inherited
 *
 * `writeThrough` is the same temporary-file-plus-rename the queue store uses. A
 * reader that catches a half-written heartbeat would otherwise read a truncated
 * JSON and conclude "the daemon is gone" — which is exactly the wrong conclusion
 * during the moment the daemon is busiest.
 */

/** Relative to the one home formula; see `schedule-paths.ts` for the pattern. */
export const DISCOVERY_FILE_REL = "daemon/daemon.json";
export const STATE_FILE_REL = "daemon/state.json";
export const STOP_FILE_REL = "daemon/stop";

/**
 * The stop request's path.
 *
 * ## Why a file and not a signal
 *
 * Measured on this host: a detached win32 daemon **does not receive
 * `SIGTERM`**. Node installs a handler, the log shows nothing happened, and the
 * process keeps running until it is killed — see
 * `evidence/2026-10-07-WP26-review/daemon-entry-e2e.out.txt`, where the daemon
 * advertises itself, fires its schedule, ignores `SIGTERM`, and leaves its
 * discovery record behind. The old CLI has the same shape
 * (`bridge/bridgeMain.ts:2660`), so this is a platform fact rather than a bug
 * somebody introduced.
 *
 * A file is used instead because it works the same on both platforms and needs no
 * channel to be open. The cost is a stat per tick, which is the same order as the
 * heartbeat write the loop already does.
 */
export function stopPath(home: string): string {
  return `${home}/${STOP_FILE_REL}`;
}

/**
 * Leave a stop request for the daemon.
 *
 * The contents carry the reason so the daemon's log can say why it stopped, and a
 * token so a stale file from a previous daemon is not read as a request for this
 * one — a leftover `stop` would otherwise kill the daemon a person just started.
 */
export function requestStop(home: string, reason: string, token: string): boolean {
  return writeThrough(stopPath(home), `${JSON.stringify({ reason, token })}
`);
}

/**
 * A stop request addressed to *this* daemon, if one was left.
 *
 * A file naming a different token is ignored rather than honoured, so a stale
 * request cannot stop the wrong process. Absent is absent: no request, not an
 * error.
 */
export function readStopRequest(home: string, token: string): { readonly reason: string } | undefined {
  let raw: string;

  try {
    raw = readFileSync(stopPath(home), "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  if (record["token"] !== token) {
    return undefined;
  }

  return { reason: typeof record["reason"] === "string" ? record["reason"] : "a stop was requested" };
}

/** Take the stop request back, so it cannot fire twice. */
export function clearStopRequest(home: string): boolean {
  try {
    unlinkSync(stopPath(home));
    return true;
  } catch {
    return false;
  }
}

export function discoveryPath(home: string): string {
  return `${home}/${DISCOVERY_FILE_REL}`;
}

export function statePath(home: string): string {
  return `${home}/${STATE_FILE_REL}`;
}

/**
 * Where the daemon's own stdout/stderr go.
 *
 * The spawner used to hand the child `stdio: "ignore"`, which is the right shape
 * for "do not keep the terminal's pipes open" and the wrong shape for "the child
 * died before it advertised": the reason went nowhere, so `start` could only say
 * "spawned as pid N" about a process that had already failed. Every mature
 * implementation surveyed (codex `pid_start.rs`, gemini's shell service, cline's
 * hub) redirects a detached child's output to a file for exactly this reason.
 */
export const DAEMON_LOG_REL = "daemon/daemon.log";

export function logPath(home: string): string {
  return `${home}/${DAEMON_LOG_REL}`;
}

/**
 * Open the daemon log for appending, creating its directory first.
 *
 * The directory is not a detail: a fresh home has no `daemon/` until the daemon
 * itself writes a record, and a start that must not fail before the child even
 * exists would otherwise die on `ENOENT` here. Lives beside the path it builds
 * because this file owns the daemon's file layout.
 */
export function openLog(home: string): number {
  const file = logPath(home);
  mkdirSync(path.dirname(file), { recursive: true });
  return openSync(file, "a");
}

/**
 * The last `maxBytes` of a log file, or `undefined` if there is nothing to read.
 *
 * Read backwards from the end rather than loading the file: a daemon that
 * looped on an error can leave gigabytes behind, and a failure message that
 * needs all of them to be printed is a second failure.
 */
export function readLogTail(file: string, maxBytes: number): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(file, "r");
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.allocUnsafe(length);
    readSync(descriptor, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } catch {
    // No log yet is a real answer: the child never got as far as writing. The
    // caller says that instead of inventing a cause.
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

/**
 * Write a file atomically, or leave it exactly as it was.
 *
 * Returns whether the write landed. `false` is not a formality: a caller that
 * reported success after a failed heartbeat write would be claiming the daemon
 * ticked when its record says otherwise.
 */
export function writeThrough(file: string, contents: string): boolean {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(temporary, contents, "utf8");
    renameSync(temporary, file);
    return true;
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing to clean up, or the cleanup itself failed; either way the real
      // file was never opened for writing and is still intact.
    }
    return false;
  }
}

/**
 * Advertise the daemon.
 *
 * Written by the parent at spawn, because that is the only moment the start time
 * is known without asking the system — and asking the system costs a PowerShell
 * call (measured 200–600ms here).
 */
export function writeDiscovery(home: string, identity: DaemonIdentity): boolean {
  return writeThrough(discoveryPath(home), encodeIdentity(identity));
}

/** The identity a previous daemon advertised, or `undefined` if none is readable. */
export function readDiscovery(home: string): DaemonIdentity | undefined {
  return readIdentityFile(discoveryPath(home));
}

/** Forget the advertisement. Used by `clear`, never by a health check. */
export function clearDiscovery(home: string): boolean {
  try {
    unlinkSync(discoveryPath(home));
    return true;
  } catch {
    // Already gone is the state `clear` wants.
    return false;
  }
}

/** The heartbeat half: last tick and how much work has been done. */
export type DaemonHeartbeat = {
  readonly lastTickAtMs: number;
  readonly firedCount: number;
};

export function writeHeartbeat(home: string, heartbeat: DaemonHeartbeat): boolean {
  return writeThrough(
    statePath(home),
    `${JSON.stringify({ lastTickAtMs: heartbeat.lastTickAtMs, firedCount: heartbeat.firedCount })}\n`,
  );
}

/**
 * The last heartbeat, or `undefined` when there is none to read.
 *
 * A missing heartbeat is normal before the first tick and after a daemon that
 * crashed without writing one; it is never invented as "now".
 */
export function readHeartbeat(home: string): DaemonHeartbeat | undefined {
  let raw: string;

  try {
    raw = readFileSync(statePath(home), "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const lastTickAtMs = record["lastTickAtMs"];
  const firedCount = record["firedCount"];

  if (typeof lastTickAtMs !== "number" || !Number.isFinite(lastTickAtMs)) {
    return undefined;
  }

  if (typeof firedCount !== "number" || !Number.isFinite(firedCount)) {
    return undefined;
  }

  return { lastTickAtMs, firedCount };
}

/**
 * How stale a heartbeat is, in ticks.
 *
 * Expressed in *intervals* rather than milliseconds, because the interval is the
 * thing that varies: a daemon that ticks every second and one that ticks every
 * minute are both healthy at their own rate, and a fixed millisecond threshold
 * would flag the second one every time.
 */
export function heartbeatsBehind(
  nowMs: number,
  heartbeat: DaemonHeartbeat | undefined,
  intervalMs: number,
): number | null {
  if (heartbeat === undefined || intervalMs <= 0) {
    return null;
  }
  return Math.floor((nowMs - heartbeat.lastTickAtMs) / intervalMs);
}
