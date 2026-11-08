import { createFileBackgroundQueue } from "../queue-store/file-queue.js";
import type { QueueClock } from "../../ports/background-queue.js";
import { nextDueAtMs } from "../../domain/schedule.js";
import {
  clearDiscovery,
  clearStopRequest,
  readStopRequest,
  writeDiscovery,
  writeHeartbeat,
  type DaemonHeartbeat,
} from "./record.js";
import type { DaemonIdentity } from "../../domain/daemon-identity.js";
import {
  DEFAULT_RECURRING_MAX_AGE_MS,
  type Occurrence,
  type OccurrenceRunnerResult,
  type SchedulePort,
} from "../../ports/schedule.js";
import { createFileScheduleStore, scheduleFilePath } from "../schedule-store/index.js";
import { writeWatchRows } from "./record-rows.js";

/**
 * The resident scheduler loop (WP26 / A04 host for A06).
 *
 * ## What it does, once per tick
 *
 * ```text
 * take the schedule lease (once, at start)
 *   ↓
 * for each tick:
 *   claim due occurrences  →  run each  →  settle each  →  heartbeat
 * ```
 *
 * The lease is taken **once** and held, not re-taken per tick. Taking it per tick
 * would mean two daemons alternate rather than one owning the schedule, and the
 * window between "released" and "taken" is exactly where a duplicate fire lives.
 *
 * ## The limits, because ADR §5 requires them
 *
 * Every unbounded thing here is bounded, and the bounds are named:
 *
 *  - **One in-flight tick.** A tick that overruns does not start a second one. An
 *    unbounded loop of timers would let a slow run queue work faster than it
 *    completes, and the backlog would be invisible.
 *  - **A tick budget per pass.** `maxOccurrencesPerTick` caps how much one pass
 *    takes, so a machine waking after a long sleep fires a bounded burst rather
 *    than every missed slot at once.
 *  - **An idle ceiling.** A `sleep` that returns without waiting — a timer that
 *    never fires, an injected stub, a clock that jumps — would turn the loop into
 *    a tight cycle doing filesystem IO forever. The loop counts consecutive ticks
 *    that completed in under one interval and stops itself rather than spinning.
 *    This bound was added because a test that injected an immediate `sleep` hung
 *    the process, which is the cheapest possible demonstration of the defect.
 *  - **A daemon tick interval**, and a heartbeat that reports how many intervals
 *    behind it is, so "running" is falsifiable.
 *  - **A shutdown path** that gives in-flight work a moment to settle before the
 *    process leaves. `force` skips it, and says so.
 *
 * ## What it deliberately does not own
 *
 * It does not own the session, the provider, or the queue. Firing hands the prompt
 * to the *existing* per-session queue and returns; the session runs the turn when
 * it goes idle. A daemon with its own runner would be a second execution path
 * with its own idea of which session is current.
 */

export type TickOutcome =
  | { readonly kind: "fired"; readonly occurrenceId: string; readonly result: OccurrenceRunnerResult }
  | { readonly kind: "nothing_due" }
  | { readonly kind: "lease_lost"; readonly reason: string }
  | { readonly kind: "store_failed"; readonly reason: string };

export type SchedulerLoopOptions = {
  readonly home: string;
  readonly clock: { readonly now: () => number; readonly newAttemptId: () => string };
  /** This daemon's identity; written to the discovery file at start. */
  readonly identity: DaemonIdentity;
  readonly ownerId: string;
  /** How often to look for due work. One second matches cron resolution. */
  readonly tickIntervalMs: number;
  /** Upper bound on occurrences fired in one tick. */
  readonly maxOccurrencesPerTick: number;
  /** Hands one occurrence to its destination. Returns an observation. */
  readonly runOccurrence: (occurrence: Occurrence) => Promise<OccurrenceRunnerResult>;
  /**
   * One step of work that is not a scheduled occurrence — today that is polling
   * armed watches (A07).
   *
   * A step rather than an inline loop, for two reasons. It keeps the lease, the
   * tick budget and the crash windows belonging to this file alone; and it lets a
   * capability that has its own state machine plug in without this one learning
   * it. The step runs **inside** the tick and under the same lease, so there is
   * one writer per host rather than one per feature.
   *
   * Absent means "this host does not run that capability" — the tick is then
   * exactly what it was before this option existed.
   *
   * ## Why the step is handed the record rather than a store
   *
   * A watch and a cron schedule are rows of **one** file. A step that got its own
   * store would be a second reader-writer on that file, and two read-modify-write
   * passes in one tick is exactly how a row goes missing: the second write is
   * built from a read that predates the first write.
   *
   * So the step is handed the two capabilities it actually needs — read the
   * settled occurrences, and rewrite the row list — and nothing else. It cannot
   * take the lease, cannot claim occurrences, and cannot settle one, because those
   * stay here. That is what makes "one writer per tick" a structural property
   * rather than a convention someone has to remember.
   */
  readonly runStep?: (access: {
    /** The record file this tick's writer owns. */
    readonly file: string;
    /** The occurrences already settled, for an already-fired check. */
    readonly occurrences: () => Promise<ReadonlyArray<Occurrence>>;
    /**
     * Replace the **watch** rows, leaving the cron rows untouched. Returns whether
     * it landed.
     *
     * Only watch rows, deliberately: a writer that accepted arbitrary rows could
     * rewrite a cron schedule it does not understand, and the record would be the
     * only place anyone could tell.
     */
    readonly writeRows: (watchRows: ReadonlyArray<Readonly<Record<string, unknown>>>) => boolean;
  }) => Promise<number>;
  /** Settles a delay; injected so a test does not wait in real time. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Told why the loop is ending, so a host can log or shut down cleanly. */
  readonly onStop?: (reason: string) => void;
  /**
   * The token a stop request must name to stop *this* loop.
   *
   * Defaults to the owner id, which is already unique per process. A stop file
   * naming a different token is ignored, so a request left over from a previous
   * daemon cannot stop the one a person just started.
   */
  readonly stopToken?: string;
};

