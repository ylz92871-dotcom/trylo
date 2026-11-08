import type { ExitCode } from "../../protocol/cli-stream.js";
import type { CliContext } from "./context.js";
import { credentialWarningTo } from "./credentials-wiring.js";
import { collectDoctor, doctorExitCode, renderDoctorText, type DoctorReport } from "./doctor.js";
import { catalogHash } from "./wiring.js";
import { sessionsDir } from "./session-paths.js";
import type { LearningSwitch } from "./args.js";
import { projectContextFor } from "./project-rules.js";
import type { ProjectRulesReport } from "./project-rules-check.js";

/**
 * Running `doctor` from anywhere that has a `CliContext`.
 *
 * Extracted because two places need it: the `trylo doctor` command, and
 * `/doctor` inside a REPL — and a REPL that reported different facts than the
 * command of the same name would be a REPL nobody trusts. The mapping from
 * context to the doctor's IO is the part worth sharing; it is where a missing
 * field would silently turn into a check that reports nothing.
 *
 * The exit code is returned rather than acted on: a command leaves with it, a
 * REPL does not — it just prints and carries on.
 */

export type DoctorRun = {
  readonly report: DoctorReport;
  readonly code: ExitCode;
};

/**
 * The rules every run in this cwd adopts.
 *
 * The same call `prepareRun` makes, with the same resolver, so `trylo doctor`
 * and `trylo run` cannot answer "which rules apply" differently. It is computed
 * here rather than inside `collectDoctor` because `doctor` also serves `/doctor`
 * inside a REPL, and a diagnostic that re-walked the tree on every slash command
 * would make the answer depend on when it was asked.
 */
function rulesFor(ctx: CliContext): ProjectRulesReport | undefined {
  const context = projectContextFor(ctx, ctx.cwd);
  return context === undefined ? undefined : { sources: context.sources, problems: context.problems };
}

export function runDoctor(ctx: CliContext, learning?: LearningSwitch): DoctorRun {
  const rules = rulesFor(ctx);
  const report = collectDoctor(
    {
      readFile: ctx.readFile,
      isDirectory: ctx.isDirectory,
      readDir: ctx.readDir,
      env: ctx.env,
      homeDir: ctx.homeDir,
      cwd: ctx.cwd,
      workspaceRoot: ctx.cwd,
      nodeVersion: ctx.nodeVersion,
      now: ctx.now,
    },
    {
      toolCatalogHash: catalogHash(ctx.cwd),
      sessionsDir: sessionsDir(ctx.homeDir, ctx.env),
      warn: credentialWarningTo(ctx),
      ...(rules === undefined ? {} : { projectRules: rules }),
      ...(learning === undefined ? {} : { learning }),
    },
  );

  return { report, code: doctorExitCode(report) };
}

export function doctorText(report: DoctorReport, json: boolean): string {
  return json ? `${JSON.stringify(report)}\n` : `${renderDoctorText(report)}\n`;
}
