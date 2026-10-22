import { type ChildProcess, spawn } from "node:child_process";
import { publishSessionsTo, type SessionJobs } from "./session-job-publication.js";

import {
  type ProcessSessionEndReason,
  type ProcessSessionId,
  type ProcessSessionList,
  type ProcessSessionSnapshot,
  type ProcessSessionStart,
  type ProcessSessionStatus,
  type ProcessSessionStopResult,
  type ProcessSessionWrite,
  type ProcessSessionWriteResult,
  clampBufferBytes,
  isTerminalProcessStatus,
} from "../../ports/process-session.js";
import { type BoundedBuffer, createBoundedBuffer } from "./output-buffer.js";
import { attachSessionOutput } from "./session-output.js";
import { type TreeTermination, terminateProcessTree } from "./process-tree.js";
import { isProcessSessionIdShape, newProcessSessionId } from "./session-id.js";

/**
 * Long-running sessions over ordinary pipes.
 *
 * This is the transport for everything that does not need a real terminal:
 * a watch task, a server, a REPL that reads lines. It is deliberately *not*
 * the PTY path (see `pty-session.ts`) because the two fail differently — a
 * pipe child that outlives its parent leaves a handle to a dead process, while
 * a PTY child holds a console — and one type that pretends they are the same
 * would have to answer both cases with whichever answer was written first.
 *
 * What this owns: the map from id to live session, each session's terminal
 * state, and the cursor into its output. What it does not own: whether the
 * command may run (the sandbox decided), and how bytes reach the process (the
 * spawner).
 */

/**
 * Without a ceiling, one process that prints forever holds every byte it ever
 * printed. Codex caps its own at 1 MiB; this matches it rather than inventing
 * a number, and the cap is declared to the caller instead of applied quietly.
 */
const DEFAULT_MAX_BUFFER_BYTES = 1_048_576;

/** How much a single read returns, independent of how much the session holds. */
const DEFAULT_MAX_READ_BYTES = 65_536;

/**
 * How long a stop waits for the process to report its own ending before giving
 * up and saying the ending was not observed. Long enough for Windows to deliver
 * a kill, short enough that a user pressing stop is not left waiting.
 */
const STOP_GRACE_MS = 2_000;

type SessionRecord = {
  readonly id: ProcessSessionId;
  readonly child: ChildProcess;
  readonly command: string;
  readonly cwd: string;
  readonly tty: boolean;
  readonly startedAtMs: number;
  readonly buffer: BoundedBuffer;
  status: ProcessSessionStatus;
  end?: ProcessSessionEndReason;
  endedAtMs?: number;
  /** Resolvers waiting for "something changed or time is up". */
  waiters: Set<() => void>;
};

export type ProcessSessionRegistry = {
  start(start: ProcessSessionStart): Promise<ProcessSessionSnapshot>;
  write(request: ProcessSessionWrite): Promise<ProcessSessionWriteResult>;
  stop(sessionId: ProcessSessionId): Promise<ProcessSessionStopResult>;
  list(): ProcessSessionList;
  get(sessionId: ProcessSessionId): ProcessSessionSnapshot | undefined;
  /** Drain live trees; reject if any OS termination was refused. */
  shutdown(): Promise<void>;
  readonly maxSessions: number;
};

export type ProcessSessionRegistryOptions = {
  /** Refuse a start beyond this many live sessions rather than evicting one. */
  readonly maxSessions?: number;
  /** The durable job table to mirror into, if one is wired (WP26 / A04). */
  readonly jobs?: SessionJobs;
  readonly maxBufferBytes?: number;
  readonly maxReadBytes?: number;
  /** Injectable so lifecycle tests need not depend on a real clock. */
  readonly now?: () => number;
  /** Exercise teardown failures without pretending the OS accepted a kill. */
  readonly terminate?: (child: ChildProcess) => Promise<TreeTermination>;
};

function describeArgv(argv: ReadonlyArray<string>): string {
  return argv.join(" ");
}

function sessionNotFound(id: string): string {
  return `no process session with id ${id}; it may have finished and been reaped`;
}

/**
 * Windows kills `cmd.exe` and leaves grandchildren holding the inherited
 * stdio. Reporting that honestly matters more than reporting it quickly: a
 * caller that stops a session and is told "stopped" would then wait forever for
 * output that a surviving grandchild will never send.
 *
 * `terminateProcessTree` is the tree walk; this only adds what the registry
 * owns — an already-ended child is not an error, and a failed walk is recorded
 * as the session's ending rather than dropped on the floor.
 */
