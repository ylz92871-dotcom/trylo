import type { JsonObject } from "../protocol/envelope.js";

/**
 * Scheduled work — the port a fireable schedule lives behind (WP26 / A06).
 *
 * ## The three identifiers, and why there are three
 *
 * A schedule says *when*. An occurrence is *one due moment of that schedule*.
 * An attempt is *one try at running that occurrence*. Collapsing them is how a
 * scheduler ends up unable to answer "did this run, and did it run twice":
 *
 * - schedule id + fire time identifies the occurrence, and is **derived, not
 *   random** — the same schedule and the same due moment always produce the
 *   same occurrence id. That is what makes a restart re-derive the work it
 *   already owes instead of inventing a second copy of it.
 * - attempt id is random per try, because two tries at the same occurrence are
 *   genuinely different events and must be told apart in the record.
 *
 * Everything downstream (journal, queue, worker) keys off these, so a
 * duplicate delivery, a retry after a crash, and a resumed session all name the
 * same occurrence rather than three lookalikes.
 *
 * ## What this port deliberately does not do
 *
 * It does not run anything, and it does not know how a task is executed. It
 * answers three questions — what is scheduled, which occurrences are due, and
 * acknowledge that one was handled — and the host decides who runs them. A port
 * that both decided and ran would put scheduling policy inside an executor,
 * which is where the single-owner rule stops being checkable.
 *
 * ## The recovery contract, in states rather than promises
 *
 * Occurrences carry an explicit lifecycle, because "it fired" and "it
 * finished" are different facts and conflating them is how work gets lost:
 *
 * ```text
 * due ──claim──> claimed ──hand off──> dispatched ──settle──> completed
 *                  │                      │
 *                  └──cancel──> cancelled │──fail──> failed
 *                                        └──effect uncertain──> unknown
 * ```
 *
 * `unknown` is a first-class terminal, not a flavour of `failed`. It means the
 * effect may or may not have landed; it is the state a crash between "ran" and
 * "recorded the receipt" leaves behind. Answering `failed` there would invite a
 * retry of work that may already have been done, and answering `completed`
 * would be a lie about something nobody observed. A caller in `unknown` hands
 * the occurrence to reconciliation and does not retry by itself.
 */

/** A schedule's identity. Opaque to callers; stable across restarts. */
export type ScheduleId = string;

/**
 * One due moment of one schedule.
 *
 * The id is derived from `scheduleId` and `dueAtMs` (see `occurrenceIdFor`),
 * so re-reading the same due moment after a restart yields the same id and the
 * host can recognise work it already owes.
 */
export type OccurrenceId = string;

/** One try at one occurrence. Random per try — two tries are two facts. */
export type AttemptId = string;

export const SCHEDULE_FORMAT_VERSION = "1";

/**
 * How many jobs one person may have at once.
 *
 * The reused source caps at 50 (`MAX_JOBS`). Kept at the same number: it is a
 * product decision about how much unattended provider spend is reasonable, not
 * a technical limit, and quietly raising it would be a decision nobody made.
 */
export const MAX_SCHEDULES = 50;

/**
 * A recurring ceiling, applied from creation.
 *
 * A schedule that runs forever is a heap leak with a UI. `0` means unlimited,
 * which exists because a schedule created by a person who asked for "forever"
 * should say so explicitly rather than be quietly capped.
 */
export const DEFAULT_RECURRING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type ScheduleDelivery =
  /** Hand the prompt to whoever owns the session; do not wait. */
  | "queue"
  /** Run to a terminal state and report the result. */
  | "wait";

