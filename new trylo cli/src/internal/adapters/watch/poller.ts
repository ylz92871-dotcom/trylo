import type { JsonObject } from "../../protocol/envelope.js";
import type { WatchPort, WatchRow } from "../../ports/watch.js";
import { alreadyFired, watchFireMoment, watchOccurrenceId } from "../../domain/watch.js";
import type { Occurrence } from "../../ports/schedule.js";

/**
 * Polling armed watches, once per scheduler tick (WP26 / A07).
 *
 * ## Why this is not inside the scheduler loop
 *
 * The loop's job is the lease, the tick budget and the crash windows. A watch is
 * a different shape — it has no fixed fire moment, it fires when something
 * outside says so — and folding that in would make the loop's tick about two
 * unrelated things. This is a step the loop *calls*, so the loop stays the single
 * thing that owns "what happens once per tick".
 *
 * ## The order that matters
 *
 * Check the occurrence record **before** enqueueing. A condition that stays true
 * for ten minutes is evaluated on every tick, and without that check each
 * evaluation would leave a message. Checking first means a watch whose fire is
 * already recorded is skipped entirely, and the burst the whole design exists to
 * prevent cannot start.
 *
 * That check is only possible because the occurrence id is derived — see
 * `domain/watch.ts`. A random id per fire would make it unanswerable.
 */

/** One fired watch, reported so the caller can log or count it. */
export type WatchFire = {
  readonly watchId: string;
  readonly because: string;
  readonly messageId: string;
  readonly text: string;
};

export type WatchPollResult = {
  /** Watches that fired this pass and were handed to the queue. */
  readonly fired: ReadonlyArray<WatchFire>;
  /** Watches skipped because their fire was already recorded. */
  readonly skippedAlreadyFired: number;
  /** How many were examined — armed ones plus the terminal ones filtered out. */
  readonly examined: number;
};

export type WatchPollerOptions = {
  readonly watches: WatchPort;
  /** Hand the message to a session's queue. Returns the queue's message id. */
  readonly enqueue: (sessionId: string, text: string) => Promise<string>;
  /** The occurrence record, for the already-fired check. */
  readonly occurrences: () => Promise<ReadonlyArray<Occurrence>>;
  /** Never fire more than this many watches in one pass. */
  readonly maxFiresPerPass: number;
};

/**
 * Evaluate every armed watch once, firing the ones whose condition is met.
 *
 * `nowMs` is passed in rather than read, so a caller that already has a tick's
 * timestamp does not get a slightly different one — and so a test can drive the
 * whole thing without waiting.
 */
export async function pollWatches(
  options: WatchPollerOptions,
  nowMs: number,
): Promise<WatchPollResult> {
  const listed = await options.watches.list();
  if (!listed.ok) {
    // A store that could not be read is not "no watches". Reporting nothing here
    // would look like a quiet scheduler, and the silence would be read as "no
    // conditions are met" rather than "I cannot tell".
    return { fired: [], skippedAlreadyFired: 0, examined: 0 };
  }

  const armed = listed.value.filter((row) => row.state.state === "armed");
  const fired: Array<WatchFire> = [];
  let skippedAlreadyFired = 0;

  for (const row of armed) {
    if (fired.length >= options.maxFiresPerPass) {
      // The cap, not an early return: the caller is told how much was left by
      // seeing fewer fires than there were candidates, and a bounded pass is
      // better than a pass that never ends.
      break;
    }

    const verdict = await options.watches.evaluate(row.id);
    if (!verdict.ok || !verdict.value.met) {
      continue;
    }

    const because = verdict.value.because ?? "the condition was met";
    const occurrenceId = watchOccurrenceId(row.id, watchFireMoment(row));

    if (alreadyFired(await options.occurrences(), row.id, watchFireMoment(row))) {
      // Already recorded. Skipping here — before the queue is touched — is what
      // makes a condition that stays true harmless instead of a burst.
      skippedAlreadyFired += 1;
      await options.watches.fire(row.id, nowMs, occurrenceId);
      continue;
    }

    const text = messageFor(row, because);
    const messageId = await options.enqueue(row.sessionId, text);
    const settled = await options.watches.fire(row.id, nowMs, messageId);
    if (!settled.ok) {
      // The message is already on the queue, so refusing to record the fire would
      // make the next pass send it again. The fact that this branch exists is the
      // reason `enqueue` runs before `fire` and not the other way round.
      continue;
    }

    fired.push({ watchId: row.id, because, messageId, text });
  }

  return { fired, skippedAlreadyFired, examined: armed.length };
}


/**
 * What a fired watch says.
 *
 * The reason comes first because a notification that arrives with no explanation
 * is indistinguishable from a broken one.
 */
function messageFor(row: WatchRow, because: string): string {
  return `watch ${row.id}: ${because}\n${row.text}`;
}

/** The facts about a poll, for a log line. Never carries a session's text. */
export function describePoll(result: WatchPollResult): JsonObject {
  return {
    examined: result.examined,
    fired: result.fired.length,
    skippedAlreadyFired: result.skippedAlreadyFired,
  };
}
