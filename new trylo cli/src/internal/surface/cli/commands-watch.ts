import path from "node:path";

import { createFileBackgroundQueue } from "../../adapters/queue-store/file-queue.js";
import { readScheduleFile } from "../../adapters/schedule-store/index.js";
import { writeWatchRows } from "../../adapters/daemon/record-rows.js";
import { createFileWatchStore } from "../../adapters/watch/file-watch-store.js";
import { nodeConditionProbe } from "../../adapters/watch/node-probe.js";
import { alreadyFired, watchFireMoment } from "../../domain/watch.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { BackgroundQueue } from "../../ports/background-queue.js";
import type { WatchPort } from "../../ports/watch.js";
import type {
  WatchAddOptions,
  WatchCancelOptions,
  WatchCheckOptions,
  WatchForgetOptions,
  WatchListOptions,
  WatchParse,
} from "./args-watch.js";
import { resolveWatchTrigger } from "./args-watch.js";
import type { CliContext } from "./context.js";
import { schedulePath } from "./schedule-paths.js";
import { isValidSessionId, sessionQueuePath, tryloHome } from "./session-paths.js";
import {
  describeHuman,
  describeJson,
  exitCodeForWatch as exitCodeFor,
  explainWatch as explain,
  reportArmed,
  reportQueueRefusal,
  reportRefusal,
  watchHelpText,
} from "./watch-report.js";

/**
 * `trylo watch` handlers (WP26 / A07).
 *
 * A fired watch hands its text to the existing per-session background queue
 * (WP08) and nothing else — one queue, one dispatch rule, no second runner.
 * Firing is durable but not synchronous: the turn runs when the session goes
 * idle, the same promise `trylo queue --message` makes.
 *
 * `--fire-now` uses `create` + `evaluate` + (`settled` pre-check, then
 * `enqueue` then `fire`), the daemon poller's order. `createOrFire` is not
 * used: it settles inside the store with the watch id and never touches the
 * queue, so the record would disagree with the queue. The store has no
 * `watch_unreadable`, so a corrupt record lists as empty (documented
 * limitation, not a second opinion).
 *
 * Concurrency note: a `--fire-now` and a daemon tick can interleave between
 * the pre-check and the enqueue, so both may enqueue for the same watch. The
 * pre-check plus the store's idempotent `fire` make sequential double fires
 * report one message id, but they do not make concurrent enqueue atomic — no
 * lease is introduced here, by design. The test pins the sequential case.
 */

function storeOf(ctx: CliContext): WatchPort {
  const file = schedulePath(ctx.homeDir, ctx.env);
  return createFileWatchStore({
    file,
    writeRows: (rows) => writeWatchRows(file, rows),
    clock: { now: ctx.now, newWatchId: () => mintWatchId(ctx.newId("w")) },
    probe: nodeConditionProbe({
      workspaceRoot: ctx.cwd,
      stateFile: path.join(tryloHome(ctx.homeDir, ctx.env), "watch", "state"),
    }),

    occurrences: async () => {
      const record = readScheduleFile(file);
      return record.ok ? record.value.occurrences : [];
    },
  });
}

/**
 * Mint a `w_<hex>` id from the injected id factory.
 *
 * Production `newId("w")` yields `w-<uuid>` (dash, not hex-only); tests yield
 * `w_1`. Both are normalised here to the daemon's shape (`w_` plus hex) by
 * keeping only hex characters, so the CLI and the daemon mint ids the same
 * validator accepts. A value with no hex at all cannot happen from either
 * caller, and falls back to `w_0` rather than throwing inside a command.
 */
function mintWatchId(raw: string): string {
  const hex = raw.replace(/[^0-9a-f]/gi, "").toLowerCase().slice(0, 12);
  return `w_${hex.length > 0 ? hex : "0"}`;
}

function queueOf(ctx: CliContext, sessionId: string): BackgroundQueue {
  return createFileBackgroundQueue({
    path: sessionQueuePath(ctx.homeDir, ctx.env, sessionId),
    clock: { now: ctx.now, newId: ctx.newId },
  });
}

export async function handleWatch(ctx: CliContext, parsed: WatchParse): Promise<ExitCode> {
  if (parsed.verb === "error") {
    ctx.stderr(`${parsed.message}\n${parsed.hint}\n`);
    return EXIT_CODES.USAGE;
  }

  if (parsed.verb === "help") {
    ctx.stdout(watchHelpText());
    return EXIT_CODES.OK;
  }

  if (parsed.verb === "add") {
    return handleAdd(ctx, parsed.options);
  }

  if (parsed.verb === "list") {
    return handleList(ctx, parsed.options);
  }

  if (parsed.verb === "cancel") {
    return handleCancel(ctx, parsed.options);
  }

  if (parsed.verb === "check") {
    return handleCheck(ctx, parsed.options);
  }

  return handleForget(ctx, parsed.options);
}

