import type { CliContext } from "./context.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { BackgroundJobRecord } from "../../ports/background-job.js";
import { renderJobRow, resolveJob, type BackgroundDeps } from "./bg-shared.js";
import { refuseUnknownJob } from "./bg-shared.js";

/**
 * `bg ps` — what is on this machine.
 *
 * A sweep rides along: the surveyed implementations either leak logs forever
 * or need a daemon to clean them. There is no daemon here, and `ps` is the
 * command a person runs when they want to know what is on the machine.
 */

type PsRow = { readonly record: BackgroundJobRecord; readonly unverified: boolean };

export async function handlePs(
  ctx: CliContext,
  sessionId: string | undefined,
  json: boolean,
  deps: BackgroundDeps,
): Promise<ExitCode> {
  deps.jobs.sweep(ctx.now());
  if (sessionId !== undefined) {
    return handlePsOne(ctx, sessionId, json, deps);
  }
  return handlePsAll(ctx, json, deps);
}

async function handlePsOne(
  ctx: CliContext,
  sessionId: string,
  json: boolean,
  deps: BackgroundDeps,
): Promise<ExitCode> {
  const resolved = await resolveJob(deps, sessionId);
  if (!resolved.ok) {
    return refuseUnknownJob(ctx, resolved.reason);
  }

  ctx.stdout(
    json
      ? `${JSON.stringify(resolved.record)}\n`
      : `${renderJobRow(resolved.record, ctx.now(), resolved.unverified)}\n`,
  );

  return EXIT_CODES.OK;
}

async function handlePsAll(ctx: CliContext, json: boolean, deps: BackgroundDeps): Promise<ExitCode> {
  const collected = await collectPsRows(deps);
  if (json) {
    ctx.stdout(`${JSON.stringify(collected.rows.map((row) => row.record))}\n`);
    return EXIT_CODES.OK;
  }
  return emitPsList(ctx, collected.rows, collected.broken);
}

async function collectPsRows(deps: BackgroundDeps): Promise<{ readonly rows: PsRow[]; readonly broken: string[] }> {
  const entries = await Promise.all(
    deps.jobs.list().map(async (entry) => {
      if (!entry.ok) {
        // Normalised into the same shape `resolveJob` answers with, so the loop
        // below has one kind of "not a row" to deal with rather than two spellings.
        return { ok: false as const, reason: entry.detail };
      }
      return resolveJob(deps, entry.record.id);
    }),
  );
  const rows: PsRow[] = [];
  const broken: string[] = [];

  for (const entry of entries) {
    if (entry.ok) {
      rows.push({ record: entry.record, unverified: entry.unverified });
    } else {
      broken.push(entry.reason);
    }
  }

  return { rows, broken };
}

function emitPsList(ctx: CliContext, rows: PsRow[], broken: string[]): ExitCode {
  for (const reason of broken) {
    // Either the table could not be decoded or the record vanished between
    // listing and resolving. Both are said out loud: quietly listing fewer jobs
    // is how a person concludes nothing is running.
    ctx.stderr(`${reason}\n`);
  }

  if (rows.length === 0 && broken.length === 0) {
    ctx.stdout("no background jobs on this machine\n");
    return EXIT_CODES.OK;
  }

  if (rows.length > 0) {
    ctx.stdout(`${rows.map((row) => renderJobRow(row.record, ctx.now(), row.unverified)).join("\n")}\n`);
  }

  return EXIT_CODES.OK;
}
