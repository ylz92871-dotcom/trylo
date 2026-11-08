import type { SessionRecord } from "../../ports/session.js";
import { createGitRunner } from "../../adapters/git/runner.js";
import { collectGitDiff, type GitCommandRunner } from "./git-diff.js";
import { renderDiffText } from "./commands-review.js";
import { locateTurnByUserMessage, previewRollback, reviewSession } from "./session-review.js";
import { renderRollbackLines } from "./commands-session-review.js";

/**
 * The `/diff`, `/review` and `/rollback` slash bodies, shared by the line
 * REPL and the TUI (WP11.3).
 *
 * One implementation for both surfaces, because a command that answers
 * differently on a terminal than in a pipe is a command that cannot be
 * trusted (see `session-info.ts`). Plain inputs in, printable text out — the
 * dispatchers own the scaffold, these own the words.
 */

export type SlashDiffInput = {
  readonly cwd: string;
  readonly platform: "win32" | "posix";
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runner?: GitCommandRunner;
};

export async function slashDiffText(input: SlashDiffInput): Promise<string> {
  const outcome = await collectGitDiff(input.runner ?? createGitRunner(), {
    cwd: input.cwd,
    platform: input.platform,
    baseEnv: input.env,
  });
  if (!outcome.ok) {
    return `diff failed: ${outcome.detail}\n`;
  }

  return renderDiffText(outcome);
}

/** Compact per-turn lines, bounded: a slash answer is a glance, not a dump. */
const SLASH_REVIEW_LINES = 30;

export function slashReviewText(
  records: ReadonlyArray<SessionRecord> | undefined,
  arg: string,
): string {
  if (records === undefined) {
    return "this session has no journal to review\n";
  }

  const review = reviewSession(records);
  if (review.turns.length === 0) {
    return "no turns yet\n";
  }

  const trimmed = arg.trim();
  let turnId: string | undefined;

  if (trimmed.length === 0) {
    turnId = review.turns[review.turns.length - 1]?.turnId;
  } else if (/^\d+$/.test(trimmed)) {
    const located = locateTurnByUserMessage(records, Number(trimmed));
    if (!located.ok) {
      return `${located.detail}\n`;
    }
    turnId = located.turnId;
  } else {
    turnId = trimmed;
  }

  const turn = review.turns.find((candidate) => candidate.turnId === turnId);
  if (turn === undefined) {
    return `no such turn: ${turnId}\n`;
  }

  const lines = [`turn ${turn.turnId} (records ${turn.firstSequence}-${turn.lastSequence})`];

  for (const text of turn.userTexts) {
    lines.push(`user: ${text.split("\n")[0] ?? ""}`);
  }

  for (const call of turn.toolCalls) {
    lines.push(`tool ${call.name}: ${call.outcome}`);
  }

  for (const file of turn.fileWrites) {
    lines.push(`file ${file.mode} ${file.path}`);
  }

  for (const checkpoint of turn.checkpointIds) {
    lines.push(`checkpoint ${checkpoint}`);
  }

  for (const problem of turn.problems) {
    lines.push(`problem: ${problem}`);
  }

  if (lines.length === 1) {
    lines.push("(no user text, tool calls or file writes)");
  }

  const kept = lines.slice(0, SLASH_REVIEW_LINES);
  if (kept.length < lines.length) {
    kept.push(`... ${lines.length - kept.length} more row(s); \`session review\` shows them all ...`);
  }

  return `${kept.join("\n")}\n`;
}

export function slashRollbackText(
  records: ReadonlyArray<SessionRecord> | undefined,
  sessionId: string,
  arg: string,
): string {
  if (records === undefined) {
    return "this session has no journal to roll back\n";
  }

  const trimmed = arg.trim();
  if (!/^\d+$/.test(trimmed)) {
    return "usage: /rollback <n>, the nth user message to return to (as a person counts)\n";
  }

  const located = locateTurnByUserMessage(records, Number(trimmed));
  if (!located.ok) {
    return `${located.detail}\n`;
  }

  // The horizon sits strictly *before* the nth message (F8): the preview
  // shows the world the fork would keep, and `session fork
  // --before-user-message n` keeps exactly that prefix. Previewing the
  // message's own sequence would display a message the fork then deletes.
  const horizonSequence = located.firstSequence - 1;
  if (horizonSequence < 0) {
    return [
      `rollback preview for user message ${located.userMessageIndex}: nothing precedes it`,
      `to roll the conversation back: \`trylo session fork ${sessionId} --before-user-message ${located.userMessageIndex}\``,
      "",
    ].join("\n");
  }

  const preview = previewRollback(records, horizonSequence);
  if (!preview.ok) {
    return `cannot preview that point: ${preview.detail}\n`;
  }

  const turn = reviewSession(records).turns.find((candidate) => candidate.turnId === located.turnId);
  const lines = [
    `rollback preview for user message ${located.userMessageIndex} (turn ${located.turnId}, horizon ${preview.horizonSequence})`,
    `the model would see ${preview.visibleItems} item(s), ${preview.hiddenItems} hidden; the journal is unchanged`,
    ...renderRollbackLines(sessionId, {
      userTexts: turn?.userTexts ?? [],
      fileWrites: turn?.fileWrites ?? [],
      checkpointIds: turn?.checkpointIds ?? [],
    }, located.userMessageIndex),
    "",
  ];

  return `${lines.join("\n")}\n`;
}
