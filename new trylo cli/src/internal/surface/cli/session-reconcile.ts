import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { toolCallIdOfEffectKey } from "../../ports/effect-key.js";
import type { PendingEffect, SessionPort } from "../../ports/session.js";
import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import type { JsonObject } from "../../protocol/envelope.js";
import type { Transcript } from "../../protocol/transcript.js";
import type { CliContext } from "./context.js";
import { reportFailure } from "./run-failure.js";
import { isValidSessionId, sessionPath } from "./session-paths.js";

/**
 * Manual reconciliation of effects whose outcome the run could not prove
 * (WP01.3).
 *
 * A tool call that crossed the execution boundary and then lost contact with
 * its result is neither failed nor succeeded — it is unknown. The next turn may
 * inspect and continue without replaying it; this optional command records a
 * person's evidence-backed determination without rewriting that history.
 *
 * Four rules are load-bearing and are why this file is shaped the way it is:
 *
 *  - **Listing writes nothing.** The default invocation is a read. A verdict
 *    requires `--turn`, `--key`, `--outcome` and `--evidence` together, and
 *    there is deliberately no flag that resolves everything at once: "clear the
 *    unknowns" is not a decision anybody can make about someone else's
 *    workspace.
 *  - **A verdict is addressed, not named.** A key alone recurs across turns, so
 *    a verdict carries the turn the issue happened in. Turn plus key is the
 *    address; if that is still ambiguous the verdict is refused rather than
 *    aimed at a guess.
 *  - **The verdict is recorded as a verdict.** It appends what the person
 *    determined and why. It never replays the action, never rewrites the
 *    original journal record, and never invents tool output: where no output
 *    exists, the record says so.
 *  - **Nothing here can unlock by force.** The closed set of outcomes is
 *    `committed` and `failed`. There is no "unknown" outcome to write (not
 *    deciding is the default) and no `--yes`, because a session's unknowns are
 *    exactly the set of things the machine could not find out.
 */

export const RECONCILE_OUTCOMES = ["committed", "failed"] as const;

export type ReconcileOutcome = (typeof RECONCILE_OUTCOMES)[number];

export function isReconcileOutcome(value: string): value is ReconcileOutcome {
  return (RECONCILE_OUTCOMES as readonly string[]).includes(value);
}

export type ReconcileRequest = {
  readonly session: string;
  readonly turn?: string;
  readonly key?: string;
  readonly outcome?: string;
  readonly evidence?: string;
  readonly json: boolean;
};

/** What the journal can tell a person about one action they have to judge. */
export type PendingView = {
  readonly turn: string | undefined;
  readonly key: string;
  readonly issuedAtSequence: number;
  readonly issuedAt: string;
  /**
   * Absent when the journal no longer holds the call this key names.
   *
   * That is the ordinary shape of a crash between the call and its result: the
   * store's read-time repair tears the unanswered request, so the intent
   * survives and the call does not.
   */
  readonly tool: string | undefined;
  readonly arguments: JsonObject | undefined;
};

export type ReconcileResult =
  | { readonly kind: "listed"; readonly pending: ReadonlyArray<PendingView>; readonly openBlocks: number }
  | { readonly kind: "recorded"; readonly key: string; readonly outcome: ReconcileOutcome; readonly sequence: number }
  | { readonly kind: "already_recorded"; readonly key: string; readonly outcome: ReconcileOutcome }
  | { readonly kind: "refused"; readonly exitCode: ExitCode; readonly message: string; readonly hint: string };

/** One tool call as the transcript still holds it. */
type ToolCallFact = {
  readonly name: string;
  readonly arguments: JsonObject;
};

/**
 * Tool calls the transcript still holds, by id.
 *
 * What is *not* here is the point: a call the tool never answered has already
 * been torn by the store's read-time repair, so the set below is exactly the
 * calls a resumed request may carry — nothing in it is an open question.
 */
function transcriptCalls(transcript: Transcript): ReadonlyMap<string, ToolCallFact> {
  const calls = new Map<string, ToolCallFact>();

  for (const item of transcript) {
    if (item.kind === "tool_call") {
      calls.set(item.toolCallId, { name: item.name, arguments: item.arguments });
    }
  }

  return calls;
}

function refuse(exitCode: ExitCode, message: string, hint: string): ReconcileResult {
  return { kind: "refused", exitCode, message, hint };
}

/**
 * Which effect a verdict addresses.
 *
 * Matched on the turn *and* the key, and refused when that still names two
 * effects: settling by key alone could resolve a later turn's call and leave
 * the original unknown, and settling an ambiguous address silently would pick
 * one of them by iteration order.
 */