async function handleAdd(ctx: CliContext, options: WatchAddOptions): Promise<ExitCode> {
  const sessionId = options.sessionId.trim();
  if (sessionId.length > 0 && !isValidSessionId(sessionId)) {
    ctx.stderr(`not a usable session id: ${sessionId}\n`);
    ctx.stderr("a session id is letters, digits, dot, dash or underscore, and never contains ..\n");
    return EXIT_CODES.USAGE;
  }

  const trigger = resolveWatchTrigger(ctx.now(), options.trigger);
  if ("verb" in trigger) {
    ctx.stderr(`${trigger.message}\n${trigger.hint}\n`);
    return EXIT_CODES.USAGE;
  }

  const store = storeOf(ctx);
  const created = await store.create({
    trigger: trigger.trigger,
    text: options.message,
    sessionId,
  });
  if (!created.ok) {
    const { message, hint } = explain(created.code);
    reportRefusal(ctx, created.code, message, hint, options.json);
    return exitCodeFor(created.code);
  }

  const row = created.value;

  if (!options.fireNow) {
    return reportArmed(ctx, row, options.json);
  }

  const verdict = await store.evaluate(row.id);
  if (!verdict.ok) {
    const { message, hint } = explain(verdict.code);
    reportRefusal(ctx, verdict.code, message, hint, options.json);
    return exitCodeFor(verdict.code);
  }

  if (!verdict.value.met) {
    return reportArmed(ctx, row, options.json);
  }

  const because = verdict.value.because ?? "the condition was met";
  // Fence before touching the queue: the daemon poller follows the same
  // evaluate-then-enqueue order, so a tick that already fired this watch must
  // not produce a second message here. `settled` is the occurrence record,
  // the row re-read is the state the daemon leaves when no occurrence exists.
  const alreadySettled = await store.settled(row.id);
  if (alreadySettled.ok && alreadyFired(alreadySettled.value, row.id, watchFireMoment(row))) {
    return reportAlreadyFired(ctx, store, row.id, row.text, sessionId, because, options.json);
  }

  const listedNow = await store.list();
  const current = listedNow.ok ? listedNow.value.find((item) => item.id === row.id) : undefined;
  if (current !== undefined && current.state.state !== "armed") {
    return reportAlreadyFired(ctx, store, row.id, row.text, sessionId, because, options.json);
  }

  const queue = queueOf(ctx, sessionId);

  try {
    const enqueued = await queue.enqueue(row.text);
    if (!enqueued.ok) {
      return reportQueueRefusal(ctx, enqueued.code, options.json);
    }

    const fired = await store.fire(row.id, ctx.now(), enqueued.value.id);
    if (!fired.ok) {
      const { message, hint } = explain(fired.code);
      reportRefusal(ctx, fired.code, `the message is queued as ${enqueued.value.id} but ${message}`, hint, options.json);
      return exitCodeFor(fired.code);
    }

    // Post-check: the authoritative id is the record's, not the queue's. When
    // a concurrent tick won the race, `fire` returns the first message id, so
    // sequential callers observe one id (monotonic). A concurrent loser still
    // leaves its own queue message behind — documented above, no lease added.
    const reportedMessageId =
      fired.value.state === "fired" && typeof fired.value.messageId === "string"
        ? fired.value.messageId
        : enqueued.value.id;

    if (options.json) {
      ctx.stdout(
        `${JSON.stringify({ id: row.id, fired: true, messageId: reportedMessageId, because, text: row.text, sessionId, trigger: trigger.trigger.kind, triggerDetail: trigger.trigger, hint: "the turn runs when that session goes idle" })}\n`,
      );
      return EXIT_CODES.OK;
    }

    ctx.stdout(`Watch ${row.id} fired now: ${because} (queued as ${reportedMessageId}).\n`);

    return EXIT_CODES.OK;
  } finally {
    await queue.release();
  }
}

/**
 * Report a watch that is already fired without enqueueing again.
 *
 * Reconciles the row through `fire` (idempotent) and reports the recorded
 * message id, so a second caller is told the first one's message rather than
 * a second notification with a new id.
 */