async function killTree(child: ChildProcess): Promise<TreeTermination> {
  if (child.exitCode !== null) {
    return { ok: true, how: "already_gone" };
  }
  return await terminateProcessTree(child);
}

function finalize(
  record: SessionRecord,
  end: ProcessSessionEndReason,
  now: () => number,
): void {
  if (isTerminalProcessStatus(record.status)) {
    return;
  }
  record.status = end.kind;
  record.end = end;
  record.endedAtMs = now();
  const waiters = [...record.waiters];
  record.waiters.clear();
  for (const wake of waiters) {
    wake();
  }
}

function snapshotOf(record: SessionRecord): ProcessSessionSnapshot {
  return {
    id: record.id,
    status: record.status,
    command: record.command,
    cwd: record.cwd,
    tty: record.tty,
    ...(record.child.pid === undefined ? {} : { pid: record.child.pid }),
    ...(record.end?.kind === "exited" ? { exitCode: record.end.exitCode } : {}),
    ...(record.end === undefined ? {} : { end: record.end }),
    bufferedBytes: record.buffer.byteLength,
    droppedOutput: record.buffer.dropped,
    startedAtMs: record.startedAtMs,
    ...(record.endedAtMs === undefined ? {} : { endedAtMs: record.endedAtMs }),
  };
}

