import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { locateTurnByUserMessage, previewRollback, reviewSession, type TurnReview } from "./session-review.js";
import type { SessionReviewOptions } from "./args-review.js";
import type { CliContext } from "./context.js";
import { reportFailure } from "./run-failure.js";
import { isValidSessionId, sessionPath } from "./session-paths.js";

/**
 * `session review` and the shared rollback advice (WP11/F3, F14).
 *
 * Split out of `commands-review.ts` for the file-size discipline. The advice
 * shape below is the single source every rewind suggestion renders from —
 * `session review` text and `--json` here, `/rollback` in `review-slash.ts`
 * — so the entries can never disagree again. The file rail is always scoped:
 * a bare restore deletes post-snapshot files, and no advice here recommends
 * one without saying so.
 */

export function renderTurnCompact(
  review: ReturnType<typeof reviewSession>,
  turnId: string,
): string[] {
  const turn = review.turns.find((candidate) => candidate.turnId === turnId);
  if (turn === undefined) {
    return [`no such turn: ${turnId}`];
  }

  const lines = [`turn ${turn.turnId} (records ${turn.firstSequence}-${turn.lastSequence})`];

  for (const text of turn.userTexts) {
    lines.push(`  user: ${text.split("\n")[0] ?? ""}`);
  }

  for (const call of turn.toolCalls) {
    lines.push(`  tool ${call.name} (${call.toolCallId}): ${call.outcome}`);
  }

  for (const file of turn.fileWrites) {
    lines.push(`  file ${file.mode} ${file.path} (${file.bytes} bytes)`);
  }

  for (const checkpoint of turn.checkpointIds) {
    lines.push(`  checkpoint ${checkpoint}`);
  }

  for (const problem of turn.problems) {
    lines.push(`  problem: ${problem}`);
  }

  if (turn.toolCalls.length === 0 && turn.fileWrites.length === 0) {
    lines.push("  (no tool calls, no file writes)");
  }

  return lines;
}

export type RollbackAdvice = {
  readonly forkCommand: string;
  readonly checkpointId: string | undefined;
  readonly checkpointDiffCommand: string | undefined;
  readonly scopedRestoreCommand: string | undefined;
};

export function rollbackAdvice(
  sessionId: string,
  turn: Pick<TurnReview, "userTexts" | "fileWrites" | "checkpointIds">,
  messageIndex?: number,
): RollbackAdvice {
  const checkpointId = turn.checkpointIds[turn.checkpointIds.length - 1];
  const files = [...new Set(turn.fileWrites.map((file) => file.path))].sort();
  const scoped = checkpointId === undefined
    ? undefined
    : files.length === 0
      ? `trylo checkpoint restore ${checkpointId} --only <paths>`
      : `trylo checkpoint restore ${checkpointId} --only ${files.join(" ")}`;
  const forkSuffix = turn.userTexts.length > 0
    ? ` --before-user-message ${messageIndex === undefined ? "<n>" : String(messageIndex)}`
    : " --interrupted";

  return {
    forkCommand: `trylo session fork ${sessionId}${forkSuffix}`,
    checkpointId,
    checkpointDiffCommand: checkpointId === undefined ? undefined : `trylo checkpoint diff ${checkpointId}`,
    scopedRestoreCommand: scoped,
  };
}

export function renderRollbackLines(
  sessionId: string,
  turn: Pick<TurnReview, "userTexts" | "fileWrites" | "checkpointIds">,
  messageIndex?: number,
): ReadonlyArray<string> {
  const advice = rollbackAdvice(sessionId, turn, messageIndex);
  const lines = [`to roll the conversation back: \`${advice.forkCommand}\``];

  if (advice.checkpointDiffCommand !== undefined && advice.scopedRestoreCommand !== undefined) {
    lines.push(
      `to preview the files: \`${advice.checkpointDiffCommand}\``,
      `to rewind this turn's files: \`${advice.scopedRestoreCommand}\``,
      "a bare `checkpoint restore <id>` also deletes files created after the snapshot; prefer --only.",
    );
  } else {
    lines.push("to rewind the files: no checkpoint was taken this turn");
  }

  return lines;
}

