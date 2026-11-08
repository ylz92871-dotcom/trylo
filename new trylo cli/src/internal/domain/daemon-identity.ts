import { readFileSync } from "node:fs";

/**
 * Daemon process identity (WP26 / A04, and the discovery half of A05).
 *
 * ## Why a pid is not an identity
 *
 * Windows recycles process ids. A daemon that recorded only its pid can, after a
 * reboot or a busy afternoon, find that its pid now belongs to somebody else's
 * process — and then either fail to notice it died or, worse, report itself
 * healthy while talking to a stranger. `kill(pid, 0)` cannot tell the two apart.
 *
 * Codex solves this with the same pair this module uses: `pid` **and**
 * `process_start_time` (`codex-rs/app-server-daemon/src/backend/pid.rs:43`, and
 * the comparisons at `:168` and `:555`). The rule is one line: the identity holds
 * only while both halves match.
 *
 * ## How the start time is obtained, and what that costs
 *
 * Measured on this machine (win32, Node v22.22.2 — see
 * `evidence/2026-10-07-WP26-review/process-identity.out.txt`):
 *
 *  - Node's standard library exposes **no** process start time. `process.report`
 *    has no such header, and `process.uptime()` is self-relative so it cannot be
 *    compared against another reading.
 *  - `Win32_Process.CreationDate` via PowerShell **works**, returning an ISO
 *    timestamp to sub-second precision.
 *  - `wmic process get CreationDate` does **not** work on this host (absent or
 *    blocked), so it is not an alternative.
 *  - That query costs roughly 200–600 ms per call.
 *
 * The cost is why the start time is **written at spawn time by the parent**, which
 * knows it from `Date.now()`, and only *verified* on demand. A daemon never polls
 * its own record; a discovery query verifies one candidate. That keeps a
 * 200–600 ms system call off every tick.
 *
 * ## What verification degrades to
 *
 * {@link DaemonIdentityProbe} is a seam, and the default implementation accepts an
 * injected verifier. A caller that cannot verify (no PowerShell on a stripped
 * image) gets `unverifiable` — which is **not** the same answer as `matching`.
 * Reporting "alive" from the pid alone would defeat the entire reason this file
 * exists, so the unverifiable case is surfaced and the caller decides.
 */

/** Stable identity of one daemon process. Both halves are required. */
export type DaemonIdentity = {
  readonly pid: number;
  /**
   * Epoch milliseconds when this process started.
   *
   * Recorded by the parent at spawn. On Windows the OS-reported value has
   * sub-second precision, so a mismatch within a second is rounding and not a
   * different process; see {@link START_TIME_TOLERANCE_MS}.
   */
  readonly startedAtMs: number;
};

/**
 * How far apart two start times may be and still count as the same process.
 *
 * The parent writes `Date.now()` truncated to a millisecond; the OS reports
 * `CreationDate` at a precision that varies by platform. A one-second window is
 * comfortably wider than the rounding and far narrower than the gap between two
 * processes that reuse a pid.
 */
export const START_TIME_TOLERANCE_MS = 1_000;

/**
 * What checking a recorded identity against the live system found.
 *
 * Three answers, not two: `unverifiable` is the one that must not be collapsed
 * into `matching`, because a caller that treats it as "alive" is exactly the
 * defect this module was written to prevent.
 */
export type IdentityVerdict =
  | { readonly verdict: "matching" }
  | { readonly verdict: "gone"; readonly reason: string }
  | { readonly verdict: "unverifiable"; readonly reason: string };

/** Whether this record's two halves could plausibly describe the same process. */
export function identityMatches(recorded: DaemonIdentity, observed: DaemonIdentity): boolean {
  if (recorded.pid !== observed.pid) {
    return false;
  }
  return Math.abs(recorded.startedAtMs - observed.startedAtMs) <= START_TIME_TOLERANCE_MS;
}

/**
 * The check a caller performs against the live system.
 *
 * Injected rather than imported, so a test can state "the process is gone" or
 * "the system will not tell us" without a real process table, and so a platform
 * without a start-time reader has somewhere to plug its own answer in.
 */
export type DaemonIdentityProbe = {
  /**
   * Resolve the identity of `pid` right now.
   *
   * Returning `undefined` means "no such process", which is a different answer
   * from throwing and must not be reported as "cannot tell".
   */
  readonly observe: (pid: number) => Promise<DaemonIdentity | undefined>;
};

/**
 * Decide whether a recorded daemon is still the daemon.
 *
 * `gone` when the pid is absent **or** the pid is present but was started at a
 * different time — a reused pid is a stranger, and treating it as "still running"
 * is how a supervisor reports a healthy daemon that died an hour ago.
 */
export async function verifyIdentity(
  recorded: DaemonIdentity,
  probe: DaemonIdentityProbe,
): Promise<IdentityVerdict> {
  let observed: DaemonIdentity | undefined;

  try {
    observed = await probe.observe(recorded.pid);
  } catch (error: unknown) {
    // One `catch` with one stated outcome: the system would not answer, which is
    // not evidence of anything. Re-throwing would abort a supervisor's poll over
    // one unanswerable query.
    return {
      verdict: "unverifiable",
      reason: `the process table could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (observed === undefined) {
    return { verdict: "gone", reason: `no process with pid ${recorded.pid}` };
  }

  if (!identityMatches(recorded, observed)) {
    return {
      verdict: "gone",
      reason:
        `pid ${recorded.pid} is now a different process ` +
        `(started ${new Date(observed.startedAtMs).toISOString()}, ` +
        `recorded ${new Date(recorded.startedAtMs).toISOString()})`,
    };
  }

  return { verdict: "matching" };
}

/**
 * Read a recorded identity from a discovery file.
 *
 * Returns `undefined` for anything that does not typecheck. A discovery file that
 * cannot be read means "no daemon is advertised", which the caller treats as
 * "not running" — so a corrupt file must not become a crash on the read path, and
 * must not become a fabricated identity either.
 */
export function decodeIdentity(raw: string): DaemonIdentity | undefined {
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
  if (typeof record["pid"] !== "number" || !Number.isInteger(record["pid"]) || record["pid"] <= 0) {
    return undefined;
  }

  const startedAtMs = record["startedAtMs"];
  if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs) || startedAtMs <= 0) {
    return undefined;
  }

  return { pid: record["pid"], startedAtMs };
}

/** Read a discovery file, tolerating absence. */
export function readIdentityFile(file: string): DaemonIdentity | undefined {
  try {
    return decodeIdentity(readFileSync(file, "utf8"));
  } catch {
    // ENOENT is the ordinary "no daemon" answer, and an unreadable one is not
    // allowed to become a fabricated identity, so both land here.
    return undefined;
  }
}

/** Render an identity for a discovery file. Stable field order, one line. */
export function encodeIdentity(identity: DaemonIdentity): string {
  return `${JSON.stringify({ pid: identity.pid, startedAtMs: identity.startedAtMs })}\n`;
}

/**
 * Whether the discovered daemon is the one this caller started.
 *
 * Absent is the interesting case: a discovery file naming somebody else's daemon
 * is normal (another terminal started it), so the answer is "not mine" rather than
 * an error. The caller can then either use it or start its own, and that choice
 * is deliberately not made here.
 */
export function isOwnDaemon(discovered: DaemonIdentity | undefined, mine: DaemonIdentity): boolean {
  return discovered !== undefined && identityMatches(mine, discovered);
}