export function createProcessSessionRegistry(
  options: ProcessSessionRegistryOptions = {},
): ProcessSessionRegistry {
  const maxSessions = options.maxSessions ?? 64;
  const maxBufferBytes = clampBufferBytes(options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES);
  const maxReadBytes = Math.max(4, options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES);
  const now = options.now ?? ((): number => Date.now());
  const publish = publishSessionsTo(options.jobs);
  const terminate = options.terminate ?? killTree;
  const sessions = new Map<ProcessSessionId, SessionRecord>();

  const liveSessions = (): SessionRecord[] =>
    [...sessions.values()].filter((record) => !isTerminalProcessStatus(record.status));

  const settleOnExit = (record: SessionRecord, child: ChildProcess): void => {
    child.once("exit", (code, signal) => {
      // A signalled child has no exit code of its own; -1 stands in so the shape
      // stays stable, and the end reason says a signal arrived rather than the
      // process choosing that number. An earlier version branched on `signal`
      // with the same result on both sides, which read as a distinction that had
      // been decided and then lost.
      const exitCode = typeof code === "number" ? code : -1;
      const end: ProcessSessionEndReason = {
        kind: "exited",
        exitCode,
        ...(signal === null ? {} : { signal }),
      };
      finalize(record, end, now);
      publish.ended(record.id, end);
    });
    child.once("error", (err: Error) => {
      const end: ProcessSessionEndReason = { kind: "failed", code: "process_spawn_failed", message: err.message };
      finalize(record, end, now);
      publish.ended(record.id, end);
    });
  };

  /**
   * Wait for something to happen, up to `yieldMs`. Resolves on the next chunk,
   * on exit, or on the timer — whichever is first, because a poll that only
   * answers at the end of its wait makes a live session feel like a hang.
   */
  const waitForChange = (record: SessionRecord, yieldMs: number): Promise<void> =>
    new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        record.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, yieldMs));
      record.waiters.add(finish);
    });

  const readOf = (record: SessionRecord) => {
    const read = record.buffer.read(maxReadBytes);
    return {
      id: record.id,
      output: read.text,
      truncated: read.dropped || read.heldBack > 0,
      status: record.status,
      ...(record.end === undefined ? {} : { end: record.end }),
      bufferedBytes: record.buffer.byteLength,
    };
  };

  return {
    maxSessions,

    async start(start: ProcessSessionStart): Promise<ProcessSessionSnapshot> {
      if (liveSessions().length >= maxSessions) {
        throw new Error(
          `process session limit reached (${maxSessions}); stop one before starting another`,
        );
      }
      const [program, ...args] = start.argv;
      if (program === undefined || program.length === 0) {
        throw new Error("process session needs an executable");
      }
      const id = isProcessSessionIdShape(start.id) ? start.id : newProcessSessionId();
      const buffer = createBoundedBuffer(start.maxBufferBytes || maxBufferBytes);
      const child = spawn(program, args, {
        cwd: start.cwd,
        env: { ...start.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const record: SessionRecord = {
        id,
        child,
        command: describeArgv(start.argv),
        cwd: start.cwd,
        tty: start.tty,
        startedAtMs: now(),
        buffer,
        status: "running",
        waiters: new Set(),
      };
      sessions.set(id, record);
      attachSessionOutput(record, chunk => publish.output(record.id, chunk));
      publish.started({
        id,
        pid: child.pid,
        command: record.command,
        cwd: record.cwd,
        startedAtMs: record.startedAtMs,
      });
      settleOnExit(record, child);
      // A spawn error arrives asynchronously, so the first read is what reports
      // it; returning a snapshot here would claim a session that never existed.
      return snapshotOf(record);
    },

    async write(request: ProcessSessionWrite): Promise<ProcessSessionWriteResult> {
      const record = sessions.get(request.sessionId);
      if (record === undefined) {
        return {
          ok: false,
          code: "session_not_found",
          message: sessionNotFound(request.sessionId),
        };
      }
      if (isTerminalProcessStatus(record.status)) {
        // A poll still answers: "it finished, here is what it said" is the most
        // useful thing to hear after the fact, and refusing it would make the
        // terminal state unreachable by the tool that would learn about it.
        if (request.input.length === 0 && !request.eof) {
          return { ok: true, read: readOf(record) };
        }
        return {
          ok: false,
          code: "session_finished",
          message: `session ${request.sessionId} already ${record.status}; it cannot receive input`,
          ...(record.end === undefined ? {} : { end: record.end }),
        };
      }
      if (request.input.length > 0 || request.eof) {
        try {
          if (request.input.length > 0) {
            record.child.stdin?.write(request.input, "utf8");
          }
          if (request.eof) {
            record.child.stdin?.end();
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "stdin write failed";
          return {
            ok: false,
            code: "session_write_failed",
            message: `writing to session ${request.sessionId} failed: ${message}`,
          };
        }
      }
      await waitForChange(record, request.yieldMs);
      return { ok: true, read: readOf(record) };
    },

    async stop(sessionId: ProcessSessionId): Promise<ProcessSessionStopResult> {
      const record = sessions.get(sessionId);
      if (record === undefined) {
        return { ok: false, code: "session_not_found", message: sessionNotFound(sessionId) };
      }
      if (isTerminalProcessStatus(record.status)) {
        return {
          ok: true,
          end: record.end ?? { kind: "exited", exitCode: record.child.exitCode ?? -1 },
        };
      }
      const terminated = await terminate(record.child);
      // A tree walk that failed is the one stop outcome the caller must see.
      // Reporting `ok: true` here would tell a user their server stopped while
      // a descendant of it is still holding the port — the exact false claim
      // C13 exists to prevent.
      if (!terminated.ok) {
        return { ok: false, code: "session_stop_failed", message: terminated.message };
      }
      // Give the OS a moment to deliver the kill before declaring an outcome.
      // The `exit` listener is the authority; this only bounds the wait. The
      // clock is the injected one so a test can decide how long "a moment" is,
      // rather than discovering the answer depends on the machine it runs on.
      const deadline = now() + STOP_GRACE_MS;
      while (record.child.exitCode === null && now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      if (record.child.exitCode === null) {
        // `lost`, not `exited`: we stopped the process and never saw it end.
        finalize(
          record,
          {
            kind: "lost",
            reason:
              "the process was asked to stop but never reported an exit; on Windows a surviving grandchild can keep the inherited stdio open",
          },
          now,
        );
      }
      return {
        ok: true,
        end: record.end ?? { kind: "lost", reason: "stop requested, exit unobserved" },
      };
    },

    list(): ProcessSessionList {
      return { sessions: [...sessions.values()].map(snapshotOf) };
    },

    get(sessionId: ProcessSessionId): ProcessSessionSnapshot | undefined {
      const record = sessions.get(sessionId);
      return record === undefined ? undefined : snapshotOf(record);
    },

    async shutdown(): Promise<void> {
      const failures: Error[] = [];
      for (const record of liveSessions()) {
        // Teardown is best-effort by nature — the owner is going away — but the
        // attempt is still made through the tree walk, not a direct kill, so a
        // shutdown does not leave grandchildren behind holding the workspace.
        try {
          const result = await terminate(record.child);
          if (!result.ok) failures.push(new Error(`${record.id}: ${result.message}`));
          else finalize(record, { kind: "lost", reason: "owner teardown stopped the tree before its exit was observed" }, now);
        } catch (error) {
          failures.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, "session_cleanup_failed: some process trees could not be stopped");
    },
  };
}
