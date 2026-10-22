import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";

import {
  type ProcessSessionId,
  type ProcessSessionList,
  type ProcessSessionSnapshot,
  type ProcessSessionStart,
  type ProcessSessionStopResult,
  type ProcessSessionWrite,
  type ProcessSessionWriteResult,
  clampBufferBytes,
  isTerminalProcessStatus,
} from "../../ports/process-session.js";
import { createBoundedBuffer } from "./output-buffer.js";
import { resolvePtyHelper, type PtyHelperResolution } from "./pty-loader.js";
import { resolveExecutablePath } from "../sandbox/resolve-executable-path.js";
import { PTY_OP, encodeJsonFrame, encodeWriteFrame } from "./pty-protocol.js";
import {
  type PtySessionRecord,
  createPtySidecarHost,
  terminalize,
} from "./pty-sidecar-host.js";
import { isProcessSessionIdShape, newProcessSessionId } from "./session-id.js";

/**
 * Long-running sessions attached to a real terminal.
 *
 * # Why this is a separate implementation
 *
 * The pipes registry (`session-registry.ts`) satisfies the same port because the
 * *session* contract is the same. They are still two adapters because they fail
 * differently, and that difference is the reason:
 *
 *  - A pipe child that outlives its caller leaves a handle to a dead process.
 *    Writing to it fails, and that is knowable from here.
 *  - A PTY child holds a console. Losing the helper leaves the program running,
 *    attached to a terminal nobody is reading. That is *not* knowable from this
 *    process, so it is prevented rather than detected — see `pty-sidecar-host.ts`.
 *
 * One adapter trying to serve both would have to answer each case with whichever
 * answer was written first, and the terminal case is the one that must not be
 * wrong.
 *
 * # What the sidecar does not do
 *
 * It resolves nothing and decides nothing. The executable path, argv, cwd and
 * environment all arrive already planned and authorised — the same plan that was
 * approved. That matters because `portable-pty` resolves a program name against
 * *its own* environment, which is not the CLI's; letting it search would give a
 * second, unauthorised answer to "what runs".
 */

const DEFAULT_MAX_BUFFER_BYTES = 1_048_576;
const DEFAULT_MAX_READ_BYTES = 65_536;
/** One frame of the largest payload the protocol permits. */
const MAX_WRITE_BYTES = 64 * 1024 * 1024;

/** Matches the pipes path so a stop takes the same time on either transport. */
const STOP_GRACE_MS = 2_000;

type PtySession = PtySessionRecord & {
  readonly id: ProcessSessionId;
  readonly command: string;
  readonly cwd: string;
  readonly rows: number;
  readonly cols: number;
  readonly startedAtMs: number;
  endedAtMs?: number;
};

export type PtySessionRegistryOptions = {
  readonly maxSessions?: number;
  readonly maxBufferBytes?: number;
  readonly maxReadBytes?: number;
  readonly now?: () => number;
  /** A seam for tests: the resolution a real run would perform. */
  readonly helper?: PtyHelperResolution;
  /** Injected so tests need not start a real console. */
  readonly spawnHelper?: (helperPath: string) => ChildProcess;
};

export type PtySessionRegistryPort = {
  start(start: ProcessSessionStart): Promise<ProcessSessionSnapshot>;
  write(request: ProcessSessionWrite): Promise<ProcessSessionWriteResult>;
  stop(sessionId: ProcessSessionId): Promise<ProcessSessionStopResult>;
  resize(sessionId: ProcessSessionId, rows: number, cols: number): boolean;
  list(): ProcessSessionList;
  get(sessionId: ProcessSessionId): ProcessSessionSnapshot | undefined;
  shutdown(): void;
  readonly maxSessions: number;
};

function snapshotOf(record: PtySession): ProcessSessionSnapshot {
  return {
    id: record.id,
    status: record.status,
    command: record.command,
    cwd: record.cwd,
    tty: true,
    ...(record.end?.kind === "exited" ? { exitCode: record.end.exitCode } : {}),
    ...(record.end === undefined ? {} : { end: record.end }),
    bufferedBytes: record.buffer.byteLength,
    droppedOutput: record.buffer.dropped,
    startedAtMs: record.startedAtMs,
    ...(record.endedAtMs === undefined ? {} : { endedAtMs: record.endedAtMs }),
  };
}

