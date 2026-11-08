import { occurrenceIdFor, type Occurrence } from "../ports/schedule.js";

/**
 * Sleeping until something happens, and noticing when it does (WP26 / A07).
 *
 * ## What this is, and why it is not a second scheduler
 *
 * "Wake me when the build finishes" and "remind me at 3am" are the same shape of
 * problem: something is true at an unknown future moment, and a side effect should
 * happen once. The reused `A06` schedule port already owns the "when" and the
 * single-writer lease; the queue already owns delivery. So this module is only
 * the part neither of them has: **deciding whether a condition is met right now,
 * and making sure a condition that stays met does not fire forever.**
 *
 * ## The three states a watch can be in
 *
 * ```text
 * idle ──condition met──> fired (terminal)
 *   │                      ▲
 *   └──cancelled──> cancelled (terminal)
 * ```
 *
 * `armed` is the only live state, and a watch is created armed. There is
 * deliberately no "armed but firing" state, because the whole failure this
 * guards against is firing twice while the condition is still true — a build that
 * takes four minutes and a file watcher that fires on every save would otherwise
 * both produce a burst.
 *
 * ## The deduplication rule, stated as a fact rather than a hope
 *
 * A watch fires **once per occurrence**, and the occurrence id is
 * `watch_<id>@<fireAtMs>` (via `watchOccurrenceId`) — the same derived shape
 * the schedule port uses. That is
 * what makes "did this already fire?" answerable from the record on disk rather
 * than from a boolean in memory that a restart would forget.
 */

export type WatchCondition =
  /** A file exists. The simplest condition there is, and the one that starts fires. */
  | { readonly kind: "file_exists"; readonly relativePath: string }
  /** A file's contents contain a string. */
  | { readonly kind: "file_contains"; readonly relativePath: string; readonly needle: string }
  /** A command exits with a given code. The exit code is the fact; its text is not. */
  | { readonly kind: "command_exit"; readonly exitCode: number }
  /** A named flag has been set — how a session signals "the thing you wanted is true". */
  | { readonly kind: "flag_set"; readonly flag: string };

export type WatchState =
  /** Waiting. This is the only live state. */
  | { readonly state: "armed"; readonly watchId: string; readonly fireAtMs: number }
  /** The condition was met and the effect was handed to the queue. Terminal. */
  | { readonly state: "fired"; readonly watchId: string; readonly firedAtMs: number; readonly messageId: string }
  /** Stopped before firing. Terminal. */
  | { readonly state: "cancelled"; readonly watchId: string; readonly cancelledAtMs: number; readonly reason: string };

export type WatchVerdict =
  /** Not yet true. Keep waiting. */
  | { readonly met: false }
  /** True, with the reason — which is what a person sees in `list`. */
  | { readonly met: true; readonly because: string };

/**
 * What the condition is evaluated against.
 *
 * A seam rather than `fs` calls scattered around, because "does this file exist"
 * is the only IO here and a test needs to decide the answer. It is also the same
 * reason the reuse is safe: nothing in this module can reach the filesystem on
 * its own.
 */
export type ConditionProbe = {
  readonly fileExists: (relativePath: string) => boolean;
  readonly fileContains: (relativePath: string, needle: string) => boolean;
  readonly lastExitCode: () => number | undefined;
  readonly flagSet: (flag: string) => boolean;
};

/**
 * Evaluate one condition.
 *
 * Every branch says *which* thing it saw, because "still waiting" for four
 * minutes is indistinguishable from "waiting for a file that never appears" once
 * someone has to decide whether to cancel it.
 */
export function evaluateCondition(condition: WatchCondition, probe: ConditionProbe): WatchVerdict {
  switch (condition.kind) {
    case "file_exists":
      return probe.fileExists(condition.relativePath)
        ? { met: true, because: `${condition.relativePath} exists` }
        : { met: false };
    case "file_contains":
      return probe.fileContains(condition.relativePath, condition.needle)
        ? { met: true, because: `${condition.relativePath} contains "${condition.needle}"` }
        : { met: false };
    case "command_exit":
      return probe.lastExitCode() === condition.exitCode
        ? { met: true, because: `the last command exited ${condition.exitCode}` }
        : { met: false };
    case "flag_set":
      return probe.flagSet(condition.flag)
        ? { met: true, because: `${condition.flag} was set` }
        : { met: false };
  }
}

/**
 * The occurrence a watch produces when its condition is met.
 *
 * Derived, not generated, for the reason above: a restart that re-derives the
 * same watch at the same fire moment must get the same occurrence id, or the
 * record cannot tell "this already fired" from "this is about to fire".
 */
export function watchOccurrenceId(watchId: string, fireAtMs: number): string {
  return occurrenceIdFor(`watch_${watchId}`, fireAtMs);
}

