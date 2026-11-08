import type { CliContext } from "./context.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import { terminatePidTree } from "../../adapters/process-session/terminate-by-pid.js";
import { resolveJob, type BackgroundDeps } from "./bg-shared.js";
import { refuseUnknownJob } from "./bg-shared.js";

/**
 * `bg kill` — stop a job and everything it started.
 *
 * The record is left as it is. This process never saw the child exit, so the
 * exit code is not ours to write; the owner will settle it, or the next `ps`
 * will find the pid gone and mark it `lost`.
 */
export async function handleKill(
  ctx: CliContext,
  sessionId: string,
  json: boolean,
  deps: BackgroundDeps,
): Promise<ExitCode> {
  const resolved = await resolveJob(deps, sessionId);
  if (!resolved.ok) {
    return refuseUnknownJob(ctx, resolved.reason);
  }

  const record = resolved.record;
  if (record.status !== "running") {
    // Already finished is not a failure to report as one; it is the state asked for.
    ctx.stdout(
      json
        ? `${JSON.stringify({ id: sessionId, alreadyGone: true, status: record.status })}\n`
        : `${sessionId} was not running (${record.status})\n`,
    );
    return EXIT_CODES.OK;
  }

  if (resolved.unverified) {
    return refuseUnverifiedKill(ctx, record.pid);
  }

  const killPid = deps.killPid ?? ((pid: number) => terminatePidTree(pid));
  const killed = await killPid(record.pid);
  if (!killed.ok) {
    ctx.stderr(`${killed.message}\n`);
    return EXIT_CODES.TEMPORARY;
  }

  const how = killed.how === "already_gone" ? "was already gone" : "asked to stop, and its process tree went with it";

  ctx.stdout(
    json
      ? `${JSON.stringify({ id: sessionId, pid: record.pid, outcome: killed.how })}\n`
      : `${sessionId} ${how}; \`trylo bg ps ${sessionId}\` will say how it ended\n`,
  );

  return EXIT_CODES.OK;
}

function refuseUnverifiedKill(ctx: CliContext, pid: number): ExitCode {
  // Refuse. The identity check exists because Windows recycles pids: if this
  // build cannot confirm that pid <n> is still the process the record describes,
  // then `kill` would be a guess aimed at whatever owns that number now.
  ctx.stderr(
    `cannot confirm pid ${pid} is still the recorded job, so nothing was signalled\n` +
      "the process table would not answer; run `trylo bg ps` again once it does\n",
  );
  return EXIT_CODES.TEMPORARY;
}
