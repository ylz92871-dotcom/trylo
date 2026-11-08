import type { CliContext } from "./context.js";
import { formatDuration } from "../../ports/background-session.js";
import type { BackgroundJobRecord, JobStore } from "../../ports/background-job.js";
import type { ProcessSessionId } from "../../ports/process-session.js";
import type { TreeTermination } from "../../adapters/process-session/process-tree.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";

/**
 * Shared vocabulary for `trylo bg` (WP26 / A04).
 *
 * This module owns only what every bg verb needs the same answer for: whether
 * a recorded pid is still the process it claims to be, and how a row reads.
 * Each verb keeps its own handler file, so a change to `kill` cannot drift the
 * meaning of `ps`.
 */

/** What a second terminal can find out about a recorded pid. */
export type JobLiveness = "alive" | "gone" | "unverifiable";

export type BackgroundDeps = {
  readonly jobs: JobStore;
  /**
   * Is this record still the process it says it is?
   *
   * Injected because the honest answer on win32 costs 200–600 ms per process
   * (a PowerShell identity probe), and a test must be able to say "gone" without
   * waiting for a pid to be recycled by the OS.
   */
  readonly liveness: (record: BackgroundJobRecord) => Promise<JobLiveness>;
  /** Ending a tree by pid. Overridable so the refusal paths are testable without killing anything. */
  readonly killPid?: (pid: number) => Promise<TreeTermination>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly followIntervalMs?: number;
  /** Whether a `follow` should keep going; injected so a test can end it. */
  readonly shouldContinue?: () => boolean;
};

export type JobResolve =
  | { readonly ok: true; readonly record: BackgroundJobRecord; readonly unverified: boolean }
  | { readonly ok: false; readonly reason: string };

/**
 * Read a record, resolving the one disagreement a second terminal can have with
 * the disk: the table says `running`, the process table says it is gone.
 *
 * The correction is a compare-and-set on the bytes we just read. If it fails,
 * somebody wrote in between — near always the owner, whose answer is a real exit
 * code and beats ours.
 */
export async function resolveJob(deps: BackgroundDeps, id: ProcessSessionId): Promise<JobResolve> {
  const found = deps.jobs.read(id);
  if (!found.ok) {
    return { ok: false, reason: `${found.detail} (looked for ${id})` };
  }

  if (found.record.status !== "running") {
    return { ok: true, record: found.record, unverified: false };
  }

  const live = await deps.liveness(found.record);
  if (live === "alive") {
    return { ok: true, record: found.record, unverified: false };
  }

  if (live === "unverifiable") {
    // "The machine would not tell me" is its own answer: not running-confirmed,
    // and not gone. Collapsing it into either is how a supervisor convinces itself.
    return { ok: true, record: found.record, unverified: true };
  }

  deps.jobs.markLost(id, found.raw);
  const again = deps.jobs.read(id);

  return again.ok
    ? { ok: true, record: again.record, unverified: false }
    : { ok: false, reason: `the record for ${id} changed while it was being marked lost` };
}

export function renderJobRow(record: BackgroundJobRecord, nowMs: number, unverified = false): string {
  const took = record.endedAtMs ?? nowMs;
  const tail = record.droppedOutput ? " (output truncated)" : "";
  const outcome =
    record.status === "exited"
      ? `exit ${record.exitCode ?? "?"}${record.signal === undefined ? "" : ` signal ${record.signal}`}`
      : record.status === "failed"
        ? `failed: ${record.failure ?? "unknown"}`
        : record.status === "lost"
          ? "lost (no exit code was observed)"
          : `running as pid ${record.pid}${unverified ? " (identity unverifiable)" : ""}`;

  return `${record.id}  ${pad(record.status, 7)}  ${formatDuration(Math.max(0, took - record.startedAtMs)).padStart(7)}  ${outcome.padEnd(34)} ${record.command}${tail}`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

/** Said when a log read returns the tail rather than the whole file. */
export const TRUNCATED_NOTICE = "[earlier output was dropped past the read cap]\n";

/** One spelling for "the id resolved to nothing usable". */
export function refuseUnknownJob(ctx: CliContext, reason: string): ExitCode {
  ctx.stderr(`${reason}\n`);
  return EXIT_CODES.USAGE;
}

/** One spelling for "the record exists but its log cannot be read". */
export function refuseUnreadableOutput(ctx: CliContext, detail: string): ExitCode {
  ctx.stderr(`${detail}\n`);
  return EXIT_CODES.TEMPORARY;
}