export function createPtySessionRegistry(
  options: PtySessionRegistryOptions = {},
): PtySessionRegistryPort {
  const maxSessions = options.maxSessions ?? 8;
  const maxBufferBytes = clampBufferBytes(options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES);
  const maxReadBytes = Math.max(4, options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES);
  const now = options.now ?? ((): number => Date.now());
  const resolution = options.helper ?? resolvePtyHelper();
  // Resolved once, here, so the failure carries its explanation to whoever
  // asked for a terminal rather than surfacing later as a spawn error.
  const helperPath = resolution.ok ? resolution.helperPath : "";
  const host = createPtySidecarHost({
    helperPath,
    spawnHelper:
      options.spawnHelper ??
      ((helperPath: string): ChildProcess =>
        spawn(helperPath, [], {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        })),
    now,
  });

  /**
   * A session by id, whether the helper still owns it or it has already ended.
   *
   * Reading through `host.current` alone is what made `lost` unobservable: the
   * host marks its sessions when the helper dies and then drops the structure
   * holding them, so every lookup after that returned session_not_found — the
   * one answer that is wrong precisely when it matters. `host.get` consults the
   * live sidecar first and the retained terminal records second.
   */
  const findSession = (sessionId: ProcessSessionId): PtySession | undefined =>
    host.get(sessionId) as PtySession | undefined;

  const liveSessions = (): PtySession[] => {
    const current = host.current;
    if (current === undefined) {
      return [];
    }
    return [...current.sessions.values()].filter(
      (record): record is PtySession => !isTerminalProcessStatus(record.status),
    );
  };

  const waitForChange = (record: PtySession, yieldMs: number): Promise<void> =>
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

  /** Inside the returned object so `maxReadBytes` reaches every read. */
  const readOf = (record: PtySession) => {
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
      if (start.tty !== true) {
        throw new Error("the PTY registry only starts sessions that asked for a terminal");
      }
      if (liveSessions().length >= maxSessions) {
        throw new Error(
          `PTY session limit reached (${maxSessions}); stop one before starting another`,
        );
      }
      const [program, ...args] = start.argv;
      if (program === undefined || program.length === 0) {
        throw new Error("process session needs an executable");
      }
      if (!resolution.ok) {
        throw new Error(`${resolution.code}: ${resolution.message}`);
      }

      // The program is resolved *here*, under the same PATH/PATHEXT rules the
      // rest of the CLI uses, and the sidecar is handed an absolute path.
      //
      // This is not a convenience. `portable-pty` searches using the environment
      // it was given, and this package clears that environment so a terminal
      // program inherits nothing it should not — which leaves the sidecar unable
      // to resolve a bare name at all. Worse, if it could, its answer would come
      // from a different rule set than the one the sandbox approved: two answers
      // to "what runs", where only one was planned. Resolving here means the
      // sidecar is told what to start rather than asked to decide.
      const resolved = resolveExecutablePath(program);
      if (!resolved.ok) {
        // Refused here rather than sent on. A spawn error from inside the
        // sidecar would describe the sidecar's environment, not this machine's.
        throw new Error(`${resolved.code}: ${resolved.message}`);
      }
      if (resolved.needsShell) {
        // A .cmd/.bat is a script, and CreateProcess will not run it: it needs an
        // interpreter. The wrapper that does that is WP05's, and this package
        // does not build a second one — so the fact is reported instead of
        // quietly wrapping it differently from every other run_shell caller.
        throw new Error(
          `pty_session_rejects_script: ${program} is a ${path.extname(program)} script and needs a command interpreter; ` +
            "run it through run_shell, which already has that wrapper",
        );
      }

      const id = isProcessSessionIdShape(start.id) ? start.id : newProcessSessionId();
      const current = await host.ready();
      const buffer = createBoundedBuffer(start.maxBufferBytes || maxBufferBytes);
      const record: PtySession = {
        id,
        buffer,
        status: "running",
        waiters: new Set(),
        command: start.argv.join(" "),
        cwd: start.cwd,
        rows: start.rows,
        cols: start.cols,
        startedAtMs: now(),
      };
      current.sessions.set(id, record);
      host.send(
        encodeJsonFrame(PTY_OP.spawn, {
          id,
          // Absolute, always. See the resolution above.
          program: resolved.absolutePath,
          args,
          cwd: start.cwd,
          // Pairs, not an object: the sidecar clears the block and rebuilds it,
          // and an object would promise an ordering this protocol does not.
          env: Object.entries(start.env),
          rows: start.rows,
          cols: start.cols,
        }),
      );
      return snapshotOf(record);
    },

    async write(request: ProcessSessionWrite): Promise<ProcessSessionWriteResult> {
      const record = findSession(request.sessionId);
      if (record === undefined) {
        return {
          ok: false,
          code: "session_not_found",
          message: `no PTY session with id ${request.sessionId}; it may have exited and been reaped`,
        };
      }
      if (isTerminalProcessStatus(record.status)) {
        // A poll still answers. "It finished, here is what it said" is the most
        // useful thing to hear after the fact, and refusing it would make the
        // terminal state unreachable by the tool that would learn about it.
        if (request.input.length === 0 && !request.eof) {
          return { ok: true, read: readOf(record) };
        }
        return {
          ok: false,
          code: "session_finished",
          message: `PTY session ${request.sessionId} already ${record.status}; it cannot receive input`,
          ...(record.end === undefined ? {} : { end: record.end }),
        };
      }
      if (Buffer.byteLength(request.input, "utf8") > MAX_WRITE_BYTES) {
        return {
          ok: false,
          code: "session_write_failed",
          message: `input exceeds the ${MAX_WRITE_BYTES} byte frame ceiling`,
        };
      }
      // Only a session the helper still owns can be written to. A retained
      // terminal record is readable but not writable, which is why this sends
      // through the live sidecar rather than through the record.
      if (host.current !== undefined) {
        host.send(
          encodeWriteFrame(
            request.eof ? PTY_OP.eof : PTY_OP.write,
            request.sessionId,
            Buffer.from(request.input, "utf8"),
          ),
        );
      }
      await waitForChange(record, request.yieldMs);
      return { ok: true, read: readOf(record) };
    },

    async stop(sessionId: ProcessSessionId): Promise<ProcessSessionStopResult> {
      const record = findSession(sessionId);
      if (record === undefined) {
        return {
          ok: false,
          code: "session_not_found",
          message: `no PTY session with id ${sessionId}; it may have exited and been reaped`,
        };
      }
      if (isTerminalProcessStatus(record.status)) {
        return {
          ok: true,
          end: record.end ?? { kind: "lost", reason: "session was already terminal" },
        };
      }
      host.send(encodeJsonFrame(PTY_OP.kill, { id: sessionId }));
      // Injected clock, as on the pipes path: "did the ending arrive?" is a
      // question about the helper, and how long we are willing to wait for the
      // answer should not be a property of the machine running the test.
      const deadline = now() + STOP_GRACE_MS;
      while (!isTerminalProcessStatus(record.status) && now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      if (!isTerminalProcessStatus(record.status)) {
        // The kill went out and nothing came back. `lost` rather than a guessed
        // exit code: the console may still hold a program this process cannot
        // see. Recorded and kept, not deleted — an unobserved end is precisely
        // what a caller needs to be able to ask about afterwards.
        terminalize(
          record,
          { kind: "lost", reason: "the helper accepted a kill but never reported the exit" },
          now,
        );
      }
      return {
        ok: true,
        end: record.end ?? { kind: "lost", reason: "stop requested, exit unobserved" },
      };
    },

    resize(sessionId: ProcessSessionId, rows: number, cols: number): boolean {
      if (host.current === undefined || findSession(sessionId) === undefined) {
        return false;
      }
      host.send(encodeJsonFrame(PTY_OP.resize, { id: sessionId, rows, cols }));
      return true;
    },

    list(): ProcessSessionList {
      // Both sources, or a helper that died would make every session it owned
      // vanish from the listing at the moment the user asks what happened.
      const live = host.current === undefined ? [] : [...host.current.sessions.values()];
      const seen = new Set(live.map((record) => record.id));
      const retired = host.terminalSessions().filter((record) => !seen.has(record.id));
      return {
        sessions: [...live, ...retired].map((record) => snapshotOf(record as PtySession)),
      };
    },

    get(sessionId: ProcessSessionId): ProcessSessionSnapshot | undefined {
      const record = findSession(sessionId);
      return record === undefined ? undefined : snapshotOf(record);
    },

    shutdown(): void {
      host.shutdown();
    },
  };
}
