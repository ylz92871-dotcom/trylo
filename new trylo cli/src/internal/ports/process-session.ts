/**
 * Long-running process sessions.
 *
 * A command that outlives one tool call is not a tool result — it is a thing
 * that keeps existing after the call returns. This file is the vocabulary for
 * that thing: what a session is, what states it can be in, and what may be done
 * to it.
 *
 * Two things are deliberately *not* here:
 *
 *  - Policy. Whether a command may start at all is decided by the sandbox and
 *    the planner (`adapters/sandbox/**`) before anything reaches this port.
 *  - The terminal. A session has a `tty` flag, but nothing in this file knows
 *    what a terminal is; that is the adapter's business.
 *
 * The lifecycle has exactly three terminal states and no fourth. A session is
 * `running` until the process ends, and then it is `exited` with a code or
 * `failed` with a reason — never "probably finished". A caller that cannot tell
 * those apart would have to guess, and a guess here becomes a wrong claim about
 * the user's machine.
 */

/**
 * Stable, opaque, and meaningful only to this port's implementations. Callers
 * hand it back; they must not parse it or assume it is ordered or reusable.
 */
export type ProcessSessionId = string;

export const PROCESS_SESSION_ID_PREFIX = "ps_";

/**
 * The one id shape, stated on the port side.
 *
 * It used to live only in `adapters/process-session/session-id.ts`, which left a
 * caller that must validate an id *before* the adapter exists (the background-
 * session view, which refuses a malformed id with its own message) one of two bad
 * choices: import an adapter from a port, or copy the regex. The shape is a
 * contract, so it belongs here; the adapter keeps **minting** ids.
 */
export const PROCESS_SESSION_ID_SHAPE = /^ps_[0-9a-f]{24}$/;

export function isProcessSessionIdShape(value: string): boolean {
  return PROCESS_SESSION_ID_SHAPE.test(value);
}

/**
 * `running` is the only non-terminal state. The other three are terminal and a
 * session never leaves one:
 *
 *  - `exited` — the process ended on its own and we know its exit code.
 *  - `failed` — we know it ended but not from its own exit code (a spawn that
 *    never happened, a kill we could not deliver, a sidecar that vanished).
 *  - `lost` — we stopped being able to observe it (the helper died, the session
 *    was reaped from under us). Deliberately *not* `exited`: claiming an exit
 *    code we never saw is how a caller reports "the tests passed" for a run
 *    that was never observed to finish.
 */
export type ProcessSessionStatus = "running" | "exited" | "failed" | "lost";

export const PROCESS_SESSION_TERMINAL_STATUSES: ReadonlyArray<ProcessSessionStatus> = [
  "exited",
  "failed",
  "lost",
];

export function isTerminalProcessStatus(status: ProcessSessionStatus): boolean {
  return status !== "running";
}

/**
 * Why a session stopped where it did. A caller deciding whether to retry, warn,
 * or stay silent needs this, and reading it back out of a message string is
 * how that goes wrong.
 */
export type ProcessSessionEndReason =
  /**
   * The process exited by itself. `exitCode` is meaningful.
   *
   * `signal` is present only when the OS ended it that way, because an exit code
   * the process never chose is a different fact from one it did — and reporting
   * both as the same number would let a caller claim a program chose to fail with
   * -1 when it was in fact terminated.
   */
  | {
      readonly kind: "exited";
      readonly exitCode: number;
      readonly signal?: string;
    }
  /** It never started, or could not be controlled once started. */
  | { readonly kind: "failed"; readonly code: string; readonly message: string }
  /** We lost the ability to observe it; no exit code exists. */
  | { readonly kind: "lost"; readonly reason: string };