function addressOf(
  pending: ReadonlyArray<PendingEffect>,
  request: ReconcileRequest,
): { readonly kind: "one"; readonly effect: PendingEffect }
  | { readonly kind: "ambiguous"; readonly sequences: ReadonlyArray<number> }
  | { readonly kind: "none" } {
  const matched = pending.filter(
    effect => effect.key === request.key && (effect.turnId ?? "") === (request.turn ?? ""),
  );
  if (matched.length === 1) {
    const effect = matched[0];
    return effect === undefined ? { kind: "none" } : { kind: "one", effect };
  }

  if (matched.length > 1) {
    return { kind: "ambiguous", sequences: matched.map(effect => effect.issuedAtSequence) };
  }

  return { kind: "none" };
}

/** The settlement already on disk for one turn and key, newest last. */
function settlementOf(
  records: ReadonlyArray<{ readonly type: string; readonly turnId?: string; readonly payload: JsonObject }>,
  turn: string,
  key: string,
): ReconcileOutcome | undefined {
  const found = records.filter(
    record =>
      (record.turnId ?? "") === turn &&
      record.payload["key"] === key &&
      (record.type === "effect_committed" || record.type === "effect_failed"),
  );
  const last = found[found.length - 1];
  if (last === undefined) {
    return undefined;
  }

  return last.type === "effect_committed" ? "committed" : "failed";
}

export async function reconcile(request: ReconcileRequest, ctx: CliContext): Promise<ReconcileResult> {
  if (!isValidSessionId(request.session)) {
    return refuse(EXIT_CODES.USAGE, `invalid session id: ${request.session}`,
      "use letters, digits, dot, dash and underscore, at most 128 characters");
  }

  const verdict = request.outcome;
  const writing = verdict !== undefined;
  if (writing) {
    if (!isReconcileOutcome(verdict)) {
      return refuse(EXIT_CODES.USAGE, `unknown outcome: ${verdict}`,
        `use one of ${RECONCILE_OUTCOMES.join(", ")}; nothing else can resolve an unknown action`);
    }
    for (const flag of ["turn", "key", "evidence"] as const) {
      const value = request[flag];
      if (value === undefined || value.trim().length === 0) {
        return refuse(EXIT_CODES.USAGE, `--${flag} is required to record a verdict`,
          "a verdict must name the turn and key it is about, and say what you checked");
      }
    }
  }

  const store = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, request.session) });
  const attached = await store.attach();
  if (!attached.ok) {
    return refuse(EXIT_CODES.CONFIG, `cannot open session ${request.session}: ${attached.code}`,
      attached.code === "missing_session"
        ? "no such session; `trylo session list` shows the resumable ones"
        : "another trylo process may hold the session lock; retry once it exits");
  }

  try {
    const read = await store.read();
    if (!read.ok) {
      return refuse(EXIT_CODES.CONFIG, `session ${request.session} is not readable: ${read.code}`,
        "a session that cannot be proven intact is never partially reconciled");
    }

    const pending = read.session.pendingEffects;

    if (!writing) {
      const calls = transcriptCalls(read.session.transcript);
      return {
        kind: "listed",
        pending: pending.map(effect => viewOf(effect, calls)),
        openBlocks: read.session.partials.length,
      };
    }

    const outcome = verdict as ReconcileOutcome;
    const addressed = addressOf(pending, request);
    if (addressed.kind === "ambiguous") {
      return refuse(EXIT_CODES.CONFIG,
        `${request.key} is unresolved more than once in turn ${request.turn}`,
        `issued at journal sequences ${addressed.sequences.join(", ")}; a verdict must name one`);
    }

    if (addressed.kind === "none") {
      // The effect may already be settled — by this command, or by a run that
      // later proved its own outcome. Repeating the same verdict is then a
      // no-op; contradicting it is a disagreement two appends must not let
      // the second one win silently.
      const settled = await settledOutcome(store, request.turn ?? "", request.key ?? "");
      if (settled === outcome) {
        return { kind: "already_recorded", key: request.key ?? "", outcome };
      }

      if (settled !== undefined) {
        return refuse(EXIT_CODES.CONFIG,
          `${request.key} in turn ${request.turn} is already recorded as ${settled}`,
          "a second verdict cannot overwrite the first; the journal is append-only");
      }

      return refuse(EXIT_CODES.CONFIG,
        `no unresolved effect matches key ${request.key} in turn ${request.turn}`,
        pending.length === 0
          ? "this session has nothing to reconcile"
          : "run `trylo session reconcile <id>` to list what is actually unresolved");
    }

    const target = addressed.effect;
    const appended = await appendVerdict(store, ctx, request.session, target, outcome, request.evidence ?? "");
    if (appended === undefined) {
      return refuse(EXIT_CODES.CONFIG, `could not record the verdict for ${target.key}`,
        "the session file rejected the append; nothing was changed");
    }

    return { kind: "recorded", key: target.key, outcome, sequence: appended };
  } finally {
    await store.release();
  }
}

