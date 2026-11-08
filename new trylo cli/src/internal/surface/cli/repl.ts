import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { LearningSwitch, RunCommandOptions } from "./args.js";
import type { CliContext } from "./context.js";
import type { CliSink } from "./render.js";
import {
  isRunFailure,
  prepareRun,
  reportFailure,
  runOneTurn,
  type RunFailure,
  type RunScaffold,
} from "./run-command.js";
import { parseSlash, slashHelpText, type SlashInvocation } from "./slash.js";
import { expandSkillSlash } from "./skill-slash.js";
import { sessionLearningOptions, replSessionOptions, type SessionLearningOptions } from "./session-learning-options.js";
import { slashDiffText, slashReviewText, slashRollbackText } from "./review-slash.js";
import { readMultiLine } from "./multiline.js";
import { compactNote, compactSession } from "./compact-session.js";
import { doctorText, runDoctor } from "./doctor-run.js";
import { prepareInput } from "./mention.js";
import { journalRecordsOf, statusLines, usageLines } from "./session-info.js";
import type { TurnOutcome } from "./host.js";
import { scaffoldAfterTurn } from "./turn-threading.js";
import { answerQuestionInput } from "./question-input.js";
import { switchRunConnection } from "./connection-switch.js";
import { lineIoOf, type TuiIo } from "./tui/io.js";
import { runConnectForm } from "./tui/connection-ui.js";
import { runModelMenu } from "./tui/model-menu.js";
import { settingsText } from "./settings-view.js";
import {
  runPermissionAllow,
  runPermissionDeny,
  runPermissionGrants,
  runPermissionMode,
  runPermissionRevoke,
} from "./tui/permission-ui.js";


/**
 * Interactive REPL.
 *
 * It owns no loop of its own: every turn goes through the same run host as
 * `trylo run`, and the conversation history advances by feeding the previous
 * turn's transcript back in. The REPL always persists, so `/resume` and
 * `trylo session list` have something real to point at.
 */

type Mode = "interactive" | "non_interactive";

function isTurnOutcome(value: TurnOutcome | RunFailure): value is TurnOutcome {
  return "result" in value;
}

async function openReplSession(
  ctx: CliContext,
  sink: CliSink,
  mode: Mode,
  options: RunCommandOptions,
): Promise<RunScaffold | RunFailure> {
  // The warm layer rides on the scaffold (`prepareRun` builds one), so every
  // turn in this shell shares one provider — and a run that makes one turn is
  // untouched by the layer existing.
  return prepareRun(ctx, { options, sink, permissionMode: mode });
}

/** Slash outcomes distinguish a failed new session from a failed resume. */
type SlashResult =
  | { readonly kind: "continue" }
  | { readonly kind: "exit" }
  | { readonly kind: "replaced"; readonly scaffold: RunScaffold; readonly note: string }
  | { readonly kind: "fatal"; readonly failure: RunFailure }
  | { readonly kind: "soft_failure"; readonly failure: RunFailure };

type SlashDeps = {
  readonly ctx: CliContext;
  readonly sink: CliSink;
  readonly mode: Mode;
  readonly scaffold: RunScaffold;
  readonly io: TuiIo;
};

/**
 * Run one table-driven slash command.
 *
 * A command is a command because `slash.ts` lists it, so the unreachable
 * `default` is the table and this switch disagreeing — never a user input.
 */