export async function handleSessionReview(
  ctx: CliContext,
  options: SessionReviewOptions,
): Promise<ExitCode> {
  if (!isValidSessionId(options.session)) {
    return reportFailure(ctx, {
      exitCode: EXIT_CODES.USAGE,
      message: `invalid session id: ${options.session}`,
      hint: "use letters, digits, dot, dash and underscore, at most 128 characters",
    });
  }

  const store = createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, options.session) });
  const viewed = await store.readRecords();
  if (!viewed.ok) {
    if (viewed.code === "missing_session") {
      return reportFailure(ctx, {
        exitCode: EXIT_CODES.CONFIG,
        message: `no such session: ${options.session}`,
        hint: "`trylo session list` shows the resumable ones",
      });
    }
    return reportFailure(ctx, {
      exitCode: EXIT_CODES.CONFIG,
      message: `session ${options.session} is not readable: ${viewed.code}`,
      hint: "a session that cannot be proven intact is never partially shown",
    });
  }

  const records = viewed.view.records;
  const review = reviewSession(records);
  let turnId: string | undefined = options.turn;

  if (options.message !== undefined) {
    const located = locateTurnByUserMessage(records, options.message);
    if (!located.ok) {
      return reportFailure(ctx, {
        exitCode: EXIT_CODES.CONFIG,
        message: located.detail,
        hint: "`trylo session export` shows the numbered messages",
      });
    }

    turnId = located.turnId;
  }

  turnId ??= review.turns[review.turns.length - 1]?.turnId;

  if (turnId === undefined) {
    const empty = options.json
      ? JSON.stringify({ session: options.session, turns: 0, note: "the journal holds no turns yet" })
      : `session ${options.session} holds no turns yet\n`;
    ctx.stdout(`${empty}\n`);
    return EXIT_CODES.OK;
  }

  const turn = review.turns.find((candidate) => candidate.turnId === turnId);
  if (turn === undefined) {
    return reportFailure(ctx, {
      exitCode: EXIT_CODES.CONFIG,
      message: `no such turn: ${turnId}`,
      hint: "`trylo session review` without --turn shows the latest turn",
    });
  }

  let horizon: { horizonSequence: number; visibleItems: number; hiddenItems: number } | undefined;

  if (options.asOfSequence !== undefined) {
    const preview = previewRollback(records, options.asOfSequence);
    if (!preview.ok) {
      return reportFailure(ctx, {
        exitCode: EXIT_CODES.CONFIG,
        message: `cannot preview sequence ${options.asOfSequence}: ${preview.detail}`,
        hint: "sequences are journal positions; `session export` shows the records",
      });
    }

    horizon = { horizonSequence: preview.horizonSequence, visibleItems: preview.visibleItems, hiddenItems: preview.hiddenItems };
  }

  if (options.json) {
    const advice = rollbackAdvice(options.session, turn);

    ctx.stdout(`${JSON.stringify({
      session: options.session,
      turn,
      turnCount: review.turns.length + review.truncatedTurns,
      truncatedTurns: review.truncatedTurns,
      ...(horizon === undefined ? {} : { rollbackPreview: { ...horizon, journalUntouched: true } }),
      rollback: {
        conversation: { command: advice.forkCommand },
        files: advice.checkpointId === undefined
          ? { reason: "no checkpoint was taken this turn; file rewind needs a checkpoint id" }
          : {
            checkpoint: advice.checkpointId,
            diffCommand: advice.checkpointDiffCommand,
            restoreCommand: advice.scopedRestoreCommand,
            warning: "a bare restore deletes files created after the snapshot; prefer --only",
          },
      },
    })}\n`);

    return EXIT_CODES.OK;
  }

  const lines = renderTurnCompact(review, turn.turnId);

  if (review.truncatedTurns > 0) {
    lines.push(
      `  note: showing the newest ${review.turns.length} of ${review.turns.length + review.truncatedTurns} turns (${review.truncatedTurns} oldest hidden)`,
    );
  }

  if (horizon !== undefined) {
    lines.push(
      `  horizon ${horizon.horizonSequence}: the model would see ${horizon.visibleItems} item(s), ${horizon.hiddenItems} hidden (journal unchanged)`,
    );
  }

  for (const adviceLine of renderRollbackLines(options.session, turn)) {
    lines.push(`  ${adviceLine}`);
  }

  lines.push(
    "",
    "a review changes nothing: the journal and the workspace are as they were.",
  );
  ctx.stdout(`${lines.join("\n")}\n`);

  return EXIT_CODES.OK;
}
