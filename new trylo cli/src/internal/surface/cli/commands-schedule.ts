import { createFileBackgroundQueue } from "../../adapters/queue-store/file-queue.js";
import { createFileScheduleStore } from "../../adapters/schedule-store/index.js";
import { liveSchedules } from "../../domain/schedule-queries.js";
import { nextDueAtMs } from "../../domain/schedule.js";
import { cronToHuman } from "../../domain/schedule-cron-human.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { BackgroundQueue } from "../../ports/background-queue.js";
import {
  DEFAULT_RECURRING_MAX_AGE_MS,
  type Occurrence,
  type OccurrenceRunnerResult,
  type Schedule,
  type ScheduleFailureCode,
  type SchedulePort,
} from "../../ports/schedule.js";
import type {
  ScheduleAddOptions,
  ScheduleListOptions,
  ScheduleParse,
  ScheduleRemoveOptions,
  ScheduleRunOptions,
} from "./args-schedule.js";
import type { CliContext } from "./context.js";
import { relativeTime } from "./humanize.js";
import { scheduleHome } from "./schedule-paths.js";
import { sessionQueuePath } from "./session-paths.js";

/**
 * `trylo schedule` handlers (WP26 / A06).
 *
 * ## What firing actually does
 *
 * A `queue`-delivery occurrence is handed to the **existing** per-session
 * background queue (`ports/background-queue.ts`, built by WP08) and nothing
 * else. That is the whole execution path, and it is deliberately not a second
 * one: the scheduler's job is to decide *when*, and the queue plus the session
 * already own *what happens next*. A scheduler with its own runner would be a
 * second way to start a turn, with its own idea of which session is current.
 *
 * The consequence worth stating: **firing is durable but not synchronous.** Once
 * the message is in the queue, the turn happens when that session next goes
 * idle, and `run` has exited by then. That is the same promise `trylo queue
 * --message` makes, and reusing it means one queue, one dispatch rule, one
 * place where a message can be dropped before it is delivered.
 *
 * ## A refused read is never an empty list
 *
 * `list` on an unreadable record exits with a message, because "you have nothing
 * scheduled" and "I could not read your schedules" lead a person to opposite
 * conclusions and only one of them is true.
 */

const TRANSIENT: ReadonlySet<ScheduleFailureCode> = new Set(["not_owner", "schedule_unwritable"]);

function exitCodeFor(code: ScheduleFailureCode): ExitCode {
  return TRANSIENT.has(code) ? EXIT_CODES.TEMPORARY : EXIT_CODES.USAGE;
}

/** What a refusal means for the person reading it, and what they can do. */
function explain(code: ScheduleFailureCode): { readonly message: string; readonly hint: string } {
  switch (code) {
    case "invalid_expression":
      return {
        message: "that cron expression is not a 5-field expression",
        hint: 'use minute hour day-of-month month day-of-week, e.g. "0 9 * * 1-5"',
      };
    case "invalid_prompt":
      return { message: "the prompt is empty", hint: "pass --prompt with the text to run" };
    case "too_many_schedules":
      return { message: "you already have the maximum number of schedules", hint: "remove one first" };
    case "unknown_schedule":
      return { message: "no such schedule", hint: "run `trylo schedule list` to see the ids" };
    case "already_tombstoned":
      return { message: "that schedule is already deleted", hint: "nothing left to do" };
    case "not_owner":
      return {
        message: "another scheduler holds the lease",
        hint: "only one scheduler runs at a time; the other one is already doing this",
      };
    case "lease_lost":
      return {
        message: "this process no longer holds the scheduler lease",
        hint: "another scheduler took over; stop rather than race it",
      };
    case "occurrence_already_claimed":
      return { message: "another scheduler already claimed that occurrence", hint: "nothing to do here" };
    case "schedule_unreadable":
      return {
        message: "the schedule record could not be read",
        hint: "check that the file is intact; it has not been rewritten",
      };
    case "schedule_unwritable":
      return { message: "the schedule record could not be written", hint: "check permissions and free space" };
  }
}

function storeOf(ctx: CliContext, ownerId: string): SchedulePort {
  return createFileScheduleStore({
    home: scheduleHome(ctx.homeDir, ctx.env),
    clock: { now: ctx.now, newAttemptId: () => ctx.newId("att") },
    ownerId,
    // The pid is written for a human reading a stuck lease and is never read
    // back for a decision — see `lease.ts`. `-1` marks "not reported" so it can
    // never be mistaken for a live process.
    pid: -1,
    recurringMaxAgeMs: DEFAULT_RECURRING_MAX_AGE_MS,
  });
}

/**
 * The queue a `queue`-delivery occurrence goes to.
 *
 * `sessionQueuePath` is the same path formula `commands-queue.ts` uses, from the
 * same home, so a scheduled message and a typed one are indistinguishable to the
 * session that receives them — and, more importantly, land in one queue with one
 * dispatch rule rather than two queues with two.
 */