async function reportAlreadyFired(
  ctx: CliContext,
  store: WatchPort,
  watchId: string,
  text: string,
  sessionId: string,
  because: string,
  json: boolean,
): Promise<ExitCode> {
  const reconciled = await store.fire(watchId, ctx.now(), watchId);
  const messageId =
    reconciled.ok && reconciled.value.state === "fired" ? reconciled.value.messageId : watchId;

  if (json) {
    ctx.stdout(
      `${JSON.stringify({ id: watchId, fired: true, messageId, because, text, sessionId, hint: "already fired; reporting the recorded message" })}\n`,
    );
    return EXIT_CODES.OK;
  }

  ctx.stdout(`Watch ${watchId} already fired: ${because} (queued as ${messageId}).\n`);

  return EXIT_CODES.OK;
}

async function handleList(ctx: CliContext, options: WatchListOptions): Promise<ExitCode> {
  const sessionFilter = options.sessionId?.trim();
  if (sessionFilter !== undefined && sessionFilter.length > 0 && !isValidSessionId(sessionFilter)) {
    ctx.stderr(`not a usable session id: ${sessionFilter}\n`);
    ctx.stderr("a session id is letters, digits, dot, dash or underscore, and never contains ..\n");
    return EXIT_CODES.USAGE;
  }

  const store = storeOf(ctx);
  const listed = await store.list(sessionFilter);
  if (!listed.ok) {
    const { message, hint } = explain(listed.code);
    reportRefusal(ctx, listed.code, message, hint, options.json);
    return exitCodeFor(listed.code);
  }

  const rows = listed.value;
  const nowMs = ctx.now();

  if (options.json) {
    ctx.stdout(`${JSON.stringify(rows.map((row) => describeJson(row)))}\n`);
    return EXIT_CODES.OK;
  }

  if (rows.length === 0) {
    ctx.stdout("no watches\n");
    return EXIT_CODES.OK;
  }

  for (const row of rows) {
    ctx.stdout(`${describeHuman(row, nowMs)}\n`);
  }

  return EXIT_CODES.OK;
}

async function handleCancel(ctx: CliContext, options: WatchCancelOptions): Promise<ExitCode> {
  const store = storeOf(ctx);
  const cancelled = await store.cancel(options.watchId);
  if (!cancelled.ok) {
    const { message, hint } = explain(cancelled.code);
    reportRefusal(ctx, cancelled.code, message, hint, options.json);
    return exitCodeFor(cancelled.code);
  }

  if (options.json) {
    ctx.stdout(`${JSON.stringify({ id: options.watchId, cancelled: true, hint: "use `trylo watch forget <id>` to drop the record" })}\n`);
    return EXIT_CODES.OK;
  }

  ctx.stdout(`Cancelled ${options.watchId}; it will not fire.\n`);

  return EXIT_CODES.OK;
}

async function handleCheck(ctx: CliContext, options: WatchCheckOptions): Promise<ExitCode> {
  const store = storeOf(ctx);
  const verdict = await store.evaluate(options.watchId);
  if (!verdict.ok) {
    const { message, hint } = explain(verdict.code);
    reportRefusal(ctx, verdict.code, message, hint, options.json);
    return exitCodeFor(verdict.code);
  }

  if (options.json) {
    ctx.stdout(
      `${JSON.stringify({ id: options.watchId, met: verdict.value.met, ...(verdict.value.because === undefined ? {} : { because: verdict.value.because }), hint: "dry-run only; nothing was fired" })}\n`,
    );
    return EXIT_CODES.OK;
  }

  if (verdict.value.met) {
    ctx.stdout(`Watch ${options.watchId} is met: ${verdict.value.because ?? "the condition is true"}. Dry-run only; nothing was fired.\n`);
    return EXIT_CODES.OK;
  }

  ctx.stdout(`Watch ${options.watchId} is not met yet. Dry-run only; nothing was fired.\n`);

  return EXIT_CODES.OK;
}

/**
 * Forget a terminal watch's record. The store owns the armed guard
 * (`not_terminal`); this layer only keeps the wording a person reads.
 */
async function handleForget(ctx: CliContext, options: WatchForgetOptions): Promise<ExitCode> {
  const store = storeOf(ctx);
  const forgotten = await store.forget(options.watchId);
  if (!forgotten.ok) {
    const { message, hint } = explain(forgotten.code);
    reportRefusal(ctx, forgotten.code, message, hint, options.json);
    return exitCodeFor(forgotten.code);
  }

  if (options.json) {
    ctx.stdout(`${JSON.stringify({ id: options.watchId, forgotten: true, hint: "the record is dropped; nothing left to do" })}\n`);
    return EXIT_CODES.OK;
  }

  ctx.stdout(`Forgot ${options.watchId}.\n`);

  return EXIT_CODES.OK;
}