async function dispatchSlash(invocation: SlashInvocation, deps: SlashDeps): Promise<SlashResult> {
  const { ctx, sink, mode, scaffold } = deps;
  const { command, arg } = invocation;

  switch (command.kind) {
    case "help":
      ctx.stderr(`${slashHelpText()}\n`);
      return { kind: "continue" };
    case "status":
      ctx.stderr(
        `${statusLines(
          {
            sessionId: scaffold.sessionId,
            providerId: scaffold.providerId,
            model: scaffold.model,
            maxIterations: scaffold.maxIterations,
            contextTokenLimit: scaffold.contextTokenLimit,
          },
          undefined,
        ).join("\n")}\n`,
      );
      return { kind: "continue" };
    case "usage":
      // No usage here on purpose: the line REPL does not accumulate the turn's
      // usage, and reporting zero would be a number nobody measured.
      ctx.stderr(`${usageLines(undefined, undefined).join("\n")}\n`);
      return { kind: "continue" };
    case "model": {
      if (arg.length === 0) {
        const next = await runModelMenu(ctx, deps.io, scaffold, sink);
        if (next === undefined) {
          return { kind: "continue" };
        }

        if (isRunFailure(next)) {
          return { kind: "soft_failure", failure: next };
        }

        return {
          kind: "replaced",
          scaffold: next,
          note: `model ${next.model} (new session ${next.sessionId}; previous session ${scaffold.sessionId} stays resumable)`,
        };
      }

      const next = await switchRunConnection(ctx, scaffold, { model: arg }, sink, mode);
      if (isRunFailure(next)) {
        return { kind: "soft_failure", failure: next };
      }

      return { kind: "replaced", scaffold: next, note: `model ${arg} (new session ${next.sessionId}; previous session ${scaffold.sessionId} stays resumable)` };
    }
    case "settings":
      ctx.stderr(settingsText(ctx, scaffold));
      return { kind: "continue" };
    case "connect": {
      const trimmed = arg.trim();
      const operation = trimmed.toLowerCase().startsWith("edit ") ? "edit" : "add";
      let existingId: string | undefined;

      if (operation === "edit") {
        existingId = trimmed.slice("edit ".length).trim();
        if (existingId.length === 0) {
          ctx.stderr(`usage: ${command.name} ${command.arg ?? ""}\n`);
          return { kind: "continue" };
        }
      }

      const result = await runConnectForm(ctx, deps.io, operation, existingId);
      if (result === undefined) {
        return { kind: "continue" };
      }

      if (!result.ok) {
        ctx.stderr(`save failed at stage ${result.stage}: ${result.code}: ${result.detail}\n`);

        if (result.committed.length > 0) {
          ctx.stderr(`already committed: ${result.committed.join(", ")}\n`);
        }

        if (result.accountId !== undefined) {
          ctx.stderr(`account id: ${result.accountId}\n`);
        }

        return { kind: "continue" };
      }

      ctx.stderr(`saved connection ${result.id}${result.accountId !== undefined ? ` (account ${result.accountId})` : ""}\n`);
      ctx.stderr("this session still runs on the current connection; /model switches it\n");

      return { kind: "continue" };
    }
    case "mode":
      if (scaffold.permissions === undefined) {
        ctx.stderr("permission mode is not available in this session\n");
        return { kind: "continue" };
      }
      runPermissionMode(deps.io, scaffold.permissions, arg);
      return { kind: "continue" };
    case "allow":
      if (scaffold.permissions === undefined) {
        ctx.stderr("permission controls are not available in this session\n");
        return { kind: "continue" };
      }
      runPermissionAllow(deps.io, scaffold.permissions, arg);
      return { kind: "continue" };
    case "deny":
      if (scaffold.permissions === undefined) {
        ctx.stderr("permission controls are not available in this session\n");
        return { kind: "continue" };
      }
      runPermissionDeny(deps.io, scaffold.permissions, arg);
      return { kind: "continue" };
    case "revoke":
      if (scaffold.permissions === undefined) {
        ctx.stderr("permission controls are not available in this session\n");
        return { kind: "continue" };
      }
      runPermissionRevoke(deps.io, scaffold.permissions, arg);
      return { kind: "continue" };
    case "grants":
      if (scaffold.permissions === undefined) {
        ctx.stderr("permission controls are not available in this session\n");
        return { kind: "continue" };
      }
      runPermissionGrants(deps.io, scaffold.permissions, arg);
      return { kind: "continue" };
    case "details":
      ctx.stderr("/details is only available in the TUI; the line REPL does not keep tool results\n");
      return { kind: "continue" };
    case "diff": {
      ctx.stderr(await slashDiffText({ cwd: scaffold.workspaceRoot, platform: ctx.platform === "win32" ? "win32" : "posix", env: ctx.env }));
      return { kind: "continue" };
    }
    case "review": {
      const records = await journalRecordsOf(scaffold);
      ctx.stderr(slashReviewText(records, arg));
      return { kind: "continue" };
    }
    case "rollback": {
      const records = await journalRecordsOf(scaffold);
      ctx.stderr(slashRollbackText(records, scaffold.sessionId, arg));
      return { kind: "continue" };
    }
    case "compact": {
      const records = await journalRecordsOf(scaffold);
      const done = await compactSession(
        ctx,
        scaffold.sessionId,
        records ?? [],
        scaffold.session,
      );
      if (!done.ok) {
        ctx.stderr(`${done.problem}\n`);
        return { kind: "continue" };
      }

      ctx.stderr(`${compactNote(done.window, done.wrote)}\n`);

      return {
        kind: "replaced",
        scaffold: {
          ...scaffold,
          resumeView: done.window,
          ...(records === undefined ? {} : { resumeRecords: records }),
        },
        note: "",
      };
    }
    case "doctor":
      // The same facts `trylo doctor` prints, not a REPL-flavoured subset: a
      // person checking their setup from inside a session must reach the same
      // conclusion they would have reached outside it.
      ctx.stdout(doctorText(runDoctor(ctx).report, false));
      return { kind: "continue" };
    case "exit":
      return { kind: "exit" };
    case "new": {
      await scaffold.close();
      const next = await openReplSession(
        ctx,
        sink,
        mode,
        replSessionOptions(ctx.newId("repl"), scaffold.learning, scaffold),
      );
      if (isRunFailure(next)) {
        return { kind: "fatal", failure: next };
      }

      return { kind: "replaced", scaffold: next, note: `new session ${next.sessionId}` };
    }
    case "resume": {
      if (arg.length === 0) {
        ctx.stderr(`usage: ${command.name} ${command.arg ?? ""}\n`);
        return { kind: "continue" };
      }

      const next = await openReplSession(ctx, sink, mode, {
        message: [],
        readStdin: false,
        resume: arg,
        ...sessionLearningOptions(scaffold),
      });
      if (isRunFailure(next)) {
        return { kind: "soft_failure", failure: next };
      }

      await scaffold.close();

      return { kind: "replaced", scaffold: next, note: `resumed session ${arg}` };
    }
    default: {
      const _never: never = command.kind;
      void _never;
      return { kind: "continue" };
    }
  }
}

