import { EXIT_CODES } from "../../protocol/cli-stream.js";
import type { CliContext } from "./context.js";
import type { RunCommandOptions } from "./args.js";
import { fail, type RunFailure } from "./run-failure.js";

/** argv message and piped stdin are combined; `-` forces stdin. */
export async function resolvePrompt(
  ctx: CliContext,
  options: RunCommandOptions,
): Promise<{ readonly text: string } | RunFailure> {
  const fromArgv = options.message.join(" ").trim();
  const wantsStdin = options.readStdin || (fromArgv.length === 0 && !ctx.stdinIsTty);
  if (!wantsStdin) {
    if (fromArgv.length === 0) {
      return fail(
        EXIT_CODES.USAGE,
        "no prompt given",
        "pass a message, pipe stdin, or use `-` to read stdin explicitly",
      );
    }
    return { text: fromArgv };
  }

  const piped = (await ctx.readStdin()).trim();
  const text = fromArgv.length === 0 ? piped : `${fromArgv}\n${piped}`.trim();
  if (text.length === 0) {
    return fail(EXIT_CODES.USAGE, "stdin contained no prompt", "pipe a message into trylo run");
  }

  return { text };
}