function queueOf(ctx: CliContext, sessionId: string): BackgroundQueue {
  return createFileBackgroundQueue({
    path: sessionQueuePath(ctx.homeDir, ctx.env, sessionId),
    clock: { now: ctx.now, newId: ctx.newId },
  });
}

/**
 * Run one occurrence.
 *
 * The result is an **observation**, and the distinction is the whole contract:
 * enqueueing successfully is `completed`; a queue that could not be written is
 * `failed` with a code; and a queue whose write succeeded but whose effect cannot
 * be confirmed from here is `unknown`. Reporting `completed` for the last case
 * would claim a delivery nobody observed, and the caller would retire the
 * schedule on the strength of it.
 */
async function runOccurrence(
  ctx: CliContext,
  occurrence: Occurrence,
): Promise<OccurrenceRunnerResult> {
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

  const enqueued = await queueOf(ctx, sessionId).enqueue(occurrence.prompt);
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
}

export async function handleSchedule(ctx: CliContext, parsed: ScheduleParse): Promise<ExitCode> {
  if (parsed.verb === "error") {
    ctx.stderr(`${parsed.message}\n${parsed.hint}\n`);
    return EXIT_CODES.USAGE;
  }

  if (parsed.verb === "help") {
    ctx.stdout(scheduleHelpText());
    return EXIT_CODES.OK;
  }

  if (parsed.verb === "add") {
    return handleAdd(ctx, parsed.options);
  }

  if (parsed.verb === "list") {
    return handleList(ctx, parsed.options);
  }

  if (parsed.verb === "remove") {
    return handleRemove(ctx, parsed.options);
  }

  return handleRun(ctx, parsed.options);
}

async function handleAdd(ctx: CliContext, options: ScheduleAddOptions): Promise<ExitCode> {
  const store = storeOf(ctx, ctx.newId("owner"));
  const created = await store.create({
    cron: options.cron,
    prompt: options.prompt,
    recurring: options.recurring,
    durable: options.durable,
    delivery: options.wait ? "wait" : "queue",
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  });
  if (!created.ok) {
    const { message, hint } = explain(created.code);
    reportRefusal(ctx, created.code, message, hint, options.json);
    return exitCodeFor(created.code);
  }

  const schedule = created.value;

  if (options.json) {
    ctx.stdout(`${JSON.stringify({ id: schedule.id, cron: schedule.cron, recurring: schedule.recurring, durable: schedule.durable, sessionId: schedule.sessionId ?? null })}\n`);
    return EXIT_CODES.OK;
  }

  ctx.stdout(`Scheduled ${schedule.id} — ${cronToHuman(schedule.cron)}.\n`);
  ctx.stdout(
    options.durable
      ? "It survives this process. `trylo schedule run` fires everything due now.\n"
      : "It lives in this session only; pass --durable to keep it.\n",
  );

  if (options.sessionId === undefined) {
    ctx.stdout("No --session given, so it cannot fire yet; re-create it with --session <id>.\n");
  }

  return EXIT_CODES.OK;
}

async function handleList(ctx: CliContext, options: ScheduleListOptions): Promise<ExitCode> {
  const store = storeOf(ctx, ctx.newId("owner"));
  const listed = await store.list();
  if (!listed.ok) {
    const { message, hint } = explain(listed.code);
    reportRefusal(ctx, listed.code, message, hint, options.json);
    return exitCodeFor(listed.code);
  }

  const live = liveSchedules(listed.value);
  const nowMs = ctx.now();

  if (options.json) {
    ctx.stdout(`${JSON.stringify(live.map((schedule) => describe(schedule, nowMs)))}\n`);
    return EXIT_CODES.OK;
  }

  if (live.length === 0) {
    ctx.stdout("no schedules\n");
    return EXIT_CODES.OK;
  }

  ctx.stdout(
    live.map((schedule) => {
      const next = nextDueAtMs(schedule);
      const when = next === null ? "never" : `${relativeTime(next, nowMs)} (${new Date(next).toISOString()})`;
      return `${schedule.id}  ${cronToHuman(schedule.cron).padEnd(24)}  next: ${when}  ${schedule.durable ? "durable" : "session"}`;
    }).join("\n") + "\n",
  );

  return EXIT_CODES.OK;
}

