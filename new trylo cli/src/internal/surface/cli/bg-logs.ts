import type { CliContext } from "./context.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { TRUNCATED_NOTICE, resolveJob, type BackgroundDeps } from "./bg-shared.js";
import { refuseUnknownJob, refuseUnreadableOutput } from "./bg-shared.js";

/**
 * `bg logs` — what the owner wrote.
 *
 * One read of the durable log per pass. `--follow` repeats the same read until
 * the record leaves `running`, so a second terminal sees what the owner keeps
 * writing without ever sharing its pipes.
 */

export type LogsOptions = {
  readonly sessionId: string | undefined;
  readonly follow: boolean;
  readonly json: boolean;
};

const DEFAULT_FOLLOW_INTERVAL_MS = 1_000;

export async function handleLogs(ctx: CliContext, options: LogsOptions, deps: BackgroundDeps): Promise<ExitCode> {
  const id = options.sessionId;
  if (id === undefined) {
    ctx.stderr("logs needs a session id\ntrylo bg ps lists the ids in use\n");
    return EXIT_CODES.USAGE;
  }

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((wake) => setTimeout(wake, ms)));
  const intervalMs = deps.followIntervalMs ?? DEFAULT_FOLLOW_INTERVAL_MS;
  let printedTo = 0;

  for (;;) {
    const resolved = await resolveJob(deps, id);
    if (!resolved.ok) {
      return refuseUnknownJob(ctx, resolved.reason);
    }

    const output = deps.jobs.readOutput(id);
    if (!output.ok) {
      return refuseUnreadableOutput(ctx, output.detail);
    }

    if (options.json) {
      ctx.stdout(
        `${JSON.stringify({ id, status: resolved.record.status, output: output.text, truncatedFromStart: output.truncatedFromStart })}\n`,
      );
    } else if (output.text.length > printedTo) {
      printedTo = printLogFresh(ctx, output.text, printedTo, output.truncatedFromStart);
    }

    if (resolved.record.status !== "running" || !options.follow) {
      return EXIT_CODES.OK;
    }

    if (deps.shouldContinue !== undefined && !deps.shouldContinue()) {
      return EXIT_CODES.CANCELLED;
    }

    await sleep(intervalMs);
  }
}

function printLogFresh(ctx: CliContext, text: string, printedTo: number, truncated: boolean): number {
  const fresh = text.slice(printedTo);
  ctx.stdout(fresh.endsWith("\n") ? fresh : `${fresh}\n`);
  if (truncated) {
    ctx.stderr(TRUNCATED_NOTICE);
  }
  return text.length;
}
