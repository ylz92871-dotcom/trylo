import {
  MAX_SCHEDULE_HORIZON_MS,
  occurrenceIdFor,
  type Occurrence,
  type OccurrenceRunnerResult,
  type OccurrenceState,
  type Schedule,
  type ScheduleFailureCode,
  type ScheduleResult,
} from "../ports/schedule.js";
import { computeNextCronRun, parseCronExpression } from "./schedule-cron.js";

/**
 * Scheduling decisions, with no clock, no filesystem and no IO (WP26 / A06).
 *
 * Everything here answers a question a host must be able to answer *before* it
 * does anything irreversible: is this schedule valid, which occurrences are due
 * at this instant, is this lease still ours, and what does a delete actually
 * stop. Those questions are pure, so they are decided here and tested without
 * waiting for a minute to pass.
 *
 * Mechanical reuse of old CLI `utils/cronTasks.ts` (sha256 prefix
 * `af141a07fe8`) for the anchor rule, and `utils/cronScheduler.ts` for the
 * age-out. Two things are deliberately *not* reused, because they are the
 * defects this package exists to remove:
 *
 *  - The old scheduler treated a task's next fire as recomputable from
 *    `createdAt`, so a recurring task's fire time was lost on restart and it
 *    either replayed a week of fires at once or re-armed from the wrong point.
 *    Here `lastFiredAtMs` is the anchor, so a restart resumes.
 *  - The old scheduler stamped `lastFiredAt` and then fired, so a crash between
 *    the two lost the fire entirely. Here an occurrence is *derived* from
 *    `(scheduleId, dueAtMs)` and its state is recorded, so a crash leaves a
 *    nameable state rather than a hole.
 */

/** Validated creation input, or the reason it is not acceptable. */
export type CreateValidation =
  | {
      readonly ok: true;
      readonly value: {
        readonly cron: string;
        readonly prompt: string;
        readonly recurring: boolean;
        readonly durable: boolean;
        readonly delivery: Schedule["delivery"];
        readonly sessionId?: string;
      };
    }
  | { readonly ok: false; readonly code: ScheduleFailureCode; readonly message: string };

const MAX_PROMPT_CHARS = 20_000;

/**
 * Validate one creation request.
 *
 * The expression is checked *and* required to have a reachable next fire: an
 * expression that parses but never matches ("0 0 30 2 *" — the 30th of
 * February) would otherwise be accepted and then never run, which reads to the
 * person as the scheduler being broken.
 */
export function validateSchedule(raw: {
  readonly cron: unknown;
  readonly prompt: unknown;
  readonly recurring?: unknown;
  readonly durable?: unknown;
  readonly delivery?: unknown;
  readonly sessionId?: unknown;
}): CreateValidation {
  if (typeof raw.cron !== "string") {
    return { ok: false, code: "invalid_expression", message: "cron must be a string" };
  }

  const fields = parseCronExpression(raw.cron);
  if (fields === null) {
    return {
      ok: false,
      code: "invalid_expression",
      message: `invalid cron expression '${raw.cron}': expected 5 fields (M H DoM Mon DoW)`,
    };
  }

  // Anchor from now, so an expression that cannot match within a year is
  // refused at creation rather than silently never firing.
  if (computeNextCronRun(fields, new Date()) === null) {
    return {
      ok: false,
      code: "invalid_expression",
      message: `cron expression '${raw.cron}' does not match any date within ${Math.round(
        MAX_SCHEDULE_HORIZON_MS / 86_400_000,
      )} days`,
    };
  }

  if (typeof raw.prompt !== "string" || raw.prompt.trim().length === 0) {
    return { ok: false, code: "invalid_prompt", message: "prompt must be a non-empty string" };
  }

  if (raw.prompt.length > MAX_PROMPT_CHARS) {
    return {
      ok: false,
      code: "invalid_prompt",
      message: `prompt is ${raw.prompt.length} characters; the limit is ${MAX_PROMPT_CHARS}`,
    };
  }

  const delivery = raw.delivery === "wait" ? "wait" : "queue";
  if (raw.delivery !== undefined && raw.delivery !== "queue" && raw.delivery !== "wait") {
    return { ok: false, code: "invalid_prompt", message: "delivery must be 'queue' or 'wait'" };
  }

  if (raw.sessionId !== undefined && (typeof raw.sessionId !== "string" || raw.sessionId.length === 0)) {
    return { ok: false, code: "invalid_prompt", message: "sessionId must be a non-empty string" };
  }

  return {
    ok: true,
    value: {
      // Stored trimmed-and-normalised so two schedules that differ only in
      // spacing are the same schedule text when rendered back.
      cron: raw.cron.trim().replace(/\s+/g, " "),
      prompt: raw.prompt,
      recurring: raw.recurring !== false,
      durable: raw.durable === true,
      delivery,
      ...(typeof raw.sessionId === "string" ? { sessionId: raw.sessionId } : {}),
    },
  };
}

