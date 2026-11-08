import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { BoardStore, StoreLoadErr } from "../../learning/control/store-port.js";

export interface BoardWriterAdmissionOptions {
  /** Admission only. Never interrupts or replays an entered callback. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly canEnter?: () => boolean;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

type Admitted = { readonly store: BoardStore; readonly beforeRun: () => StoreLoadErr | undefined };

const refusal = (reason: StoreLoadErr["reason"], detail: string): StoreLoadErr => ({ ok: false, reason, detail });

/** Every retry still takes the original process-shared file lock. This owns no
 * callback, command or queue, so an unknown durable outcome cannot be replayed. */
export async function admitBoardWriter(create: () => BoardStore | StoreLoadErr,
  options: BoardWriterAdmissionOptions = {}): Promise<Admitted | StoreLoadErr> {
  const now = options.now ?? (() => performance.now()), random = options.random ?? Math.random;
  const wait = options.wait ?? ((milliseconds, signal) => delay(milliseconds, undefined, signal === undefined ? {} : { signal }));
  const timeoutMs = options.timeoutMs ?? 5000;
  let lastTime: number, deadline: number;
  let lastContention: StoreLoadErr | undefined;
  const check = (): StoreLoadErr | undefined => {
    try {
      if (options.signal?.aborted) return refusal("learning_aborted", "Board writer admission cancelled before callback entry");

      if (options.canEnter?.() === false) return refusal("collect_disabled", "Board writer admission is no longer authorized");

      const current = now();
      if (!Number.isFinite(current) || current < lastTime) return refusal("board_unavailable", "Board writer admission clock is invalid");

      lastTime = current;

      if (current >= deadline) return refusal("multi_writer", `Board writer admission timed out before callback entry: ${lastContention?.detail ?? "deadline reached"}`);

      return undefined;
    } catch (error) {
      return refusal("board_unavailable", error instanceof Error ? error.message : "Board writer admission check failed");
    }
  };

  try {
    lastTime = now();
    deadline = lastTime + timeoutMs;

    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isFinite(lastTime) || !Number.isFinite(deadline)) {
      return refusal("board_unavailable", "Board writer admission options are invalid");
    }

    for (;;) {
      const stopped = check();
      if (stopped !== undefined) return stopped;

      const store = create();
      if ("apply" in store) return { store, beforeRun: check };

      if (store.reason !== "multi_writer") return store;

      lastContention = store;
      const afterAttempt = check();
      if (afterAttempt !== undefined) return afterAttempt;

      const draw = random();
      if (!Number.isFinite(draw) || draw < 0 || draw > 1) return refusal("board_unavailable", "Board writer admission jitter is invalid");

      await wait(Math.min(25 + Math.floor(draw * 50), deadline - lastTime), options.signal);
    }
  } catch (error) {
    // This function never enters the callback. Any wait/create failure is known
    // not to have applied a command; it is returned, never retried as a write.
    return options.signal?.aborted ? refusal("learning_aborted", "Board writer admission cancelled before callback entry")
      : refusal("board_unavailable", error instanceof Error ? error.message : "Board writer admission failed");
  }
}