/** A start refusal keeps the session; a durable failure closes it and exits. */
async function replTurn(
  ctx: CliContext,
  sink: CliSink,
  mode: Mode,
  scaffold: RunScaffold,
  input: string,
): Promise<RunScaffold | RunFailure> {
  const prepared = prepareInput(input, {
    cwd: ctx.cwd,
    readFile: ctx.readFile,
    isDirectory: ctx.isDirectory,
  });
  if (!prepared.ok) {
    // Refused rather than sent: a turn about a file that never arrived would
    // have the model answer confidently about something it cannot see.
    ctx.stderr(`${prepared.problem}\n`);
    return scaffold;
  }

  if (prepared.note !== undefined) {
    ctx.stderr(`${prepared.note}\n`);
  }

  // The REPL asks per turn and never pre-approves anything: an empty choice
  // leaves every decision where it already was.
  const outcome = await runOneTurn(ctx, scaffold, prepared.text, sink, mode, {});
  if (!isTurnOutcome(outcome)) {
    ctx.stderr(`${outcome.message}\n${outcome.hint}\n`);
    if (outcome.continuation === "session_closed") return outcome;
    return scaffold;
  }

  for (const warning of outcome.warnings) {
    ctx.stderr(`warning: ${warning}\n`);
  }

  return await scaffoldAfterTurn(scaffold, outcome);
}

export async function handleRepl(
  ctx: CliContext,
  sink: CliSink,
  learning?: LearningSwitch,
  learningOptions: SessionLearningOptions = {},
): Promise<ExitCode> {
  const mode: Mode = ctx.stdinIsTty ? "interactive" : "non_interactive";
  let scaffold = await openReplSession(
    ctx,
    sink,
    mode,
    replSessionOptions(ctx.newId("repl"), learning, learningOptions),
  );
  if (isRunFailure(scaffold)) {
    return reportFailure(ctx, scaffold);
  }

  ctx.stderr(`trylo interactive session ${scaffold.sessionId}. /help for commands, /exit to leave.\n`);
  const io = lineIoOf(ctx);

  try {
    for (;;) {
      ctx.stderr("> ");
      const line = await readMultiLine(() => ctx.readLine());
      if (line === undefined) {
        return EXIT_CODES.OK;
      }

      const input = line.trim();
      if (input.length === 0) {
        continue;
      }

      const slash = parseSlash(input);
      let turnInput = input;

      if (slash.kind === "unknown") {
        // Reported and dropped. A typo is not a prompt: sending it to the model
        // would put a string the user never meant to say into the transcript.
        // The one exception is WP14/L52: an installed, user-invocable skill
        // names itself like a command, and `/name args` expands into the turn.
        const expanded = expandSkillSlash(input, scaffold.workspaceRoot, ctx.homeDir, ctx.env);
        if (expanded === undefined) {
          ctx.stderr(`unknown command ${slash.token}; /help for the list\n`);
          continue;
        }

        ctx.stderr(`invoked skill ${expanded.name}\n`);
        turnInput = expanded.text;
      }

      if (slash.kind === "known") {
        const result = await dispatchSlash(slash.invocation, { ctx, sink, mode, scaffold, io });
        if (result.kind === "exit") {
          return EXIT_CODES.OK;
        }

        if (result.kind === "fatal") {
          return reportFailure(ctx, result.failure);
        }

        if (result.kind === "soft_failure") {
          reportFailure(ctx, result.failure);
          continue;
        }

        if (result.kind === "replaced") {
          scaffold = result.scaffold;
          ctx.stderr(`${result.note}\n`);
        }

        continue;
      }

      const next = await replTurn(ctx, sink, mode, scaffold, await answerQuestionInput(scaffold.questions, turnInput, ctx.readLine));
      if (isRunFailure(next)) return reportFailure(ctx, next);

      scaffold = next;
    }
  } finally {
    await scaffold.close();
  }
}
