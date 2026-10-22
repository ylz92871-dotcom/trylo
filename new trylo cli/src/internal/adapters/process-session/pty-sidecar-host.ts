import { type ChildProcess } from "node:child_process";

import type { ProcessSessionEndReason, ProcessSessionStatus } from "../../ports/process-session.js";
import { isTerminalProcessStatus } from "../../ports/process-session.js";
import type { BoundedBuffer } from "./output-buffer.js";
import {
  PTY_EVENT,
  PTY_MAX_FRAME_BYTES,
  PTY_OP,
  PTY_PROTOCOL_VERSION,
  createFrameDecoder,
  decodeIdPayload,
  encodeJsonFrame,
  parsePtyError,
  parsePtyExit,
  parsePtyHello,
  parsePtyReady,
} from "./pty-protocol.js";

/**
 * Owning the helper process, and deciding what its death means.
 *
 * This is separated from the session registry because it is a different
 * question. The registry asks "what is this session doing"; this asks "is the
 * thing that makes every session possible still here". Mixing them is how a
 * transport concern ends up being answered in three places, and the place that
 * forgets is the one that matters.
 *
 * The rule this module exists to enforce: when the helper goes away, every
 * session it owned becomes `lost`. Not `exited` — an exit code would be a claim
 * about a program nobody observed ending, and the program may well still be
 * running, attached to a console this process cannot see.
 */

/** What the registry needs to know about a running session. */
export type PtySessionRecord = {
  readonly id: string;
  /**
   * The real buffer, not a narrowed structural type. The host writes into it
   * and the registry reads out of it, and a type that described only those two
   * operations would let the two halves disagree about `dropped` — which is
   * exactly the fact that tells a reader output was lost.
   */
  readonly buffer: BoundedBuffer;
  status: ProcessSessionStatus;
  end?: ProcessSessionEndReason;
  pid?: number;
  waiters: Set<() => void>;
};

export type PtySidecar = {
  readonly child: ChildProcess;
  readonly sessions: Map<string, PtySessionRecord>;
  protocol: number;
  version: string;
};

export type PtySidecarHostOptions = {
  /**
   * An already-resolved helper path, not a resolution result. Resolution can
   * fail and must be answered with an explanation; passing the union in here
   * would mean every caller re-decided what to do about the failing half, and
   * one of them would eventually reach for the path anyway.
   */
  readonly helperPath: string;
  readonly spawnHelper: (helperPath: string) => ChildProcess;
  readonly now: () => number;
};

export type PtySidecarHost = {
  /** Resolves once the handshake has succeeded and the versions agree. */
  ready(): Promise<PtySidecar>;
  send(frame: Buffer): void;
  /** Present only while a helper is running. */
  readonly current: PtySidecar | undefined;
  /**
   * Sessions that reached a terminal state, kept after the helper is gone.
   *
   * This exists because `lost` is only observable here. When the helper dies,
   * every session it owned becomes `lost` — and that is precisely the moment a
   * caller most needs to ask what happened. Reading them from `current` alone
   * would answer `session_not_found` to the one question the terminal state was
   * recorded to answer, and the record would be decoration.
   */
  get(sessionId: string): PtySessionRecord | undefined;
  /** Every session with a terminal state, from this or a previous helper. */
  terminalSessions(): ReadonlyArray<PtySessionRecord>;
  shutdown(): void;
};

/**
 * Mark a session terminal and wake whoever is waiting on it. A session never
 * leaves a terminal state, so a second call is a no-op rather than an overwrite.
 */
export function terminalize(
  record: PtySessionRecord,
  end: ProcessSessionEndReason,
  now: () => number,
): void {
  if (isTerminalProcessStatus(record.status)) {
    return;
  }
  record.buffer.end();
  record.status = end.kind;
  record.end = end;
  for (const wake of [...record.waiters]) {
    wake();
  }
  record.waiters.clear();
  void now;
}

/**
 * One helper owns every PTY session. A helper per session would multiply the
 * console handles and turn teardown into counting children.
 */