export type Schedule = {
  readonly id: ScheduleId;
  /** Validated 5-field local-time expression; see `domain/schedule-cron.ts`. */
  readonly cron: string;
  readonly prompt: string;
  readonly createdAtMs: number;
  /** False for one-shot: fire once, then delete. */
  readonly recurring: boolean;
  /**
   * When true the schedule survives this process. A non-durable one dies with
   * it — which is a real answer, not a degraded one, so it is stated rather
   * than defaulted to.
   */
  readonly durable: boolean;
  readonly delivery: ScheduleDelivery;
  /**
   * When set, fires go to this session's queue instead of the caller's own.
   * A background session outlives the turn that created the schedule, so an
   * occurrence has to name where it goes.
   */
  readonly sessionId?: string;
  /** Exempt from the recurring age-out. Not settable through the tool. */
  readonly permanent?: boolean;
  /**
   * When the last fire was recorded, epoch ms. This is the anchor for
   * re-deriving `nextDueAtMs` after a restart: a fired recurring schedule
   * resumes from where it got to, not from its creation time, which would
   * replay a week of fires in one burst.
   */
  readonly lastFiredAtMs?: number;
  /**
   * Epoch ms when the schedule stops firing. Written when a one-shot fires and
   * when a recurring schedule is deleted, so a schedule that is due but gone
   * cannot be resurrected by a crash between decision and cleanup.
   */
  readonly tombstonedAtMs?: number;
};

/** How far a schedule may fire into the future; beyond this there is no match. */
export const MAX_SCHEDULE_HORIZON_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * The lifecycle of one occurrence, as an explicit union.
 *
 * `unknown` is the reason this is a union and not three booleans: it is a state
 * a system can genuinely be in, and it needs a name that cannot be confused with
 * either success or failure.
 */
export type OccurrenceState =
  /** Due now, not yet claimed. Claimable. */
  | { readonly state: "due" }
  /** Claimed by an attempt; not yet handed to a runner. */
  | { readonly state: "claimed"; readonly attemptId: AttemptId; readonly claimedAtMs: number }
  /** Handed off. The runner owes a settle. */
  | { readonly state: "dispatched"; readonly attemptId: AttemptId; readonly dispatchedAtMs: number }
  /** Finished and the result is recorded. */
  | { readonly state: "completed"; readonly attemptId: AttemptId; readonly completedAtMs: number; readonly result: JsonObject }
  /** Finished with a known error. Safe to retry deliberately. */
  | { readonly state: "failed"; readonly attemptId: AttemptId; readonly failedAtMs: number; readonly code: string; readonly message: string }
  /** Stopped before running. Nothing was dispatched. */
  | { readonly state: "cancelled"; readonly cancelledAtMs: number; readonly reason: string }
  /**
   * The effect may or may not have landed. Terminal for the purposes of
   * "should I run it again" — the answer is no, not without reconciliation.
   */
  | { readonly state: "unknown"; readonly attemptId: AttemptId; readonly observedAtMs: number; readonly reason: string };

export type Occurrence = {
  readonly id: OccurrenceId;
  readonly scheduleId: ScheduleId;
  /** The moment this occurrence was due, epoch ms. Part of its identity. */
  readonly dueAtMs: number;
  readonly state: OccurrenceState;
  /**
   * The prompt as it stood when this occurrence was derived. Frozen so a later
   * edit of the schedule cannot change what an already-due occurrence runs.
   */
  readonly prompt: string;
  readonly delivery: ScheduleDelivery;
  readonly sessionId?: string;
};

/**
 * Deterministic occurrence identity.
 *
 * Pure so the host can derive it during recovery without reading anything, and
 * stable so the *same* due moment re-derives to the *same* id after a crash —
 * which is what makes "did I already owe this?" answerable instead of a guess.
 */
export function occurrenceIdFor(scheduleId: ScheduleId, dueAtMs: number): OccurrenceId {
  return `${scheduleId}@${dueAtMs}`;
}

/**
 * Why an occurrence operation was refused.
 *
 * Every code is something the caller can act on, which is why none are
 * swallowed: `already_tombstoned` means the schedule is gone and re-running it
 * would resurrect work the person deleted, and `not_owner` means another
 * scheduler holds the lease and this one must stop rather than race it.
 */
export type ScheduleFailureCode =
  | "invalid_expression"
  | "invalid_prompt"
  | "unknown_schedule"
  | "already_tombstoned"
  | "too_many_schedules"
  | "schedule_unreadable"
  | "schedule_unwritable"
  | "not_owner"
  | "lease_lost"
  | "occurrence_already_claimed";

export type ScheduleRefusal = { readonly ok: false; readonly code: ScheduleFailureCode; readonly message: string };

export type ScheduleResult<T> = { readonly ok: true; readonly value: T } | ScheduleRefusal;

