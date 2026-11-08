import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { estimateMessagesTokens } from "../../compaction/token-estimate.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { CliContext } from "./context.js";
import type { ContextOptions } from "./args-context.js";
import { projectContextFor } from "./project-rules.js";
import { reportFailure } from "./run-failure.js";
import { reviewSession, type TurnReview } from "./session-review.js";
import { sessionPath } from "./session-paths.js";

/**
 * `context` handler (WP24.2 / A08, context inspect/snip).
 *
 * Read-only on both paths. The workspace path reuses `projectContextFor`,
 * the exact resolver `prepareRun` uses, so the answer cannot disagree with
 * what a run would adopt. The session path reuses `reviewSession` over the
 * journal plus the compaction token estimator (`chars/4`, same unit as the
 * budget gate), mapped over the turn's visible texts — assistant prose is
 * not in the review shape, so the estimate says whose texts it counted.
 * The old `CtxInspectTool` / `SnipTool` implementations are absent behind
 * their feature flags (see the WP24 revalidation table); this command
 * serves their inspect/snip reads from facts already on disk instead of
 * re-implementing their tools.
 */

type TurnSlice = {
  readonly turnId: string;
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly toolCalls: number;
  readonly fileWrites: number;
  readonly estimatedTokens: number;
};

function sliceOf(turn: TurnReview): TurnSlice {
  const texts = [
    ...turn.userTexts.map((content) => ({ role: "user" as const, content })),
    ...turn.toolCalls.map((call) => ({ role: "tool" as const, content: call.outputPreview, toolCallId: call.toolCallId })),
  ];
  return {
    turnId: turn.turnId,
    userMessages: turn.userTexts.length,
    assistantMessages: turn.assistantTexts,
    toolCalls: turn.toolCalls.length,
    fileWrites: turn.fileWrites.length,
    estimatedTokens: estimateMessagesTokens(texts),
  };
}

export async function handleContext(ctx: CliContext, options: ContextOptions): Promise<ExitCode> {
  if (options.session === undefined) {
    return handleWorkspaceContext(ctx, options.json);
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

  const review = reviewSession(viewed.view.records);
  const turns = options.turn === undefined
    ? review.turns
    : review.turns.filter((turn) => turn.turnId === options.turn);
  if (options.turn !== undefined && turns.length === 0) {
    return reportFailure(ctx, {
      exitCode: EXIT_CODES.CONFIG,
      message: `no such turn: ${options.turn}`,
      hint: "`trylo context --session <id>` lists the turn ids",
    });
  }

  const slices = turns.map(sliceOf);
  const estimatedTokens = slices.reduce((total, slice) => total + slice.estimatedTokens, 0);

  if (options.json) {
    ctx.stdout(
      `${JSON.stringify({
        context: {
          session: options.session,
          turns: slices,
          estimatedTokens,
          basis: "journal user texts and tool output previews at chars/4; assistant prose is counted by messages, not tokens",
        },
      })}\n`,
    );
    return EXIT_CODES.OK;
  }

  ctx.stdout(`session ${options.session}: ${slices.length} turn(s), ~${estimatedTokens} tokens (journal texts at chars/4)\n`);

  for (const slice of slices) {
    ctx.stdout(
      `  ${slice.turnId}: ${slice.userMessages} user, ${slice.assistantMessages} assistant, ${slice.toolCalls} tool calls, ${slice.fileWrites} writes, ~${slice.estimatedTokens} tokens\n`,
    );
  }

  return EXIT_CODES.OK;
}

function handleWorkspaceContext(ctx: CliContext, json: boolean): ExitCode {
  const assembled = projectContextFor(ctx, ctx.cwd);
  const sources = assembled?.sources ?? [];
  const problems = assembled?.problems ?? [];
  const messages = assembled?.messages.length ?? 0;

  if (json) {
    ctx.stdout(
      `${JSON.stringify({
        context: {
          workspace: ctx.cwd,
          ruleSources: sources,
          instructionMessages: messages,
          problems,
        },
      })}\n`,
    );
    return EXIT_CODES.OK;
  }

  if (sources.length === 0) {
    ctx.stdout(`workspace ${ctx.cwd}: no project rules adopted\n`);
    return EXIT_CODES.OK;
  }

  ctx.stdout(`workspace ${ctx.cwd}: ${sources.length} rule source(s), ${messages} instruction message(s)\n`);

  for (const source of sources) {
    ctx.stdout(`  ${source.relativePath} [${source.scope}]\n`);
  }

  for (const problem of problems) {
    ctx.stdout(`  problem: ${problem}\n`);
  }

  return EXIT_CODES.OK;
}
