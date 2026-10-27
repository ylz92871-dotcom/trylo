import {
  type ProcessSessionList,
  type ProcessSessionStopResult,
  type ProcessSessionWrite,
  type ProcessSessionWriteResult,
} from "../../ports/process-session.js";
// The registries' own types live with their implementations, not in the port:
// the port describes a session, and a registry is one way of holding several.
import type { ProcessSessionRegistry } from "./session-registry.js";
import type { PtySessionRegistryPort } from "./pty-session.js";

/**
 * One session list for callers, over two registries underneath.
 *
 * # Why this is not a single registry
 *
 * A background command and an interactive terminal session are the same *kind*
 * of thing to a model — something with an id that produces output and can be
 * ended — and they are different things underneath: one runs over pipes, the
 * other over ConPTY, and they fail differently enough that merging their
 * implementations would mean answering each case with whichever answer was
 * written first.
 *
 * So the implementations stay separate and only the *view* is unified. A caller
 * asks "what sessions do I have" and gets both; it stops a session by id and the
 * id decides which registry it belonged to. Ids are unguessable and prefixed, so
 * "which one was this" is answered by the id rather than by a flag the caller
 * has to remember to set.
 *
 * This exists mostly so the catalog can be honest: three session tools that can
 * see every session are tools that work, and a PTY session that exists but is
 * invisible to `list_processes` is the "mounted but unreachable" shape this
 * package already failed at once.
 */
export type SessionView = {
  readonly pipes: ProcessSessionRegistry;
  /** Absent when this platform has no sidecar, or no caller supplied one. */
  readonly pty?: PtySessionRegistryPort | undefined;
};

/**
 * Which registry owns an id. Both satisfy the same session contract, so the
 * caller forwards without caring — the id decides, not a flag it must remember.
 */
type SessionOwner = Pick<ProcessSessionRegistry, "write" | "stop" | "get">;

function byId(view: SessionView, sessionId: string): SessionOwner | undefined {
  if (view.pipes.get(sessionId) !== undefined) {
    return view.pipes;
  }
  return view.pty?.get(sessionId) === undefined ? undefined : view.pty;
}

export function createSessionView(view: SessionView): ProcessSessionRegistry {
  return {
    get maxSessions(): number {
      return view.pipes.maxSessions + (view.pty?.maxSessions ?? 0);
    },

    async start(request: Parameters<ProcessSessionRegistry["start"]>[0], signal?: AbortSignal) {
      // Not merged on purpose. Which transport a command needs is not knowable
      // from the call — a program decides that by whether it checks for a
      // terminal — so this forwards to the pipes registry, which is the one the
      // `runInBackground` branch starts through. A caller that needs a real
      // terminal asks for one explicitly rather than getting a guess.
      return await view.pipes.start(request, signal);
    },

    async write(request: ProcessSessionWrite): Promise<ProcessSessionWriteResult> {
      const owner = byId(view, request.sessionId);
      if (owner === undefined) {
        return {
          ok: false,
          code: "session_not_found",
          message: `no process session with id ${request.sessionId}; it may have finished and been reaped`,
        };
      }
      return await owner.write(request);
    },

    async stop(sessionId: string): Promise<ProcessSessionStopResult> {
      const owner = byId(view, sessionId);
      if (owner === undefined) {
        return {
          ok: false,
          code: "session_not_found",
          message: `no process session with id ${sessionId}; it may have finished and been reaped`,
        };
      }
      return await owner.stop(sessionId);
    },

    list(): ProcessSessionList {
      const pty = view.pty?.list().sessions ?? [];
      return { sessions: [...view.pipes.list().sessions, ...pty] };
    },

    get(sessionId: string) {
      return byId(view, sessionId)?.get(sessionId);
    },

    async shutdown(): Promise<void> {
      const failures: unknown[] = [];
      try { await view.pipes.shutdown(); } catch (error) { failures.push(error); }
      try { view.pty?.shutdown(); } catch (error) { failures.push(error); }
      if (failures.length > 0) throw new AggregateError(failures, "session_cleanup_failed: one or more execution transports failed teardown");
    },
  };
}