/**
 * The clock and id factory handed to an implementation.
 *
 * Nothing ambient: no `Date.now`, no `Math.random`, no `process`. That is what
 * lets a test say exactly which occurrence is which without waiting for a
 * minute to pass, and it is why the deterministic `occurrenceIdFor` above can be
 * the only place an occurrence id is built.
 */
export type ScheduleClock = {
  readonly now: () => number;
  readonly newAttemptId: () => string;
};

/** What a host must supply to run one occurrence. Supplied per fire, not stored. */
export type OccurrenceRunner = {
  readonly run: (occurrence: Occurrence) => Promise<OccurrenceRunnerResult>;
};

/**
 * The runner's answer.
 *
 * `outcome` is the observation, not a promise: `completed` means the effect
 * landed *and* the runner saw it land. A runner that lost sight of the effect
 * reports `unknown`, which the port records as such and never as `failed`.
 * A runner told to stop reports `cancelled`: work never dispatched settles as
 * `cancelled` with the reason and no fabricated attempt result, while work
 * already dispatched settles as `unknown`, because the effect may have landed.
 * Nothing cancelled is ever retried automatically.
 */
export type OccurrenceRunnerResult =
  | { readonly outcome: "completed"; readonly result: JsonObject }
  | { readonly outcome: "failed"; readonly code: string; readonly message: string }
  | { readonly outcome: "unknown"; readonly reason: string }
  | { readonly outcome: "cancelled"; readonly reason: string };

/**
 * The durable schedule contract.
 *
 * Single-writer by lease: `claimDue` and the settle verbs require the lease
 * token the holder was given, and a stale token is refused with `lease_lost`
 * rather than quietly overwriting. A scheduler that lost its lease must stop,
 * because the new owner may already have claimed the same occurrence.
 *
 * `release` is the only way to give the lease back. Forgetting it delays the
 * next writer — a denial of service, never a corruption.
 */
export type SchedulePort = {
  /** Every live schedule, oldest first. Unreadable is `schedule_unreadable`. */
  readonly list: () => Promise<ScheduleResult<ReadonlyArray<Schedule>>>;
  /** Create one. The id is assigned here so no caller can collide with one. */
  readonly create: (
    input: Omit<Schedule, "id" | "createdAtMs">,
  ) => Promise<ScheduleResult<Schedule>>;
  /**
   * Tombstone one. Idempotent: deleting an already-tombstoned schedule reports
   * `already_tombstoned` rather than pretending it removed something.
   *
   * Tombstoning does **not** recall work already handed to a runner — see
   * `occurrenceStatesOf` for how a caller sees what is still in flight.
   */
  readonly delete: (scheduleId: ScheduleId) => Promise<ScheduleResult<boolean>>;
  /** Take the writer lease, or report who holds it. */
  readonly acquireLease: (ownerId: string) => Promise<ScheduleResult<string>>;
  /** Give it back. */
  readonly releaseLease: () => Promise<void>;
  /**
   * Occurrences due at `nowMs`, derived and not yet settled.
   *
   * Derived deterministically from the schedule and its cron, so calling this
   * twice at the same instant yields the same ids — and calling it after a
   * restart yields the ids the previous process owed.
   */
  readonly claimDue: (nowMs: number, leaseToken: string) => Promise<ScheduleResult<ReadonlyArray<Occurrence>>>;
  /** Record what happened to one occurrence. A stale lease token is refused. */
  readonly settle: (
    occurrenceId: OccurrenceId,
    outcome: OccurrenceRunnerResult,
    leaseToken: string,
  ) => Promise<ScheduleResult<Occurrence>>;
  /** States of the occurrences of one schedule — how a delete can be honest. */
  readonly occurrenceStatesOf: (scheduleId: ScheduleId) => Promise<ScheduleResult<ReadonlyArray<OccurrenceState>>>;
  /**
   * Every settled occurrence on record.
   *
   * Exposed because a watch's already-fired check is a question about *this*
   * record, and re-reading the file behind the store's back would be a second
   * reader on a file this store owns.
   */
  readonly listOccurrences: () => Promise<ReadonlyArray<Occurrence>>;
};
