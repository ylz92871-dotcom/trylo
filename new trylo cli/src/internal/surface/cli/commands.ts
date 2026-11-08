import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { LearningSwitch, ParsedCommand } from "./args.js";
import { configValueView, loadConfig, type ConfigLoadIo } from "./config-load.js";
import type { CliContext } from "./context.js";
import { completionScript } from "./completion.js";
import type { CliSink } from "./render.js";
import { reportFailure } from "./run-failure.js";
import { tryloHome } from "./session-paths.js";
import { handleSessionList as handleSessionListEnriched, reportLastFailure, resolveLastSession } from "./session-list.js";
import { familyHelp, USAGE, VERSION } from "./usage.js";

/**
 * Command handlers.
 *
 * Every handler returns an exit code and writes only through the injected
 * context, so the same code path is exercised by in-process tests and by the
 * real binary. Management families load only when selected: a runtime probe
 * or Desktop run must not load OAuth, MCP administration, or the daemon.
 */

export function sinkFor(ctx: CliContext): CliSink {
  return { stdout: ctx.stdout, stderr: ctx.stderr };
}

function configIo(ctx: CliContext): ConfigLoadIo {
  return { readFile: ctx.readFile, profileDir: tryloHome(ctx.homeDir, ctx.env), cwd: ctx.cwd };
}

function handleVersion(ctx: CliContext): ExitCode {
  ctx.stdout(`${VERSION}\n`);
  return EXIT_CODES.OK;
}

async function handleDoctor(ctx: CliContext, json: boolean, learning?: LearningSwitch): Promise<ExitCode> {
  const { doctorText, runDoctor } = await import("./doctor-run.js");
  const run = runDoctor(ctx, learning);
  ctx.stdout(doctorText(run.report, json));
  return run.code;
}

function handleConfigShow(ctx: CliContext, json: boolean): ExitCode {
  const loaded = loadConfig(configIo(ctx), {});
  if (!loaded.ok) {
    const where = loaded.failure.path ?? loaded.failure.layer;
    return reportFailure(ctx, {
      exitCode: EXIT_CODES.CONFIG,
      message: `${where} is not usable: ${loaded.failure.detail}`,
      hint: "fix or remove that config file; an unreadable config never falls back silently",
    });
  }

  if (json) {
    ctx.stdout(
      `${JSON.stringify({
        values: configValueView(loaded.resolved),
        layers: loaded.sources,
      })}\n`,
    );
    return EXIT_CODES.OK;
  }

  const view = configValueView(loaded.resolved);

  for (const key of Object.keys(view).sort()) {
    const entry = view[key];
    if (entry === undefined) {
      continue;
    }
    ctx.stdout(`${key} = ${JSON.stringify(entry.value)}  (from ${entry.sourceLayer})\n`);
  }

  return EXIT_CODES.OK;
}

function handleSessionList(ctx: CliContext, json: boolean, search?: string, all = false): Promise<ExitCode> {
  return handleSessionListEnriched(ctx, { json, ...(search === undefined ? {} : { search }), all });
}

