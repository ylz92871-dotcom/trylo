import type {
  ProcessSessionId,
  ProcessSessionList,
  ProcessSessionSnapshot,
  ProcessSessionStopResult,
  ProcessSessionWrite,
  ProcessSessionWriteResult,
} from "./process-session.js";
import { isProcessSessionIdShape } from "./process-session.js";

/**
 * What the background-session view needs from a registry.
 *
 * Stated structurally here rather than imported from `adapters/process-session`
 * because a port may not lean on an adapter (the architecture gate enforces it,
 * and had it as a hole in this file until now). Anything with these four methods
 * answers — the pipes registry, the PTY registry, or a test double.
 */
export type BackgroundSessionPipes = {
  readonly list: () => ProcessSessionList;
  readonly get: (sessionId: ProcessSessionId) => ProcessSessionSnapshot | undefined;
  readonly write: (request: ProcessSessionWrite) => Promise<ProcessSessionWriteResult>;
  readonly stop: (sessionId: ProcessSessionId) => Promise<ProcessSessionStopResult>;
};

/**
 * Background sessions as a person addresses them (WP26 / A04).
 *
 * ## What this is, and what it is deliberately not
 *
 * Old CLI's `claude ps | logs | attach | kill` was a second, independent notion of
 * "a running command" — its own registry under `~/.claude/sessions/`, with the
 * directory missing on this checkout. This package already has the real thing
 * (`adapters/process-session/**`, from WP06/WP07): one registry, bounded output
 * buffers, a process-tree kill, and a PTY path.
 *
 * So this file is an **addressing layer**, not a second registry. It translates
 * between four verbs a person uses and the one registry that holds the facts. A
 * second registry would be the exact failure ADR §5 names: "同一主机少量共享执行
 * owner，不按十项另建十套后台总管".
 *
 * ## The four verbs, and what each one is honest about
 *
 * - `ps` lists what is running. It reads the registry; it never polls the process
 *   table, because the registry is already the authority and a second probe could
 *   disagree with it.
 * - `logs` reads the buffer. **`droppedOutput` travels with the answer** — a
 *   truncated log that looks complete is how a person concludes a program printed
 *   nothing when it printed a megabyte.
 * - `attach` *watches*, it does not take over. There is no second reader of a
 *   running session's input; `attach` is a bounded read with a cursor, which is
 *   what `tail -f` is, and what an interactive takeover would have to be to be
 *   safe with a session another agent may also be watching.
 * - `kill` goes through the registry's `stop`, so the process **tree** goes and
 *   Windows' `cmd.exe`-leaves-grandchildren problem stays solved in one place.
 */

/** How much of a session's history a person may ask to read at once. */
export const MAX_LOG_BYTES = 256 * 1024;

/**
 * Why a background-session operation was refused.
 *
 * `session_gone` is not an error in the tool sense: it is what a person sees when
 * they typed an id for something that finished. It has its own code because
 * "not found" and "refused" lead to different next steps.
 */
export type BackgroundSessionFailureCode =
  | "session_not_found"
  /**
   * The registry has no record at all. Distinct from a session that exists and
   * has ended, which is a *result* rather than a refusal.
   */
  | "session_gone"
  | "not_readable"
  | "write_failed"
  | "stop_failed"
  | "invalid_id";

export type BackgroundSessionRefusal = {
  readonly ok: false;
  readonly code: BackgroundSessionFailureCode;
  readonly message: string;
};

/**
 * One row of `ps`.
 *
 * A projection of the registry's snapshot, not a copy of it — the registry stays
 * the owner, and a field added there appears here rather than needing to be added
 * in two places.
 */
export type BackgroundSessionRow = {
  readonly id: ProcessSessionId;
  readonly status: string;
  readonly command: string;
  readonly cwd: string;
  readonly tty: boolean;
  readonly exitCode?: number;
  readonly end?: string;
  readonly startedAtMs: number;
  readonly endedAtMs?: number;
  readonly bufferedBytes: number;
  readonly droppedOutput: boolean;
};

/** One `logs` answer. */
export type BackgroundSessionLogs = {
  readonly id: ProcessSessionId;
  readonly status: string;
  /** False when the whole buffer was returned; true when `text` starts mid-stream. */
  readonly truncatedFromStart: boolean;
  /** True when output was dropped because the cap was reached, not trimmed quietly. */
  readonly droppedOutput: boolean;
  readonly text: string;
  readonly cursor: number;
};