export type ProcessSessionSnapshot = {
  /** Logical task that started the command; old/root sessions omit it. */
  readonly ownerId?: string;
  readonly id: ProcessSessionId;
  readonly status: ProcessSessionStatus;
  /** The command as it was asked for, for display. Never re-parsed. */
  readonly command: string;
  readonly cwd: string;
  /** False for the ordinary pipes path; true when a real terminal is attached. */
  readonly tty: boolean;
  /**
   * The OS pid, once there is a process to have one.
   *
   * Added as an optional field so every existing consumer is unaffected. It is
   * what lets `trylo bg` publish a durable record: without a pid, a second process
   * can neither check whether the job is alive nor stop it.
   */
  readonly pid?: number;
  /** Set only once `status` is `exited`. */
  readonly exitCode?: number;
  /** Present for every terminal state, absent while running. */
  readonly end?: ProcessSessionEndReason;
  /** Bytes currently held in the session's output buffer. */
  readonly bufferedBytes: number;
  /** True when output was dropped because a cap was reached, not truncated silently. */
  readonly droppedOutput: boolean;
  readonly startedAtMs: number;
  readonly endedAtMs?: number;
};

/**
 * What a caller asked to start. `tty` is a request, not a promise: an adapter
 * without a terminal reports back that it did not get one rather than silently
 * running without it, because a program that changes behaviour when it has a
 * terminal (progress bars, colour, line editing) would otherwise produce output
 * that lies about the environment it ran in.
 */
export type ProcessSessionStart = {
  readonly ownerId?: string;
  readonly id: ProcessSessionId;
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly tty: boolean;
  readonly rows: number;
  readonly cols: number;
  /** Bytes retained for later reads. Older bytes are dropped past this. */
  readonly maxBufferBytes: number;
};

export type ProcessSessionWrite = {
  readonly sessionId: ProcessSessionId;
  /**
   * The text to send. Empty means "tell me what has happened since last time" —
   * a poll, not input. The distinction matters because writing to a session
   * that has already exited fails, while polling one always answers.
   */
  readonly input: string;
  /** Send EOF on stdin instead of text. */
  readonly eof: boolean;
  /** How long to wait for output before answering with what there is. */
  readonly yieldMs: number;
};

export type ProcessSessionRead = {
  readonly id: ProcessSessionId;
  /** Only bytes produced after the previous read; a cursor, not a replay. */
  readonly output: string;
  /** True when more output exists past `output` and the caps are trimming. */
  readonly truncated: boolean;
  readonly status: ProcessSessionStatus;
  readonly end?: ProcessSessionEndReason;
  /** Bytes still held but not returned, because a cap cut them. */
  readonly bufferedBytes: number;
};

export type ProcessSessionWriteResult =
  | { readonly ok: true; readonly read: ProcessSessionRead }
  | {
      readonly ok: false;
      readonly code:
        | "session_not_found"
        | "session_finished"
        | "session_write_failed"
        | "session_tty_unsupported";
      readonly message: string;
      /** Present when the session exists but is already terminal. */
      readonly end?: ProcessSessionEndReason;
    };

export type ProcessSessionStopResult =
  | { readonly ok: true; readonly end: ProcessSessionEndReason }
  | {
      readonly ok: false;
      readonly code: "session_not_found" | "session_stop_failed";
      readonly message: string;
      readonly end?: ProcessSessionEndReason;
    };

export type ProcessSessionList = {
  readonly sessions: ReadonlyArray<ProcessSessionSnapshot>;
};

/** Codex's bounds, kept because they are the ones worth agreeing with. */
export const MIN_PROCESS_YIELD_MS = 250;
export const MAX_PROCESS_YIELD_MS = 30_000;
/** An empty write is a poll, and a poll that returns instantly invites a spin loop. */
export const MIN_PROCESS_POLL_YIELD_MS = 1_000;
export const DEFAULT_PROCESS_MAX_BUFFER_BYTES = 1_048_576;
/** Without a ceiling, one chatty process can hold every byte it ever prints. */
export const MAX_PROCESS_BUFFER_BYTES = 1_048_576;

/**
 * Fail closed on a yield the caller could not have meant: 0 would answer before
 * anything happened, and 10 minutes would hold a turn hostage. Both are refused
 * rather than clamped, so a model that asks for one learns it asked wrong.
 */
export function readYieldMs(value: unknown, fallback: number): number | undefined {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.trunc(value);
}

export function yieldMsWithinBounds(value: number): boolean {
  return value >= MIN_PROCESS_YIELD_MS && value <= MAX_PROCESS_YIELD_MS;
}

export function clampBufferBytes(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 1), MAX_PROCESS_BUFFER_BYTES);
}