/**
 * The next due moment of one schedule, or `null` when it has none left.
 *
 * ## The anchor is `lastFiredAtMs`, not `createdAtMs`
 *
 * This is the restart rule, and it is the reason the field exists. A recurring
 * schedule that fired yesterday must next fire relative to *yesterday*, not
 * relative to its creation a week ago — anchoring on creation makes the walk
 * start in the past and either fire immediately or replay every missed slot.
 *
 * A **one-shot** is different: its fire time is pinned by the person ("remind
 * me at 3pm on the 28th"), so it anchors on `createdAtMs` and keeps that
 * anchor even after firing — a one-shot that is re-read after it fired must not
 * silently acquire a second due time.
 *
 * ## This answers "when next", never "is it due"
 *
 * The second parameter is the *anchor for the walk* when the schedule has never
 * fired — the moment the schedule was created, or the moment recovery is asking
 * about. It is not a comparison against the host clock, and conflating the two
 * is a bug this function's shape prevents: whether an occurrence is due is
 * `dueAtMs <= nowMs`, and that comparison belongs to the caller, which is the
 * only place that knows what "now" means for this host.
 *
 * The missed-fire case is handled by the anchor, not by a special branch. A
 * scheduler that was down for a week still reports the *first* slot after its
 * last fire; `dueOccurrences` compares that against now and finds it in the past,
 * which is how a long gap produces one owed occurrence rather than a week of
 * them.
 */
export function nextDueAtMs(schedule: Schedule): number | null {
  const fields = parseCronExpression(schedule.cron);
  if (fields === null) {
    return null;
  }

  if (schedule.tombstonedAtMs !== undefined) {
    return null;
  }

  const anchor = schedule.recurring ? (schedule.lastFiredAtMs ?? schedule.createdAtMs) : schedule.createdAtMs;
  const next = computeNextCronRun(fields, new Date(anchor));

  return next === null ? null : next.getTime();
}

/**
 * Occurrences due at `nowMs`, derived from the schedules and nothing else.
 *
 * Deterministic on purpose. Given the same schedules and the same `nowMs`, this
 * returns the same ids — which is what lets a host that crashed mid-dispatch
 * come back, call it again, and recognise the occurrence it already owed rather
 * than creating a second one.
 *
 * A schedule whose due moment is more than one step behind `nowMs` is *not*
 * back-filled: the anchor is the last fire, so a host that was down for a week
 * still derives the *first* slot after that fire and owes one occurrence rather
 * than a week of them.
 */