export type BackgroundSessionResult<T> =
  | { readonly ok: true; readonly value: T }
  | BackgroundSessionRefusal;

/**
 * How a session ended, in one word.
 *
 * The port's own union distinguishes four endings, and each of them is
 * something a person needs to tell apart: a program that chose to exit with 1 is
 * not a program that was terminated, and neither is one that never started.
 */
function describeEnd(end: {
  readonly kind: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly code?: string;
  readonly message?: string;
}): string {
  switch (end.kind) {
    case "exited":
      return `exited ${end.exitCode ?? "?"}${end.signal === undefined ? "" : ` (signal ${end.signal})`}`;
    case "failed":
      return `failed: ${end.code ?? "unknown"}`;
    case "lost":
      return "lost (the helper died before it could be observed)";
    default:
      return end.kind;
  }
}

/**
 * Whether this string could name a session.
 *
 * Delegated to the registry's own predicate rather than a second copy. A looser
 * rule here would let a well-formed-but-nonexistent id through this layer's check
 * and fail one lookup later — which is the quiet failure the id module's comment
 * warns about: the message a person sees would be "no such session" rather than
 * "that is not a session id", and the two send them looking in different places.
 */
export function isSessionId(value: string): boolean {
  return isProcessSessionIdShape(value);
}

function rowOf(snapshot: ProcessSessionSnapshot): BackgroundSessionRow {
  return {
    id: snapshot.id,
    status: snapshot.status,
    command: snapshot.command,
    cwd: snapshot.cwd,
    tty: snapshot.tty,
    ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
    // The ending is a union, not a code: "exited with 1" and "failed to spawn"
    // are different facts and flattening them to one string would lose which.
    ...(snapshot.end === undefined ? {} : { end: describeEnd(snapshot.end) }),
    startedAtMs: snapshot.startedAtMs,
    ...(snapshot.endedAtMs === undefined ? {} : { endedAtMs: snapshot.endedAtMs }),
    bufferedBytes: snapshot.bufferedBytes,
    droppedOutput: snapshot.droppedOutput,
  };
}

/**
 * Everything running, newest first.
 *
 * Newest first because the question being asked is "what did I just start", and
 * because a list ordered by insertion has the oldest — usually the least relevant
 * — at the top.
 */
export function backgroundSessions(
  registry: BackgroundSessionPipes,
): BackgroundSessionResult<ReadonlyArray<BackgroundSessionRow>> {
  const listed = registry.list();
  const rows = [...listed.sessions]
    .sort((left, right) => right.startedAtMs - left.startedAtMs)
    .map(rowOf);
  return { ok: true, value: rows };
}

/**
 * One session's row, whatever state it is in.
 *
 * A session that has ended is still a **valid answer**, not a refusal. The
 * question `ps <id>` asks is "what happened to this", and "it exited 3 twenty
 * seconds ago" is the answer — refusing there would make it impossible to look
 * up how a job ended without re-reading its logs, and would train people to treat
 * a reported exit code as an error.
 *
 * `session_not_found` is reserved for the one case that really is a refusal: the
 * registry has no record of this id at all, because it never existed or was
 * reaped past the cap.
 */
export function backgroundSession(
  registry: BackgroundSessionPipes,
  sessionId: string,
): BackgroundSessionResult<BackgroundSessionRow> {
  if (!isSessionId(sessionId)) {
    return {
      ok: false,
      code: "invalid_id",
      message: `'${sessionId}' is not a session id`,
    };
  }

  const snapshot = registry.get(sessionId);
  if (snapshot === undefined) {
    return {
      ok: false,
      code: "session_not_found",
      message: `no background session ${sessionId}; it never ran, or it was reaped`,
    };
  }

  return { ok: true, value: rowOf(snapshot) };
}

/**
 * Stop one session, taking its process tree with it.
 *
 * Delegated rather than reimplemented: the tree walk and the Windows
 * grandchild problem live in one place (WP07), and a second `kill` would be a
 * second answer to "did it actually die".
 *
 * `session_not_found` from the registry is reported as **success**, because it
 * means the session is not running — which is the state the caller asked for.
 * Reporting it as a failure would make "kill a finished job" look like an error
 * and train people to add `|| true`, which would then hide real failures.
 */
