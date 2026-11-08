import type { ExitCode } from "../../protocol/cli-stream.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import type { WatchFailureCode, WatchTrigger } from "../../ports/watch.js";
import { describeCondition } from "../../domain/watch.js";
import type { CliContext } from "./context.js";
import { relativeTime } from "./humanize.js";

/**
 * Watch rendering — words for people and machines (WP26 / A07).
 *
 * Split from `commands-watch.ts` for the 400-line gate. No IO, no store:
 * pure text for stdout/stderr plus exit-code mapping.
 */

const TRANSIENT: ReadonlySet<WatchFailureCode> = new Set(["watch_unwritable"]);

export function exitCodeForWatch(code: WatchFailureCode): ExitCode {
  return TRANSIENT.has(code) ? EXIT_CODES.TEMPORARY : EXIT_CODES.USAGE;
}

/** What a refusal means for the person reading it, and what they can do. */
export function explainWatch(code: WatchFailureCode): { readonly message: string; readonly hint: string } {
  switch (code) {
    case "blank_text":
      return { message: "a watch with no message would fire to say nothing", hint: "pass --message with the text to send" };
    case "not_a_session":
      return { message: "a watch needs a session to deliver to", hint: "pass --session <id>" };
    case "invalid_deadline":
      return { message: "that moment has already passed", hint: "use a future --at/--in, or send now with `trylo queue add`" };
    case "too_many_watches":
      return { message: "this session already has the maximum number of armed watches", hint: "cancel one first" };
    case "watch_not_found":
      return { message: "no such watch", hint: "run `trylo watch list` to see the ids" };
    case "already_fired":
      return { message: "that watch already fired; the work happened and cannot be recalled", hint: "nothing left to do" };
    case "already_cancelled":
      return { message: "that watch was already cancelled", hint: "nothing left to do" };
    case "not_terminal":
      return {
        message: "that watch is still armed; only fired or cancelled watches can be forgotten",
        hint: "cancel it first, or wait for it to fire",
      };
    case "watch_unwritable":
      return { message: "the watch record could not be written", hint: "check permissions and free space" };
  }
}

export function reportArmed(
  ctx: CliContext,
  row: { readonly id: string; readonly trigger: WatchTrigger; readonly text: string; readonly sessionId: string },
  json: boolean,
): ExitCode {
  if (json) {
    ctx.stdout(
      `${JSON.stringify({ id: row.id, armed: true, trigger: row.trigger.kind, triggerDetail: row.trigger, text: row.text, sessionId: row.sessionId, hint: "use `trylo watch check <id>` to dry-run; `cancel` to stop" })}\n`,
    );
    return EXIT_CODES.OK;
  }

  ctx.stdout(`Armed ${row.id} — ${row.trigger.kind === "deadline" ? `fires at ${new Date(row.trigger.atMs).toISOString()}` : `waiting for ${describeCondition(row.trigger.condition)}`}.\n`);

  return EXIT_CODES.OK;
}

/**
 * One watch as JSON. `trigger` stays the kind word for compatibility; the full
 * trigger is added as `triggerDetail`, alongside the text and message id the
 * human listing already shows. Additive only — existing keys never change.
 */
export function describeJson(row: {
  readonly id: string;
  readonly trigger: WatchTrigger;
  readonly state: { readonly state: string; readonly messageId?: string };
  readonly text: string;
  readonly sessionId: string;
  readonly createdAtMs: number;
  readonly firedBecause?: string;
}) {
  return {
    id: row.id,
    trigger: row.trigger.kind,
    triggerDetail: row.trigger,
    state: row.state.state,
    text: row.text,
    sessionId: row.sessionId,
    createdAtMs: row.createdAtMs,
    ...(row.state.state === "fired" && typeof row.state.messageId === "string"
      ? { messageId: row.state.messageId }
      : {}),
    ...(row.firedBecause === undefined ? {} : { firedBecause: row.firedBecause }),
    hint: hintForState(row.state.state),
  };
}

/** Next action for one watch state, for JSON readers that cannot see human text. */
export function hintForState(state: string): string {
  if (state === "armed") {
    return "use `trylo watch check <id>` to dry-run; `cancel` to stop";
  }
  return "use `trylo watch forget <id>` to drop the record";
}

export function describeHuman(row: { readonly id: string; readonly trigger: WatchTrigger; readonly state: { readonly state: string; readonly fireAtMs?: number; readonly firedAtMs?: number; readonly messageId?: string; readonly cancelledAtMs?: number; readonly reason?: string }; readonly text: string }, nowMs: number): string {
  const state = row.state;
  if (state.state === "fired") {
    return `${row.id}  fired ${relativeTime(state.firedAtMs ?? nowMs, nowMs)}  (message ${state.messageId ?? "?"})`;
  }

  if (state.state === "cancelled") {
    return `${row.id}  cancelled ${relativeTime(state.cancelledAtMs ?? nowMs, nowMs)}  ${state.reason ?? ""}`.trimEnd();
  }

  if (row.trigger.kind === "deadline") {
    return `${row.id}  armed  until ${new Date(row.trigger.atMs).toISOString()}  ${row.text.slice(0, 60)}`;
  }

  return `${row.id}  armed  waiting for ${describeCondition(row.trigger.condition)}`;
}

export function reportRefusal(ctx: CliContext, code: WatchFailureCode, message: string, hint: string, json: boolean): void {
  if (json) {
    ctx.stdout(`${JSON.stringify({ ok: false, code, message, hint })}\n`);
    return;
  }
  ctx.stderr(`${message}: ${code}\n${hint}\n`);
}

export function reportQueueRefusal(ctx: CliContext, code: string, json: boolean): ExitCode {
  const transient = code === "queue_locked" || code === "queue_unwritable";
  const hint = "the watch stays armed; fix the queue and fire again with `trylo watch check`";

  if (json) {
    ctx.stdout(`${JSON.stringify({ ok: false, code, message: `the message could not be queued: ${code}`, hint })}\n`);
    return transient ? EXIT_CODES.TEMPORARY : EXIT_CODES.USAGE;
  }

  ctx.stderr(`the message could not be queued: ${code}\n`);
  ctx.stderr("the watch stays armed; fix the queue and fire again with `trylo watch check`\n");

  return transient ? EXIT_CODES.TEMPORARY : EXIT_CODES.USAGE;
}

export function watchHelpText(): string {
  return [
    "trylo watch — sleep until something happens, then tell the session",
    "",
    "  watch add --message <text> --session <id> [--file-exists <path>] [--fire-now]",
    "      --file-contains <path> --needle <text> | --exit-code <0-255> | --flag <name>",
    "      --at <ISO-8601|ms> | --in <10s|5m|2h|1d|ms>  exactly one trigger",
    "  watch list [--session <id>] [--json]  what is armed or finished (read-only)",
    "  watch cancel <id> [--json]  stop an armed watch",
    "  watch check <id> [--json]  is it met right now? dry-run, never fires",
    "  watch forget <id> [--json]  drop a fired/cancelled record (never an armed one)",
    "",
    "A fired watch hands its message to the session queue. The turn runs when",
    "that session next goes idle, so `add --fire-now` does not wait either.",
    "",
  ].join("\n");
}