async function handleRemove(ctx: CliContext, options: ScheduleRemoveOptions): Promise<ExitCode> {
  const store = storeOf(ctx, ctx.newId("owner"));
  const removed = await store.delete(options.scheduleId);
  if (!removed.ok) {
    const { message, hint } = explain(removed.code);
    reportRefusal(ctx, removed.code, message, hint, options.json);
    return exitCodeFor(removed.code);
  }

  // State the part a boolean cannot: deleting stops *future* work and does not
  // recall anything already handed to a runner — and `unknown` (effect may or
  // may not have landed) counts as in flight, because deleting does not
  // resolve it; it needs reconciliation. See `domain/schedule.ts` —
  // `unknown` is terminal for "should I run it again" (no), not for "did it
  // run" (unanswered).
  const states = await store.occurrenceStatesOf(options.scheduleId);
  const hasRunner = states.ok && states.value.some((state) => state.state === "claimed" || state.state === "dispatched");
  const hasUnknown = states.ok && states.value.some((state) => state.state === "unknown");
  const inFlight = hasRunner || hasUnknown;

  if (options.json) {
    ctx.stdout(
      `${JSON.stringify({ id: options.scheduleId, removed: true, workInFlight: inFlight, unknownInFlight: hasUnknown })}\n`,
    );
    return EXIT_CODES.OK;
  }

  ctx.stdout(`Removed ${options.scheduleId}; it will not fire again.\n`);

  if (hasRunner) {
    ctx.stdout("One occurrence was already handed to a runner and will still complete.\n");
  }

  if (hasUnknown) {
    ctx.stdout(
      "One occurrence is in unknown state (its effect may or may not have landed); deleting does not resolve it — it needs reconciliation.\n",
    );
  }

  return EXIT_CODES.OK;
}

async function handleRun(ctx: CliContext, options: ScheduleRunOptions): Promise<ExitCode> {
  // One owner id for the whole handler. The store was constructed with it and
  // re-checks it on every write, so passing a *different* id to `acquireLease`
  // would make the store refuse its own lease — a refusal that looks like "another
  // scheduler holds it" and is really just two ids for one process.
  const ownerId = ctx.newId("owner");
  const store = storeOf(ctx, ownerId);
  const took = await store.acquireLease(ownerId);
  if (!took.ok) {
    const { message, hint } = explain(took.code);
    reportRefusal(ctx, took.code, message, hint, options.json);
    return exitCodeFor(took.code);
  }

  try {
    const nowMs = ctx.now();
    const claimed = await store.claimDue(nowMs, took.value);
    if (!claimed.ok) {
      const { message, hint } = explain(claimed.code);
      reportRefusal(ctx, claimed.code, message, hint, options.json);
      return exitCodeFor(claimed.code);
    }

    const settled: Array<{ readonly id: string; readonly outcome: string }> = [];

    for (const occurrence of claimed.value) {
      const outcome = await runOccurrence(ctx, occurrence);
      await store.settle(occurrence.id, outcome, took.value);
      settled.push({ id: occurrence.id, outcome: outcome.outcome });
    }

    if (options.json) {
      ctx.stdout(`${JSON.stringify({ dueAtMs: nowMs, fired: settled })}\n`);
      return EXIT_CODES.OK;
    }

    if (settled.length === 0) {
      ctx.stdout("nothing due\n");
      return EXIT_CODES.OK;
    }

    for (const entry of settled) {
      ctx.stdout(`${entry.id}  ${entry.outcome}\n`);
    }

    return EXIT_CODES.OK;
  } finally {
    // The lease goes back whatever happened above. Forgetting it would not lose
    // data — it would leave the scheduler locked until somebody looked at the
    // lock file, which is a denial of service with no owner to go looking.
    await store.releaseLease();
  }
}

function describe(schedule: Schedule, nowMs: number) {
  const next = nextDueAtMs(schedule);
  return {
    id: schedule.id,
    cron: schedule.cron,
    human: cronToHuman(schedule.cron),
    recurring: schedule.recurring,
    durable: schedule.durable,
    nextDueAtMs: next,
    promptPreview: schedule.prompt.slice(0, 80),
    createdAtMs: schedule.createdAtMs,
    ageMs: nowMs - schedule.createdAtMs,
  };
}

function reportRefusal(
  ctx: CliContext,
  code: ScheduleFailureCode,
  message: string,
  hint: string,
  json: boolean,
): void {
  if (json) {
    ctx.stdout(`${JSON.stringify({ ok: false, code, message })}\n`);
    return;
  }
  ctx.stderr(`${message}: ${code}\n${hint}\n`);
}

function scheduleHelpText(): string {
  return [
    "trylo schedule — work that runs later without this terminal open",
    "",
    "  schedule add --cron <expr> --prompt <text> [--once] [--durable] [--session <id>]",
    "  schedule list [--json]",
    "  schedule remove <scheduleId>",
    "  schedule run [--json]        fire everything due now",
    "",
    "The expression is 5 local-time fields: minute hour day-of-month month day-of-week.",
    'e.g. "0 9 * * 1-5" is 9am on weekdays; "*/5 * * * *" is every five minutes.',
    "",
    "A schedule hands its prompt to the session queue. The turn runs when that",
    "session next goes idle, so `run` does not wait for the answer.",
    "",
  ].join("\n");
}