export function createPtySidecarHost(options: PtySidecarHostOptions): PtySidecarHost {
  let sidecar: PtySidecar | undefined;
  let waiters: Array<{ resolve: () => void; reject: (reason: Error) => void }> = [];
  /**
   * Terminal sessions outlive the helper that reported them. Keyed by id, and
   * bounded so a long-lived process that starts and stops many sessions does not
   * accumulate records forever; the oldest go first, because the newest ending
   * is the one someone is still asking about.
   */
  const retired = new Map<string, PtySessionRecord>();
  const RETAINED_LIMIT = 64;

  const retire = (record: PtySessionRecord): void => {
    retired.delete(record.id);
    retired.set(record.id, record);
    while (retired.size > RETAINED_LIMIT) {
      const oldest = retired.keys().next();
      if (oldest.done === true) {
        break;
      }
      retired.delete(oldest.value);
    }
  };

  const failAll = (reason: string): void => {
    const current = sidecar;
    sidecar = undefined;
    for (const waiter of waiters) {
      waiter.reject(new Error(`PTY helper: ${reason}`));
    }
    waiters = [];
    if (current === undefined) {
      return;
    }
    // Marked *and retained*, not cleared. The earlier version marked them and
    // then dropped the only structure holding them, so the state existed and
    // could not be observed: every lookup went through `current`, which was
    // already undefined, and answered session_not_found. `retire` is what makes
    // the record readable.
    for (const record of current.sessions.values()) {
      terminalize(record, { kind: "lost", reason }, options.now);
      retire(record);
    }
  };

  const onFrame = (current: PtySidecar, type: number, payload: Buffer): void => {
    switch (type) {
      case PTY_EVENT.hello: {
        const hello = parsePtyHello(payload);
        if (hello === undefined) {
          failAll("the hello frame could not be parsed, so it is not speaking this protocol");
          return;
        }
        current.protocol = hello.protocol;
        current.version = hello.version;
        for (const waiter of waiters) {
          waiter.resolve();
        }
        waiters = [];
        return;
      }
      case PTY_EVENT.ready: {
        const ready = parsePtyReady(payload);
        if (ready === undefined) {
          return;
        }
        const record = current.sessions.get(ready.id);
        if (record !== undefined) {
          record.pid = ready.pid;
        }
        return;
      }
      case PTY_EVENT.data: {
        // Delivered to the session the bytes name, and to no other. The earlier
        // version broadcast to every live session, which is indistinguishable
        // from a program printing the wrong thing: with two terminals open each
        // buffer received the other's output and nothing could tell.
        const addressed = decodeIdPayload(payload);
        if (addressed === undefined) {
          // A data frame with no usable id cannot be attributed, so it goes
          // nowhere. Dropping it is honest; guessing a session would put bytes
          // in a terminal that did not produce them.
          return;
        }
        const record = current.sessions.get(addressed.sessionId);
        if (record === undefined) {
          return;
        }
        record.buffer.write(addressed.body);
        for (const wake of [...record.waiters]) {
          wake();
        }
        return;
      }
      case PTY_EVENT.exit: {
        const exit = parsePtyExit(payload);
        if (exit === undefined) {
          return;
        }
        const record = current.sessions.get(exit.id);
        if (record === undefined) {
          return;
        }
        // Terminal state is recorded, not deleted. A poll after the fact is how
        // a caller reads what the program said before it ended, and the pipes
        // registry keeps the record for the same reason — two paths that answer
        // "can I still see this?" differently is a bug waiting to be found.
        terminalize(record, { kind: "exited", exitCode: exit.code }, options.now);
        retire(record);
        return;
      }
      case PTY_EVENT.error: {
        const error = parsePtyError(payload);
        if (error === undefined) {
          failAll("an error frame could not be parsed, so it is not speaking this protocol");
          return;
        }
        if (error.code === "pty_protocol_mismatch") {
          failAll(`protocol mismatch: ${error.message}`);
          return;
        }
        const record = error.id === undefined ? undefined : current.sessions.get(error.id);
        if (record === undefined) {
          return;
        }
        terminalize(
          record,
          { kind: "failed", code: error.code, message: error.message },
          options.now,
        );
        retire(record);
        return;
      }
      default:
        // An unknown event type is not fatal: a newer helper may send events
        // this build has no use for. Stream misalignment is caught by the frame
        // decoder instead, which is the only thing that can actually detect it.
        return;
    }
  };

  const ready = async (): Promise<PtySidecar> => {
    if (sidecar !== undefined) {
      return sidecar;
    }
    const child = options.spawnHelper(options.helperPath);
    const current: PtySidecar = { child, sessions: new Map(), protocol: 0, version: "unknown" };
    const decode = createFrameDecoder(
      (frame) => {
        onFrame(current, frame.type, frame.payload);
      },
      (reason) => {
        failAll(reason);
      },
    );
    child.stdout?.on("data", decode);
    child.stderr?.resume();
    child.stdin?.on("error", () => {
      // The pipe broke. `close` on the child carries the real end, and handling
      // both would report one death twice.
    });
    child.once("error", (err: Error) => {
      failAll(`the helper could not be started: ${err.message}`);
    });
    child.once("close", (code) => {
      // Its stdin closing is what makes the helper kill what it owns, so by the
      // time this arrives those processes are already gone.
      failAll(`the helper exited with code ${code ?? -1}`);
    });
    sidecar = current;

    const handshake = new Promise<void>((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
    child.stdin?.write(encodeJsonFrame(PTY_OP.hello, { protocol: PTY_PROTOCOL_VERSION }));
    await handshake;
    if (current.protocol !== PTY_PROTOCOL_VERSION) {
      const detail = `helper ${current.version} speaks protocol ${current.protocol}, this build speaks ${PTY_PROTOCOL_VERSION}`;
      failAll(detail);
      throw new Error(`pty_protocol_mismatch: ${detail}`);
    }
    return current;
  };

  return {
    ready,
    send(frame: Buffer): void {
      sidecar?.child.stdin?.write(frame);
    },
    get current(): PtySidecar | undefined {
      return sidecar;
    },
    get(sessionId: string): PtySessionRecord | undefined {
      const live = sidecar?.sessions.get(sessionId);
      if (live !== undefined) {
        return live;
      }
      return retired.get(sessionId);
    },
    terminalSessions(): ReadonlyArray<PtySessionRecord> {
      return [...retired.values()];
    },
    shutdown(): void {
      const current = sidecar;
      sidecar = undefined;
      for (const waiter of waiters) {
        waiter.reject(new Error("PTY helper: the owner shut down"));
      }
      waiters = [];
      if (current === undefined) {
        return;
      }
      // Closing the helper's stdin *is* the shutdown: it kills every session it
      // owns on the way out, which is stronger than asking each one politely.
      current.child.stdin?.end();
      current.child.kill();
      for (const record of current.sessions.values()) {
        terminalize(
          record,
          { kind: "lost", reason: "the session owner went away before the process ended" },
          options.now,
        );
      }
      // Cleared here and only here: the owner is gone, so there is nobody left
      // to ask. Everywhere else a terminal session stays readable.
      current.sessions.clear();
      retired.clear();
    },
  };
}

/** The frame ceiling, re-exported so the registry can refuse an oversized write. */
export { PTY_MAX_FRAME_BYTES };
