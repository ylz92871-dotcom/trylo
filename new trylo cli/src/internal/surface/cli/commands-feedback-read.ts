import { createNdjsonSessionStore } from "../../adapters/session-store/ndjson.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { readFeedbackExplanation } from "../../integration/reward/explanation-reader.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { CliContext } from "./context.js";
import type { FeedbackReadOptions } from "./args-feedback-read.js";
import { sessionPath } from "./session-paths.js";
import { methodBoardRoot } from "./learning-sink.js";
import { formatFeedbackRead } from "./feedback-read-view.js";

/** Explicit historical inspection: no writer, provider, task or automatic learning path is composed. */
export async function handleFeedbackRead(ctx: CliContext, options: FeedbackReadOptions): Promise<ExitCode> {
  const result = await readFeedbackExplanation({ enabled: () => true, sessionId: options.session, delta: options.delta,
    ...(options.through === undefined ? {} : { through: options.through }),
    source: createNdjsonSessionStore({ path: sessionPath(ctx.homeDir, ctx.env, options.session) }),
    board: createBoardReader(methodBoardRoot(ctx.homeDir, ctx.env)) });
  ctx.stdout(`${formatFeedbackRead(result)}\n`);
  return result.ok ? EXIT_CODES.OK : EXIT_CODES.CONFIG;
}