export async function dispatch(parsed: ParsedCommand, ctx: CliContext): Promise<ExitCode> {
  const sink = sinkFor(ctx);

  // Select the command family before importing its runtime dependencies.
  switch (parsed.kind) {
    case "library": return (await import("./commands-library.js")).handleLibraryCommand(ctx, parsed.options);
    case "learn":
      return (await import("./commands-learn.js")).handleLearn(ctx, parsed.options);
    case "help":
      ctx.stdout(`${USAGE}\n`);
      return EXIT_CODES.OK;
    case "family_help": {
      const scoped = familyHelp(parsed.options.family);
      ctx.stdout(`${scoped ?? USAGE}\n`);
      return EXIT_CODES.OK;
    }
    case "version":
      return handleVersion(ctx);
    case "doctor":
      return handleDoctor(ctx, parsed.json, parsed.learning);
    case "config_show":
      return handleConfigShow(ctx, parsed.json);
    case "session_list":
      return handleSessionList(ctx, parsed.json, parsed.search, parsed.all);
    case "session_info":
      return (await import("./commands-session.js")).handleSessionInfo(ctx, parsed.options);
    case "session_fork":
      return (await import("./commands-session.js")).handleSessionFork(ctx, parsed.options);
    case "session_rename":
      return (await import("./commands-session.js")).handleSessionRename(ctx, parsed.options);
    case "session_export":
      return (await import("./commands-session.js")).handleSessionExport(ctx, parsed.options);
    case "session_archive":
      return (await import("./commands-session.js")).handleSessionArchive(ctx, parsed.options);
    case "session_remove":
      return (await import("./commands-session.js")).handleSessionRemove(ctx, parsed.options);
    case "session_reconcile": {
      const { reconcile, reportReconcile } = await import("./session-reconcile.js");
      const request = {
        session: parsed.options.session,
        ...(parsed.options.turn === undefined ? {} : { turn: parsed.options.turn }),
        ...(parsed.options.key === undefined ? {} : { key: parsed.options.key }),
        ...(parsed.options.outcome === undefined ? {} : { outcome: parsed.options.outcome }),
        ...(parsed.options.evidence === undefined ? {} : { evidence: parsed.options.evidence }),
        json: parsed.options.json,
      };

      return reportReconcile(ctx, request, await reconcile(request, ctx));
    }
    case "run": {
      // Desktop probes providers/status before every turn. Load execution only
      // for an execution command, so a read-only probe never initializes it.
      if (parsed.options.permissionPromptTool === "stdio") {
        const { handleStdioRun } = await import("./run-stdio.js");
        return handleStdioRun(ctx, parsed.options, sink);
      }

      if (parsed.options.resumeLast === true) {
        const last = await resolveLastSession(ctx);
        if (!last.ok) {
          return reportLastFailure(ctx, last);
        }

        const { resumeLast: _dropped, ...rest } = parsed.options;
        const { handleRun } = await import("./run-command.js");

        return handleRun(ctx, { ...rest, resume: last.sessionId }, sink);
      }

      const { handleRun } = await import("./run-command.js");

      return handleRun(ctx, parsed.options, sink);
    }
    case "login":
      return (await import("./commands-auth.js")).handleLogin(ctx, parsed.options);
    case "logout":
      return (await import("./commands-auth.js")).handleLogout(ctx, parsed.options);
    case "auth_status":
      return (await import("./commands-auth.js")).handleAuthStatus(ctx, parsed.json);
    case "auth_list":
      return (await import("./commands-auth.js")).handleAuthList(ctx, parsed.json, parsed.project);
    case "auth_switch":
      return (await import("./commands-auth.js")).handleAuthSwitch(ctx, parsed.options);
    case "auth_delete":
      return (await import("./commands-auth.js")).handleAuthDelete(ctx, parsed.options);
    case "mcp_add":
      return (await import("./commands-mcp.js")).handleMcpAdd(ctx, parsed.options);
    case "mcp_list":
      return (await import("./commands-mcp.js")).handleMcpList(ctx, parsed.json);
    case "mcp_status":
      return (await import("./commands-mcp.js")).handleMcpStatus(ctx, parsed.json);
    case "mcp_remove":
      return (await import("./commands-mcp.js")).handleMcpRemove(ctx, parsed.options);
    case "mcp_set_enabled":
      return (await import("./commands-mcp.js")).handleMcpSetEnabled(ctx, parsed.options, parsed.enabled);
    case "checkpoint_list": {
      const { handleCheckpointList } = await import("./commands-checkpoint.js");
      return handleCheckpointList(ctx, parsed.options);
    }
    case "checkpoint_restore": {
      const { handleCheckpointRestore } = await import("./commands-checkpoint.js");
      return handleCheckpointRestore(ctx, parsed.options);
    }
    case "checkpoint_diff": {
      const { handleCheckpointDiff } = await import("./commands-review.js");
      return handleCheckpointDiff(ctx, parsed.options);
    }
    case "queue_add": {
      const { handleQueueAdd } = await import("./commands-queue.js");
      return handleQueueAdd(ctx, parsed.options);
    }
    case "queue_list": {
      const { handleQueueList } = await import("./commands-queue.js");
      return handleQueueList(ctx, parsed.options);
    }
    case "queue_drop": {
      const { handleQueueDrop } = await import("./commands-queue.js");
      return handleQueueDrop(ctx, parsed.options);
    }
    case "session_review": {
      const { handleSessionReview } = await import("./commands-session-review.js");
      return handleSessionReview(ctx, parsed.options);
    }
    case "diff": {
      const { handleDiff } = await import("./commands-review.js");
      return handleDiff(ctx, parsed.options);
    }
    case "review": {
      const { handleReview } = await import("./commands-review.js");
      return handleReview(ctx, parsed.options);
    }
    case "providers_list":
      return (await import("./commands-providers.js")).handleProvidersList(ctx, { json: parsed.json });
    case "providers_models":
      return (await import("./commands-providers.js")).handleProvidersModels(ctx, parsed.options);
    case "providers_switch":
      return (await import("./commands-providers.js")).handleProvidersSwitch(ctx, parsed.options);
    case "providers_add":
      return (await import("./commands-providers.js")).handleProvidersAdd(ctx, parsed.options);
    case "providers_remove":
      return (await import("./commands-providers.js")).handleProvidersRemove(ctx, parsed.options);
    case "providers_edit":
      return (await import("./commands-providers.js")).handleProvidersEdit(ctx, parsed.options);
    case "providers_config":
      return (await import("./commands-providers.js")).handleProvidersConfig(ctx, parsed.options);
    case "completion":
      ctx.stdout(completionScript(parsed.shell));
      return EXIT_CODES.OK;
    case "update": {
      const { handleUpdate } = await import("./commands-update.js");
      return handleUpdate(ctx, parsed.options);
    }
    case "memory_import": {
      const { handleMemoryImport } = await import("./commands-memory.js");
      return handleMemoryImport(ctx, parsed.options);
    }
    case "memory_mutate": {
      const { handleMemoryMutation } = await import("./commands-memory-mutate.js");
      return handleMemoryMutation(ctx, parsed.action);
    }
    case "memory_delete": {
      const { handleMemoryDelete } = await import("./commands-memory.js");
      return handleMemoryDelete(ctx, parsed.options);
    }
    case "memory_list": {
      const { handleMemoryList } = await import("./commands-memory.js");
      return handleMemoryList(ctx, parsed.options);
    }
    case "memory_compact": {
      const { handleMemoryCompact } = await import("./commands-memory.js");
      return handleMemoryCompact(ctx, parsed.options);
    }
    case "output_style_list": {
      const { handleOutputStyleList } = await import("./commands-output-style.js");
      return handleOutputStyleList(ctx, parsed.options);
    }
    case "output_style_show": {
      const { handleOutputStyleShow } = await import("./commands-output-style.js");
      return handleOutputStyleShow(ctx, parsed.options);
    }
    case "workflow_learning": {
      const { handleWorkflowLearning } = await import("./commands-workflow-learning.js");
      return handleWorkflowLearning(ctx, parsed.args);
    }
    case "workflow_list": {
      const { handleWorkflowList } = await import("./commands-workflow.js");
      return handleWorkflowList(ctx, parsed.options);
    }
    case "workflow_show": {
      const { handleWorkflowShow } = await import("./commands-workflow.js");
      return handleWorkflowShow(ctx, parsed.options);
    }
    case "workflow_run": {
      const { handleWorkflowRun } = await import("./commands-workflow.js");
      return handleWorkflowRun(ctx, parsed.options, sink);
    }
    case "context": {
      const { handleContext } = await import("./commands-context.js");
      return handleContext(ctx, parsed.options);
    }
    case "family":
      // The family answers for its own verbs, in its own words (`family-entries.ts`).
      return (await import("./family-entries.js")).runFamilyCommand(parsed.word, ctx, parsed.args);
    case "repl": {
      const { handleReplEntry } = await import("./tui/entry.js");
      return handleReplEntry(ctx, sink, parsed.learning, parsed.learningOptions);
    }
    case "error":
      return reportFailure(ctx, {
        exitCode: EXIT_CODES.USAGE,
        message: parsed.message,
        hint: parsed.hint,
      });
    default: {
      const _never: never = parsed;
      void _never;
      return EXIT_CODES.USAGE;
    }
  }
}
