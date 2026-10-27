import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { RunCommandOptions } from "./args.js";
import type { CliContext } from "./context.js";
import type { CliSink } from "./render.js";
import { handleRun } from "./run-command.js";
import { stdioUserPrompt } from "./stdio-control.js";
import { createStdioSession } from "./stdio-session.js";
import { BootstrapContextError } from "./bootstrap-context.js";

/** One turn, with a framed prompt and approvals on the still-open stdin. */
export async function handleStdioRun(ctx: CliContext, options: RunCommandOptions, sink: CliSink): Promise<ExitCode> {
  let prompt: ReturnType<typeof stdioUserPrompt>;
  try { prompt = stdioUserPrompt(await ctx.readLine()); }
  catch (error) {
    if (!(error instanceof BootstrapContextError)) throw error;
    ctx.stderr("invalid_bootstrap_context: prior context was rejected; no turn was run\n"); return EXIT_CODES.USAGE;
  }
  if (prompt === undefined) {
    ctx.stderr("stdio input requires one non-empty user text frame\n");
    return EXIT_CODES.USAGE;
  }
  const control = createStdioSession(ctx);
  control.start();
  try {
    return await handleRun({ ...ctx, ...(prompt.bootstrapContext === undefined ? {} : { bootstrapContext: prompt.bootstrapContext }),
      ...(prompt.userSourceAvailable === undefined ? {} : { userSourceAvailable: prompt.userSourceAvailable }),
      approval: { requestApproval: control.approval, supportsMemberApproval: true }, readStdin: async () => prompt.text }, {
      ...options, ask: options.ask ?? "always", readStdin: true,
    }, sink, control);
  } finally { control.close(); }
}
