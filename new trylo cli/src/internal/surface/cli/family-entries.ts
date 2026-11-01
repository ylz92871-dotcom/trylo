import type { CliContext } from "./context.js";
import { parseSchedule } from "./args-schedule.js";
import { handleSchedule } from "./commands-schedule.js";
import { parseWatch } from "./args-watch.js";
import { handleWatch } from "./commands-watch.js";
import { parseDaemon, handleDaemon } from "./commands-daemon.js";
import { handleBackground, parseBackground } from "./commands-bg.js";
import { tryloHome } from "./session-paths.js";
import { createJobStore } from "../../adapters/process-session/job-store.js";
import { createProcessIdentityProbe } from "../../adapters/daemon/identity-probe.js";
import { verifyIdentity } from "../../domain/daemon-identity.js";
import type { BackgroundJobRecord } from "../../ports/background-job.js";
import type { JobLiveness } from "./commands-bg.js";
import type { FamilyWord } from "./command-vocabulary.js";
import type { ExitCode } from "../../protocol/cli-stream.js";

/**
 * The command families the root's parser hands over to (WP26).
 *
 * ## How a verb gets here
 *
 * `args.ts` recognises the word (its `family` branch) and `commands.ts` dispatches
 * the `{kind: "family"}` command to {@link runFamilyCommand}. One entry point, one
 * dispatcher — there used to be a second one in `main.ts` that asked the families
 * *before* the root parsed anything, which meant `trylo --learning on schedule
 * list` reached the schedule family with the `--learning` switch silently ignored.
 * A bypass around the parser is how flag semantics stop being one thing.
 *
 * ## The words themselves
 *
 * They live in `command-vocabulary.ts` (`FAMILY_COMMAND_WORDS`), and the help text
 * in `usage.ts`. This module holds only the answer for each word, so a family with
 * no handler is a compile error, not a runtime surprise.
 *
 * ## Why `bg` reads a table
 *
 * `trylo bg` reads the durable job table rather than the in-memory process-session
 * registry, because a second terminal has no registry to ask. Cross-process
 * *interactive* attach is deliberately absent (`attach` is watch-only): it sends
 * no stdin, sends no resize, and transfers no owner — a job's pipes belong to
 * whoever started it, and every implementation that supports real attach keeps
 * a resident server holding the PTY (e2b `Commands.connect`, codex's
 * exec-server recovery). To type into a job, use the terminal that started
 * it.
 */

/**
 * Is the recorded process still the process it says it is?
 *
 * The pair matters: Windows recycles pids, so `bg kill` aimed at a bare pid could
 * signal an unrelated program. Costs 200–600 ms per job on this host (a PowerShell
 * identity query), which is why only records claiming to be running are probed.
 */
async function jobLiveness(platform: string, record: BackgroundJobRecord): Promise<JobLiveness> {
  const verdict = await verifyIdentity(
    { pid: record.pid, startedAtMs: record.startedAtMs },
    createProcessIdentityProbe(platform),
  );
  if (verdict.verdict === "matching") {
    return "alive";
  }
  return verdict.verdict === "gone" ? "gone" : "unverifiable";
}

/**
 * Answer for one family word. Never throws for a bad argument: each family refuses
 * in its own words, because a malformed schedule id is about the id shape and only
 * the schedule family knows that.
 */
export function runFamilyCommand(
  word: FamilyWord,
  ctx: CliContext,
  rest: ReadonlyArray<string>,
): Promise<ExitCode> {
  switch (word) {
    case "tools":
      return import("./commands-tools.js").then(module => module.handleTools(ctx, rest));
    case "schedule":
      return handleSchedule(ctx, parseSchedule(rest));
    case "watch":
      return handleWatch(ctx, parseWatch(rest));
    case "daemon":
      return handleDaemon(ctx, parseDaemon(rest));
    case "bg":
      return handleBackground(ctx, parseBackground(rest), {
        jobs: createJobStore({ home: tryloHome(ctx.homeDir, ctx.env) }),
        liveness: (record) => jobLiveness(ctx.platform ?? "win32", record),
      });
  }
}