export function dueOccurrences(
  schedules: ReadonlyArray<Schedule>,
  nowMs: number,
): ReadonlyArray<Occurrence> {
  const due: Array<Occurrence> = [];

  for (const schedule of schedules) {
    if (schedule.tombstonedAtMs !== undefined) {
      continue;
    }

    const dueAtMs = nextDueAtMs(schedule);
    if (dueAtMs === null || dueAtMs > nowMs) {
      continue;
    }

    due.push(newOccurrence(schedule, dueAtMs));
  }

  // Earliest first, then by id, so two hosts racing on the same schedules claim
  // in the same order and the race is decided by the lease rather than by
  // iteration order.
  return due.sort((left, right) =>
    left.dueAtMs === right.dueAtMs
      ? left.id < right.id
        ? -1
        : left.id > right.id
          ? 1
          : 0
      : left.dueAtMs - right.dueAtMs,
  );
}

/**
 * Build the occurrence for one due moment.
 *
 * The prompt and delivery are **frozen here**, at derivation time. Editing a
 * schedule after an occurrence is due must not change what that occurrence
 * runs: the person was promised the prompt that existed when it fired.
 */
export function newOccurrence(schedule: Schedule, dueAtMs: number): Occurrence {
  return {
    id: occurrenceIdFor(schedule.id, dueAtMs),
    scheduleId: schedule.id,
    dueAtMs,
    state: { state: "due" },
    prompt: schedule.prompt,
    delivery: schedule.delivery,
    ...(schedule.sessionId === undefined ? {} : { sessionId: schedule.sessionId }),
  };
}

/**
 * Whether a recurring schedule has outlived its ceiling.
 *
 * Reused from `cronScheduler.ts::isRecurringTaskAged`, including the two
 * exemptions that make it usable: a permanent schedule never ages, and a limit
 * of `0` means unlimited. One-shots never age out by age — they are removed
 * when they fire.
 */
export function isRecurringScheduleAged(
  schedule: Schedule,
  nowMs: number,
  maxAgeMs: number,
): boolean {
  if (maxAgeMs === 0 || schedule.recurring !== true || schedule.permanent === true) {
    return false;
  }
  return nowMs - schedule.createdAtMs >= maxAgeMs;
}

/**
 * What a delete actually stops.
 *
 * The reused source deleted rows from a JSON file and called it done, which
 * leaves work already handed to a runner running to completion — the person
 * cancelled the schedule and the side effect happened anyway. So deletion is
 * answered as three separate facts, because they have three different remedies:
 *
 * - `not_yet_due` — nothing was ever handed out; the tombstone is enough.
 * - `claimed_or_dispatched` — a runner owes a settle. The caller must decide
 *   whether to cancel it or wait; the port refuses to pretend either happened.
 * - `unknown` — an earlier attempt may or may not have run. Tombstoning does
 *   not resolve this and must not be reported as if it did.
 *
 * The union is what forces a caller to handle the second case, which a boolean
 * cannot.
 */
export type DeleteConsequence =
  | { readonly kind: "not_yet_due" }
  | { readonly kind: "in_flight"; readonly occurrence: Occurrence }
  | { readonly kind: "unknown_in_flight"; readonly occurrence: Occurrence }
  | { readonly kind: "already_tombstoned"; readonly tombstonedAtMs: number };

/**
 * Report what deleting one schedule would leave behind.
 *
 * Reads only the recorded states; it never derives a new occurrence, because
 * "what if this fires" is not what the person asked — they asked about work that
 * already exists.
 */
export function deleteConsequence(
  schedule: Schedule | undefined,
  occurrences: ReadonlyArray<Occurrence>,
): DeleteConsequence {
  if (schedule === undefined) {
    return { kind: "already_tombstoned", tombstonedAtMs: 0 };
  }

  if (schedule.tombstonedAtMs !== undefined) {
    return { kind: "already_tombstoned", tombstonedAtMs: schedule.tombstonedAtMs };
  }

  const inFlight = occurrences.find(
    (occurrence) =>
      occurrence.scheduleId === schedule.id &&
      (occurrence.state.state === "claimed" || occurrence.state.state === "dispatched"),
  );
  if (inFlight !== undefined) {
    return { kind: "in_flight", occurrence: inFlight };
  }

  const uncertain = occurrences.find(
    (occurrence) => occurrence.scheduleId === schedule.id && occurrence.state.state === "unknown",
  );
  if (uncertain !== undefined) {
    return { kind: "unknown_in_flight", occurrence: uncertain };
  }

  return { kind: "not_yet_due" };
}