/**
 * The moment a watch's occurrence is derived from.
 *
 * **Always the watch's own identity, never the poll's clock.** That is what makes
 * the already-fired check work after a restart: a crash between "fired" and
 * "wrote the row" leaves the row `armed`, and the next tick derives the *same* id
 * from the same watch and finds the occurrence the previous attempt recorded.
 *
 * Deriving it from the observation instead — the obvious choice, since the
 * observation is what happened once — breaks exactly that case: the second
 * derivation lands on a different minute, finds nothing, and fires a second
 * message for a condition that has not changed. Measured: the crash case produced
 * a second message until this was derived from the watch instead.
 *
 * A deadline names its own moment, so it is stable for the same reason.
 *
 * It lives here rather than in either adapter because two copies of a derivation
 * rule drift, and the drift shows up as a duplicate notification months later.
 */
export function watchFireMoment(watch: {
  readonly trigger: { readonly kind: "deadline"; readonly atMs: number } | { readonly kind: "condition" };
  readonly createdAtMs: number;
}): number {
  return watch.trigger.kind === "deadline" ? watch.trigger.atMs : watch.createdAtMs;
}

/**
 * Whether this occurrence has already been settled.
 *
 * The single rule that stops a still-true condition from firing on every tick: an
 * occurrence is fired once, and every later tick finds the same id and stops.
 */
export function alreadyFired(
  settled: ReadonlyArray<Occurrence>,
  watchId: string,
  fireAtMs: number,
): boolean {
  const id = watchOccurrenceId(watchId, fireAtMs);
  return settled.some((occurrence) => occurrence.id === id);
}

/**
 * What firing means for the caller: a message on the session's queue, addressed
 * by the occurrence.
 *
 * Returned as a shape rather than pushed, because the queue is the only thing
 * that should ever enqueue — a watcher that opened its own would be the second
 * delivery path ADR §5 rules out.
 */
export type FireRequest = {
  readonly occurrenceId: string;
  readonly text: string;
  readonly sessionId: string;
};

export function fireRequestFor(
  watchId: string,
  fireAtMs: number,
  sessionId: string,
  text: string,
): FireRequest {
  return { occurrenceId: watchOccurrenceId(watchId, fireAtMs), text, sessionId };
}

/**
 * Why a cancel was refused.
 *
 * Separate from "this watch does not exist" because cancelling an armed watch is
 * the ordinary case and cancelling a fired one is a question worth answering
 * differently: the work already happened, and pretending otherwise would let
 * someone "cancel" a completed run and believe they had.
 */
export type CancelVerdict =
  | { readonly kind: "cancelled"; readonly state: WatchState }
  | { readonly kind: "not_found"; readonly message: string }
  | { readonly kind: "already_fired"; readonly state: WatchState }
  | { readonly kind: "already_cancelled"; readonly state: WatchState };

/**
 * Cancel a watch.
 *
 * Only an armed watch can be cancelled, and the answer names which of the three
 * other cases happened — see {@link CancelVerdict}.
 */
export function cancelWatch(state: WatchState | undefined, watchId: string, atMs: number): CancelVerdict {
  if (state === undefined) {
    return {
      kind: "not_found",
      message: `no watch ${watchId}; it may have fired already, or its schedule was removed`,
    };
  }

  if (state.state === "fired") {
    return { kind: "already_fired", state };
  }

  if (state.state === "cancelled") {
    return { kind: "already_cancelled", state };
  }

  return {
    kind: "cancelled",
    state: { state: "cancelled", watchId, cancelledAtMs: atMs, reason: "cancelled before it fired" },
  };
}

/**
 * One line about a watch, for `list`.
 *
 * An armed watch says *what it is waiting for* rather than just "armed", because
 * a list of five armed watches is a list that answers nothing.
 */
export function describeWatch(state: WatchState, condition: WatchCondition): string {
  switch (state.state) {
    case "armed":
      return `${state.watchId}  armed  until ${new Date(state.fireAtMs).toISOString()}  waiting for ${describeCondition(condition)}`;
    case "fired":
      return `${state.watchId}  fired ${new Date(state.firedAtMs).toISOString()}  (message ${state.messageId})`;
    case "cancelled":
      return `${state.watchId}  cancelled ${new Date(state.cancelledAtMs).toISOString()}  ${state.reason}`;
  }
}

/** The condition in words. */
export function describeCondition(condition: WatchCondition): string {
  switch (condition.kind) {
    case "file_exists":
      return `${condition.relativePath} to exist`;
    case "file_contains":
      return `${condition.relativePath} to contain "${condition.needle}"`;
    case "command_exit":
      return `the last command to exit ${condition.exitCode}`;
    case "flag_set":
      return `${condition.flag} to be set`;
  }
}