export async function killBackgroundSession(
  registry: BackgroundSessionPipes,
  sessionId: string,
): Promise<BackgroundSessionResult<{ readonly alreadyGone: boolean }>> {
  if (!isSessionId(sessionId)) {
    return { ok: false, code: "invalid_id", message: `'${sessionId}' is not a session id` };
  }

  const stopped = await registry.stop(sessionId);
  if (stopped.ok) {
    return { ok: true, value: { alreadyGone: false } };
  }

  if (stopped.code === "session_not_found") {
    return { ok: true, value: { alreadyGone: true } };
  }

  return { ok: false, code: "stop_failed", message: stopped.message };
}

/**
 * Watch a session's output without taking it over (the `logs`/`attach` half).
 *
 * `attach` is a **bounded read with a cursor**, not an interactive takeover.
 * That is a deliberate limit rather than a missing feature: a second reader of a
 * running session's input would race the agent that started it, and the person who
 * typed into the wrong place would not find out until the command did something
 * unexpected. Reading is safe; typing is not, and `logs` is the safe half.
 *
 * The read goes through `write` with empty input, because that is the registry's
 * own poll — a second mechanism for "has anything happened" would drift from the
 * first on the very question (what is still buffered) where drift is hardest to
 * notice.
 */
export async function readBackgroundSession(
  registry: BackgroundSessionPipes,
  sessionId: string,
  options: { readonly yieldMs: number; readonly maxBytes?: number },
): Promise<BackgroundSessionResult<BackgroundSessionLogs>> {
  if (!isSessionId(sessionId)) {
    return { ok: false, code: "invalid_id", message: `'${sessionId}' is not a session id` };
  }

  const snapshot = registry.get(sessionId);
  if (snapshot === undefined) {
    return {
      ok: false,
      code: "session_not_found",
      message: `no background session ${sessionId}; it may have finished and been reaped`,
    };
  }

  const written = await registry.write({
    sessionId,
    input: "",
    eof: false,
    yieldMs: options.yieldMs,
  });
  if (!written.ok) {
    // A session that ended between the lookup and the read still has its output;
    // the refusal names which case this was so a caller can say something true.
    // `session_finished` is not a failure for a *reader* — the output is there,
    // it just came with the ending attached.
    if (written.code === "session_not_found") {
      return {
        ok: false,
        code: "session_not_found",
        message: `no background session ${sessionId}; it may have finished and been reaped`,
      };
    }

    if (written.code === "session_finished") {
      return {
        ok: true,
        value: {
          id: sessionId,
          status: "exited",
          truncatedFromStart: snapshot.droppedOutput,
          droppedOutput: snapshot.droppedOutput,
          text: "",
          cursor: snapshot.bufferedBytes,
        },
      };
    }

    return { ok: false, code: "write_failed", message: written.message };
  }

  return {
    ok: true,
    value: {
      id: sessionId,
      status: written.read.status,
      // The registry says so rather than this layer guessing from a byte count: a
      // buffer that dropped bytes and one that was read in full are different
      // facts, and only the owner knows which happened.
      truncatedFromStart: written.read.truncated,
      droppedOutput: snapshot.droppedOutput,
      text: written.read.output,
      cursor: written.read.bufferedBytes,
    },
  };
}

/** One line for `ps`, aligned so the ids line up. */
export function renderRow(row: BackgroundSessionRow, nowMs: number): string {
  const age = row.endedAtMs === undefined ? nowMs - row.startedAtMs : row.endedAtMs - row.startedAtMs;
  const state = row.exitCode === undefined ? row.status : `${row.status}(${row.exitCode})`;
  const flags = [
    row.tty ? "tty" : null,
    row.droppedOutput ? "output-dropped" : null,
    row.bufferedBytes > 0 ? `${row.bufferedBytes}B buffered` : null,
  ].filter((flag) => flag !== null);

  return `${row.id.padEnd(24)} ${state.padEnd(14)} ${formatDuration(age).padStart(8)}  ${row.command}${
    flags.length === 0 ? "" : `  [${flags.join(", ")}]`
  }`;
}

/**
 * A human duration.
 *
 * Two units, because the interesting cases are "just started" and "been running
 * for hours"; `1h 04m 03s` is noise in a list.
 *
 * Sub-second is shown as `0.4s` rather than `0s`. A session that started 400ms ago
 * is *not* the same fact as one that started exactly now, and rounding both to
 * `0s` in a list that already reads "running" is how a freshly-started job looks
 * like a stalled one.
 */
export function formatDuration(ms: number): string {
  if (ms < 0) {
    return "0s";
  }

  if (ms < 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  }

  const hours = Math.floor(minutes / 60);

  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

export { MAX_LOG_BYTES as MAX_BACKGROUND_LOG_BYTES };
export type { ProcessSessionId };