/**
 * Whether the lease token still belongs to the caller.
 *
 * Kept here rather than inline in an adapter because "stale holder must stop"
 * is the rule, and a rule that lives in three adapters becomes three slightly
 * different rules. An empty token is never valid: an unauthenticated writer is
 * exactly what the lease exists to prevent.
 */
export function leaseIsValid(
  held: { readonly token: string; readonly ownerId: string } | undefined,
  presented: string,
  ownerId: string,
): ScheduleResult<true> {
  if (held === undefined) {
    return { ok: false, code: "lease_lost", message: "no lease is held; acquire one before writing" };
  }

  if (presented.length === 0) {
    return { ok: false, code: "lease_lost", message: "an empty lease token is never valid" };
  }

  if (held.token !== presented || held.ownerId !== ownerId) {
    return {
      ok: false,
      code: "lease_lost",
      message: `lease moved to ${held.ownerId}; this scheduler must stop writing`,
    };
  }

  return { ok: true, value: true };
}

/**
 * Schedules that should be removed once their occurrence settles.
 *
 * A one-shot is done once it fires; a recurring schedule that has outlived its
 * ceiling gets one final fire and then goes, which is the reused behaviour and
 * the reason the ceiling exists.
 *
 * Lives here rather than in `schedule-queries.ts` because it is a decision, not
 * a lookup: it consults the age rule, and a module that only asked questions
 * about a collection would not own it.
 */
export function shouldRetireAfterFire(schedule: Schedule, nowMs: number, maxAgeMs: number): boolean {
  if (schedule.recurring !== true) {
    return true;
  }
  return isRecurringScheduleAged(schedule, nowMs, maxAgeMs);
}

/**
 * The next state after a settle attempt.
 *
 * Exhaustive over the runner's outcomes so a new outcome cannot be added
 * without deciding what it means for the occurrence. In particular `unknown` is
 * a terminal state here and never a retry: retrying an effect nobody observed is
 * how a file gets written twice.
 *
 * `cancelled` splits on whether the work left this process. `due` and `claimed`
 * never reached a runner, so they settle as `cancelled` with the reason and no
 * fabricated attempt result. `dispatched` already did, so an interruption is an
 * observation gap rather than proof nothing ran: it settles as `unknown` with
 * the attempt kept for reconciliation, and is never recorded as `completed`.
 * An already-terminal occurrence stays as it is — a late stop must not rewrite
 * what was recorded.
 */
export function settledState(
  current: OccurrenceState,
  outcome: OccurrenceRunnerResult,
  nowMs: number,
): OccurrenceState {
  const attemptId = current.state === "due" ? "unattributed" : "attemptId" in current ? current.attemptId : "unattributed";
  switch (outcome.outcome) {
    case "completed":
      return { state: "completed", attemptId, completedAtMs: nowMs, result: outcome.result };
    case "failed":
      return { state: "failed", attemptId, failedAtMs: nowMs, code: outcome.code, message: outcome.message };
    case "unknown":
      return { state: "unknown", attemptId, observedAtMs: nowMs, reason: outcome.reason };
    case "cancelled": {
      if (
        current.state === "completed" ||
        current.state === "failed" ||
        current.state === "cancelled" ||
        current.state === "unknown"
      ) {
        return current;
      }

      if (current.state === "dispatched") {
        return { state: "unknown", attemptId, observedAtMs: nowMs, reason: outcome.reason };
      }

      return { state: "cancelled", cancelledAtMs: nowMs, reason: outcome.reason };
    }
  }
}