/**
 * The resident loop.
 *
 * Returned as an object rather than started immediately, because a caller must be
 * able to learn the lease outcome *before* the first tick: a daemon that starts
 * ticking and only then discovers another daemon owns the schedule has already
 * done the thing it was supposed to prevent.
 */
export function createSchedulerLoop(options: SchedulerLoopOptions) {
  const stopToken = options.stopToken ?? options.ownerId;
  let running = false;
  let stopped = false;
  let leaseToken: string | undefined;
  let heartbeat: DaemonHeartbeat = { lastTickAtMs: options.clock.now(), firedCount: 0 };
  /** Guards against a tick that overruns being joined by another one. */
  let inFlight = false;

  const file = scheduleFilePath(options.home);
  const store: SchedulePort = createFileScheduleStore({
    home: options.home,
    clock: options.clock,
    ownerId: options.ownerId,
    pid: options.identity.pid,
    recurringMaxAgeMs: DEFAULT_RECURRING_MAX_AGE_MS,
  });

  async function tick(): Promise<TickOutcome> {
    const nowMs = options.clock.now();

    if (leaseToken === undefined) {
      return { kind: "lease_lost", reason: "this process holds no lease" };
    }

    const claimed = await store.claimDue(nowMs, leaseToken);
    if (!claimed.ok) {
      // A lost lease is not a retryable condition: another daemon owns the
      // schedule, and this one must stop rather than race it (ADR §4).
      return {
        kind: "lease_lost",
        reason: claimed.message,
      };
    }

    // The step runs before the occurrences are counted, and its fires join the same
    // tick budget — a host with twenty watches and twenty due schedules does one
    // bounded pass, not two unbounded ones.
    let stepFires = 0;

    if (options.runStep !== undefined) {
      try {
        stepFires = await options.runStep({
          file,
          occurrences: () => store.listOccurrences(),
          writeRows: (watchRows) => writeWatchRows(file, watchRows),
        });
      } catch {
        // One `catch`, one outcome: a failing capability step does not stop the
        // scheduler. A watch poller that cannot read its record must not take the
        // cron schedule down with it — they share a tick, not a fate. The count
        // stays zero so the heartbeat does not claim work that did not happen.
        stepFires = 0;
      }
    }

    // The step's fires reach the heartbeat **here**, before the early return
    // below. Counting them only on the path that also had due occurrences would
    // make a host that only ever runs watches report a permanently flat
    // heartbeat — which reads as "nothing is happening" and is exactly the state
    // a person cannot tell from a stalled daemon.
    if (stepFires > 0) {
      heartbeat = { lastTickAtMs: options.clock.now(), firedCount: heartbeat.firedCount + stepFires };
    }

    if (claimed.value.length === 0) {
      return stepFires > 0
        ? { kind: "fired", occurrenceId: "step", result: { outcome: "completed", result: { fires: stepFires } } }
        : { kind: "nothing_due" };
    }

    let last: TickOutcome = { kind: "nothing_due" };

    for (const occurrence of claimed.value.slice(0, options.maxOccurrencesPerTick)) {
      const result = await options.runOccurrence(occurrence);
      await store.settle(occurrence.id, result, leaseToken);
      heartbeat = { lastTickAtMs: options.clock.now(), firedCount: heartbeat.firedCount + 1 };
      last = { kind: "fired", occurrenceId: occurrence.id, result };
    }

    return last;
  }

  return {
    /**
     * Take the lease, advertise, then tick until stopped.
     *
     * Resolves with the reason it ended, so a host that awaits this knows whether
     * the daemon was asked to stop or lost its lease — the difference between a
     * clean shutdown and a silent abdication.
     */
    async run(): Promise<string> {
      const took = await store.acquireLease(options.ownerId);
      if (!took.ok) {
        const reason = `could not take the schedule lease: ${took.message}`;
        options.onStop?.(reason);
        return reason;
      }

      leaseToken = took.value;
      // A stop request left by a previous daemon must not stop this one. Clearing
      // it at start is what makes "absent means nobody asked" true again.
      clearStopRequest(options.home);
      writeDiscovery(options.home, options.identity);
      running = true;
      let reason = "stopped";
      // The idle ceiling. ADR §5 requires the sleep itself to be bounded, and this
      // is it: a `sleep` that returns immediately — a platform timer that never
      // fires, an injected stub, a clock that jumps — would otherwise turn this
      // loop into a tight cycle doing filesystem IO forever, pinning a core and
      // never yielding. The loop therefore ends itself if it passes this many
      // iterations without the clock having moved at least one tick interval.
      //
      // The threshold is a multiple of the interval rather than a count, so "we
      // did not wait" is measured against how long a wait should have been. Two
      // consecutive expected intervals is generous enough for a busy machine and
      // tight enough that a runaway stops within milliseconds rather than hours.
      let idleCycles = 0;
      let lastTickStartedAtMs = options.clock.now();
      const maxIdleCycles = 2;

      try {
        while (running && !stopped) {
          // The stop file is the channel that actually reaches a detached win32
          // daemon — see `record.ts` for why a signal does not. Checked before
          // each tick so a request lands within one interval.
          const requested = readStopRequest(options.home, stopToken);
          if (requested !== undefined) {
            reason = requested.reason;
            clearStopRequest(options.home);
            break;
          }

          if (!inFlight) {
            inFlight = true;
            const startedAtMs = options.clock.now();
            const outcome = await tick();

            inFlight = false;
            heartbeat = { lastTickAtMs: options.clock.now(), firedCount: heartbeat.firedCount };
            writeHeartbeat(options.home, heartbeat);

            if (outcome.kind === "lease_lost") {
              // Losing the lease mid-life means another daemon took over. The
              // right answer is to stop, not to retry: two schedulers firing the
              // same occurrence is the exact failure the lease exists to prevent.
              reason = outcome.reason;
              break;
            }

            idleCycles = startedAtMs - lastTickStartedAtMs < options.tickIntervalMs ? idleCycles + 1 : 0;
            lastTickStartedAtMs = startedAtMs;

            if (idleCycles >= maxIdleCycles) {
              reason =
                `the loop was not throttled: ${maxIdleCycles} consecutive ticks completed in under ` +
                `${options.tickIntervalMs}ms, so the sleep did not wait. Stopping rather than spinning.`;
              break;
            }
          }

          await options.sleep(options.tickIntervalMs);
        }
      } finally {
        inFlight = false;
        running = false;

        if (leaseToken !== undefined) {
          await store.releaseLease();
          leaseToken = undefined;
        }

        clearDiscovery(options.home);
        options.onStop?.(reason);
      }

      return reason;
    },

    /** Ask the loop to end after the current tick. */
    stop(): void {
      stopped = true;
    },

    /** Whether a tick is currently executing; for status and tests. */
    isRunning(): boolean {
      return running;
    },

    /** The current heartbeat; for status and tests. */
    currentHeartbeat(): DaemonHeartbeat {
      return heartbeat;
    },

    /** Run exactly one tick, for a caller that drives the schedule itself. */
    tickOnce(): Promise<TickOutcome> {
      return tick();
    },

    /**
     * When the next occurrence is due, or `null` when nothing is scheduled.
     *
     * Lets a host sleep until then instead of polling, which matters because a
     * daemon that wakes every second to discover nothing is a daemon that burns
     * a core to learn there is no work.
     */
    async nextDueAt(): Promise<number | null> {
      const listed = await store.list();
      if (!listed.ok) {
        return null;
      }

      const nowMs = options.clock.now();
      let soonest: number | null = null;

      for (const schedule of listed.value) {
        const due = nextDueAtMs(schedule);
        if (due === null) {
          continue;
        }

        if (soonest === null || due < soonest) {
          soonest = due;
        }
      }

      // A due-in-the-past schedule means work is waiting now, so the caller
      // should tick rather than sleep until "next".
      return soonest !== null && soonest <= nowMs ? nowMs : soonest;
    },
  };
}

/** The runner that hands a fired occurrence to its session's queue. */
export function createQueueRunner(options: {
  /** `QueueClock` from the queue port: a `now` and an id factory, nothing ambient. */
  readonly clock: QueueClock;
  readonly queuePathFor: (sessionId: string) => string;
}): (occurrence: Occurrence) => Promise<OccurrenceRunnerResult> {
  return async (occurrence) => {
    const sessionId = occurrence.sessionId;
    if (sessionId === undefined) {
      return {
        outcome: "failed",
        code: "no_session",
        message:
          "this schedule has no --session, so there is nowhere to hand the prompt. " +
          "Re-create it with --session <id>.",
      };
    }

    const enqueued = await createFileBackgroundQueue({
      path: options.queuePathFor(sessionId),
      clock: options.clock,
    }).enqueue(occurrence.prompt);
    if (enqueued.ok) {
      return {
        outcome: "completed",
        result: {
          sessionId,
          messageId: enqueued.value.id,
          note: "handed to the session queue; the turn runs when that session goes idle",
        },
      };
    }

    return {
      outcome: "failed",
      code: enqueued.code,
      message: `the prompt could not be queued: ${enqueued.code}`,
    };
  };
}
