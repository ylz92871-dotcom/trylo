/**
 * The channel a parent uses to talk to a subagent that is already running
 * (WP22.2 / C43).
 *
 * A subagent worker is one function that returns once, so "send this agent
 * another instruction" is not expressible without somewhere for the instruction
 * to wait. This is that place: the worker owns the reading end and pulls one
 * input at a time, the control surface owns the writing end.
 *
 * Two properties matter and each is pinned by a test:
 *
 *  - **Delivering to a finished agent is refused, not queued.** An input that
 *    waits forever on an agent that will never read it is a leak that looks
 *    like a slow run.
 *  - **Closing is what ends a waiting worker.** A worker parked on `next()`
 *    has nothing else that can wake it, so without this a spawned agent would
 *    hold its governance slot until the turn's timeout.
 */

export type SubagentInput = {
  readonly message: string;
  /**
   * Drop whatever is still queued and take this one instead.
   *
   * A subagent round is atomic — the worker is between rounds when it reads,
   * never mid-request — so "interrupt the round in progress" is not something
   * this channel could honestly promise. What it *can* mean, and does, is
   * "forget the instructions you had not started": a queue of three pending
   * instructions that the model has since decided are wrong is worse than no
   * queue, and the agent cannot tell that from inside a round.
   */
  readonly interrupt?: boolean | undefined;
};

export type SubagentInputChannel = {
  /** Writing end: `false` if closed or the bounded queue has no room. */
  deliver(input: SubagentInput): boolean;
  /** Writing end: tell a waiting worker to finish. Idempotent. */
  close(): void;
  /** Reading end, worker side. `"closed"` once the channel is closed and drained. */
  next(signal: AbortSignal): Promise<SubagentInput | "closed">;
  /** Whether the channel still accepts input. */
  readonly open: boolean;
  /** Final round accepted so far, counting inputs already handed to the worker. */
  readonly requestedRound: number;
};

type Pending = {
  readonly resolve: (value: SubagentInput | "closed") => void;
  readonly reject: (reason: unknown) => void;
};

export const SUBAGENT_INPUT_QUEUE_LIMIT = 32;

export function createSubagentInputChannel(): SubagentInputChannel {
  const queue: SubagentInput[] = [];
  let waiting: Pending | undefined;
  let closed = false;
  let deliveredRound = 1;

  function settle(value: SubagentInput | "closed"): void {
    const pending = waiting;
    waiting = undefined;
    pending?.resolve(value);
  }

  return {
    get open(): boolean {
      return !closed;
    },

    get requestedRound(): number {
      return deliveredRound + queue.length;
    },

    deliver(input: SubagentInput): boolean {
      if (closed) {
        return false;
      }
      if (input.interrupt === true) {
        queue.length = 0;
      }
      if (waiting !== undefined) {
        deliveredRound += 1;
        settle(input);
        return true;
      }
      if (queue.length >= SUBAGENT_INPUT_QUEUE_LIMIT) {
        return false;
      }
      queue.push(input);
      return true;
    },

    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      if (waiting !== undefined) {
        settle("closed");
      }
    },

    async next(signal: AbortSignal): Promise<SubagentInput | "closed"> {
      if (signal.aborted) {
        throw signal.reason;
      }
      const queued = queue.shift();
      if (queued !== undefined) {
        deliveredRound += 1;
        return queued;
      }
      if (closed) {
        return "closed";
      }
      return await new Promise<SubagentInput | "closed">((resolve, reject) => {
        const onAbort = (): void => {
          waiting = undefined;
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiting = {
          resolve: (value) => {
            signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          reject: (reason) => {
            signal.removeEventListener("abort", onAbort);
            reject(reason);
          },
        };
      });
    },
  };
}
