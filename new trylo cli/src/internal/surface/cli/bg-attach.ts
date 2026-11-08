import type { CliContext } from "./context.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { TRUNCATED_NOTICE, resolveJob, type BackgroundDeps } from "./bg-shared.js";
import { refuseUnknownJob, refuseUnreadableOutput } from "./bg-shared.js";

/**
 * `attach` — watch-only, not take over.
 *
 * One read of the same log `logs` follows. It never sends stdin, never sends
 * a resize, and never transfers the job owner: a second terminal cannot type
 * into a job whose pipes belong to the process that started it, and no
 * implementation surveyed offers cross-process interactive attach without a
 * resident server holding the PTY. Saying "watching" instead of "attaching" is
 * the honest word for what this does. To type into the job, use the terminal
 * that started it — this command only reads the log it leaves behind.
 */
export async function handleAttach(
  ctx: CliContext,
  sessionId: string,
  json: boolean,
  deps: BackgroundDeps,
): Promise<ExitCode> {
  const resolved = await resolveJob(deps, sessionId);
  if (!resolved.ok) {
    return refuseUnknownJob(ctx, resolved.reason);
  }

  const output = deps.jobs.readOutput(sessionId);
  if (!output.ok) {
    return refuseUnreadableOutput(ctx, output.detail);
  }

  if (json) {
    ctx.stdout(
      `${JSON.stringify({ id: sessionId, status: resolved.record.status, output: output.text, truncatedFromStart: output.truncatedFromStart })}\n`,
    );
    return EXIT_CODES.OK;
  }

  return emitAttachHuman(ctx, sessionId, output.text, output.truncatedFromStart);
}

function emitAttachHuman(ctx: CliContext, sessionId: string, text: string, truncated: boolean): ExitCode {
  ctx.stdout(text.length > 0 ? (text.endsWith("\n") ? text : `${text}\n`) : `(no output yet from ${sessionId})\n`);
  if (truncated) {
    ctx.stderr(TRUNCATED_NOTICE);
  }
  ctx.stderr(`(watching only — nothing here types into ${sessionId}; its input belongs to the process that started it)\n`);
  return EXIT_CODES.OK;
}