/** One pending effect as the listing shows it: what is known, nothing guessed. */
function viewOf(effect: PendingEffect, calls: ReadonlyMap<string, ToolCallFact>): PendingView {
  const callId = toolCallIdOfEffectKey(effect.key);
  const call = callId === undefined ? undefined : calls.get(callId);

  return {
    turn: effect.turnId,
    key: effect.key,
    issuedAtSequence: effect.issuedAtSequence,
    issuedAt: effect.issuedAt,
    tool: call?.name,
    arguments: call?.arguments,
  };
}

async function settledOutcome(store: SessionPort, turn: string, key: string): Promise<ReconcileOutcome | undefined> {
  const records = await store.readRecords();
  if (!records.ok) {
    return undefined;
  }
  return settlementOf(records.view.records, turn, key);
}

/**
 * Appends the verdict, and only the verdict.
 *
 * One record, through the same port every other fact uses. It is tempting to
 * also append the `tool_result` the interrupted call never produced, and it
 * would be wrong twice over:
 *
 *  - there is no dangling call to answer. The store's own read-time repair
 *    (`purgeUnsettledToolCalls`) tears a request the tool never answered before
 *    any caller sees the transcript, so a resumed request cannot carry one —
 *    the repair for "只清掉阻塞列表却留下悬空调用" already exists and owns that
 *    seam. Appending a result here would be a second writer for it.
 *  - the result would have to invent its output. Nobody captured it, and a
 *    record claiming otherwise is a success somebody made up.
 */
async function appendVerdict(
  store: SessionPort,
  ctx: CliContext,
  sessionId: string,
  target: PendingEffect,
  outcome: ReconcileOutcome,
  evidence: string,
): Promise<number | undefined> {
  const settled = await store.append({
    type: outcome === "committed" ? "effect_committed" : "effect_failed",
    sessionId,
    ...(target.turnId === undefined ? {} : { turnId: target.turnId }),
    at: new Date(ctx.now()).toISOString(),
    payload: {
      key: target.key,
      outcome: outcome === "committed" ? "succeeded" : "failed",
      verifiedBy: "user-manual",
      evidence,
      issuedAtSequence: target.issuedAtSequence,
    },
  });
  return settled.ok ? settled.sequence : undefined;
}

export function reportReconcile(ctx: CliContext, request: ReconcileRequest, result: ReconcileResult): ExitCode {
  if (result.kind === "refused") {
    return reportFailure(ctx, { exitCode: result.exitCode, message: result.message, hint: result.hint });
  }

  if (result.kind === "listed") {
    if (request.json) {
      ctx.stdout(`${JSON.stringify({ pending: result.pending, openBlocks: result.openBlocks })}\n`);
      return result.pending.length === 0 ? EXIT_CODES.OK : EXIT_CODES.CONFIG;
    }

    if (result.pending.length === 0) {
      ctx.stdout(`session ${request.session} has nothing to reconcile\n`);
      return EXIT_CODES.OK;
    }

    ctx.stdout(`${result.pending.length} unresolved action(s) in ${request.session}:\n`);

    for (const pending of result.pending) {
      ctx.stdout(`  turn ${pending.turn ?? "-"}  key ${pending.key}  issued at journal sequence ${pending.issuedAtSequence}\n`);
      ctx.stdout(`    issued ${pending.issuedAt}\n`);

      if (pending.tool === undefined) {
        ctx.stdout("    the journal holds no call for this key: only the issued intent survived\n");
      } else {
        ctx.stdout(`    tool ${pending.tool}\n`);
        ctx.stdout(`    arguments ${JSON.stringify(pending.arguments ?? {})}\n`);
      }
    }

    if (result.openBlocks > 0) {
      ctx.stdout(`  ${result.openBlocks} block(s) were still open when the run stopped; they are shown on resume, never replayed\n`);
    }

    ctx.stdout("\nrecord one verdict with:\n");
    ctx.stdout(`  trylo session reconcile ${request.session} --turn <t> --key <k> --outcome committed|failed --evidence "<what you checked>"\n`);

    // Non-zero on purpose: a session with unknowns stays blocked, and this is
    // the same condition that refuses `trylo --resume`.
    return EXIT_CODES.CONFIG;
  }

  if (result.kind === "already_recorded") {
    ctx.stdout(`${result.key} is already recorded as ${result.outcome}; nothing changed\n`);
    return EXIT_CODES.OK;
  }

  ctx.stdout(`recorded ${result.outcome} for ${result.key} at journal sequence ${result.sequence}\n`);

  return EXIT_CODES.OK;
}
