import { EXIT_CODES, type ExitCode } from "../../../protocol/cli-stream.js";
import type { LearningSwitch, RunCommandOptions } from "../args.js";
import type { CliContext } from "../context.js";
import { compactNote, compactSession } from "../compact-session.js";
import { doctorText, runDoctor } from "../doctor-run.js";
import { journalRecordsOf, statusLines, usageLines } from "../session-info.js";
import { switchRunConnection } from "../connection-switch.js";
import { isRunFailure, prepareRun, reportFailure, type RunFailure } from "../run-command.js";
import { sessionLearningOptions, type SessionLearningOptions } from "../session-learning-options.js";
import type { RunScaffold } from "../run-command.js";
import { slashHelpText, type SlashInvocation } from "../slash.js";
import { slashDiffText, slashReviewText, slashRollbackText } from "../review-slash.js";
import { emptyTuiState, type TuiState, type ToolResultEntry } from "./state.js";
import type { TuiIo } from "./io.js";
import { runConnectForm } from "./connection-ui.js";
import { runModelMenu } from "./model-menu.js";
import { settingsText } from "../settings-view.js";
import { selectSession, restoredConversation } from "./session-menu.js";
import { choose } from "./choose.js";
import { listConnections } from "../connection-status.js";
import {
  runPermissionAllow,
  runPermissionDeny,
  runPermissionGrants,
  runPermissionMode,
  runPermissionRevoke,
} from "./permission-ui.js";

/**
 * What a slash command does to the TUI: the session-opening half and the
 * dispatch half.
 *
 * Split out of `entry.ts` because both belong to one job — a command that
 * replaces the session (`/new`, `/resume`) is the opening it triggers — and
 * `entry.ts` is the loop, not the command table. The file-size discipline is
 * what forced the split; the cohesion is what decided where the line goes.
 *
 * Same table, same outcomes as the line REPL: `/new` failing leaves,
 * `/resume` failing stays.
 */

export type TuiOpen =
  | { readonly kind: "opened"; readonly scaffold: RunScaffold }
  | { readonly kind: "failure"; readonly failure: RunFailure };

export type SlashStep =
  | { readonly kind: "continue"; readonly scaffold: RunScaffold; readonly state: TuiState }
  | { readonly kind: "stop"; readonly exitCode: ExitCode }
  | {
      readonly kind: "retry";
      readonly scaffold: RunScaffold;
      readonly state: TuiState;
      readonly failure: RunFailure;
    };

export function newTuiSessionOptions(
  sessionId: string,
  learning?: LearningSwitch,
  options: SessionLearningOptions = {},
): RunCommandOptions {
  return {
    message: [],
    readStdin: false,
    session: sessionId,
    ...sessionLearningOptions(options),
    ...(learning === undefined ? {} : { learning }),
  };
}

export async function openTuiSession(
  ctx: CliContext,
  io: TuiIo,
  options: RunCommandOptions,
): Promise<TuiOpen> {
  const opened = await prepareRun(ctx, {
    options,
    sink: { stdout: io.write, stderr: io.write },
    permissionMode: "interactive",
  });
  // The warm layer already rides on the scaffold (`prepareRun` builds it), so
  // this shell gets one provider for the whole session without importing
  // anything from the provider layer — which the TUI's discipline forbids.
  return isRunFailure(opened)
    ? { kind: "failure", failure: opened }
    : { kind: "opened", scaffold: opened };
}

export async function tuiSlash(
  ctx: CliContext,
  io: TuiIo,
  scaffold: RunScaffold,
  state: TuiState,
  invocation: SlashInvocation,
  factsOf: (scaffold: RunScaffold) => Parameters<typeof emptyTuiState>[0],
): Promise<SlashStep> {
  const { command, arg } = invocation;
  switch (command.kind) {
    case "help":
      io.write(`${slashHelpText()}\n`);
      return { kind: "continue", scaffold, state };
    case "settings": {
      io.write(settingsText(ctx, scaffold));

      if (io.choose === undefined) return { kind: "continue", scaffold, state };

      const action = await choose(io, { title: "设置", items: [
        { id: "model", label: "更换模型" }, { id: "connect", label: "添加或编辑连接" }, { id: "mode", label: "操作权限" },
      ] });
      if (action === undefined) return { kind: "continue", scaffold, state };

      const kind = action === "model" ? "model" : action === "connect" ? "connect" : "mode";

      return tuiSlash(ctx, io, scaffold, state, { command: { name: `/${kind}`, aliases: [], summary: "", kind }, arg: "" }, factsOf);
    }
    case "status":
      io.write(
        `${statusLines(
          { ...factsOf(scaffold), maxIterations: scaffold.maxIterations },
          state.iterations,
        ).join("\n")}\n`,
      );
      return { kind: "continue", scaffold, state };
    case "usage":
      io.write(`${usageLines(state.usage, state.durationMs).join("\n")}\n`);
      return { kind: "continue", scaffold, state };
    case "compact": {
      const done = await compactSession(
        ctx,
        scaffold.sessionId,
        (await journalRecordsOf(scaffold)) ?? [],
        scaffold.session,
      );
      if (!done.ok) {
        io.write(`${done.problem}\n`);
        return { kind: "continue", scaffold, state };
      }

      io.write(`${compactNote(done.window, done.wrote)}\n`);

      return {
        kind: "continue",
        scaffold: { ...scaffold, resumeView: done.window },
        state,
      };
    }
    case "doctor":
      io.write(doctorText(runDoctor(ctx).report, false));
      return { kind: "continue", scaffold, state };
    case "model": {
      if (arg.length === 0) {
        const next = await runModelMenu(ctx, io, scaffold, { stdout: io.write, stderr: io.write });
        if (next === undefined) {
          return { kind: "continue", scaffold, state };
        }

        if (isRunFailure(next)) {
          return { kind: "retry", scaffold, state, failure: next };
        }

        io.write(`model ${next.model} (new session ${next.sessionId}; previous session ${scaffold.sessionId} stays resumable)\n`);

        return {
          kind: "continue",
          scaffold: next,
          state: emptyTuiState(factsOf(next)),
        };
      }

      const next = await switchRunConnection(ctx, scaffold, { model: arg }, { stdout: io.write, stderr: io.write }, "interactive");
      if (isRunFailure(next)) {
        return { kind: "retry", scaffold, state, failure: next };
      }

      io.write(`model ${arg} (new session ${next.sessionId}; previous session ${scaffold.sessionId} stays resumable)\n`);

      return {
        kind: "continue",
        scaffold: next,
        state: emptyTuiState(factsOf(next)),
      };
    }
    case "connect": {
      const trimmed = arg.trim();
      let operation: "add" | "edit" = trimmed.toLowerCase().startsWith("edit ") ? "edit" : "add";
      let existingId: string | undefined;

      if (trimmed.length === 0 && io.choose !== undefined) {
        const connections = listConnections(ctx);
        const editable = connections.ok ? connections.providers.filter(provider => !provider.builtin && provider.kind === "openai-compatible") : [];
        if (editable.length > 0) {
          const action = await choose(io, { title: "模型连接", items: [{ id: "add", label: "添加新连接" }, ...editable.map(provider => ({ id: provider.id, label: `编辑 ${provider.id}`, detail: provider.model }))] });
          if (action === undefined) return { kind: "continue", scaffold, state };
          if (action !== "add") {
            operation = "edit";
            existingId = action;
          }
        }
      }

      if (operation === "edit") {
        existingId ??= trimmed.slice("edit ".length).trim();
        if (existingId.length === 0) {
          io.write(`usage: ${command.name} ${command.arg ?? ""}\n`);
          return { kind: "continue", scaffold, state };
        }
      }

      const result = await runConnectForm(ctx, io, operation, existingId);
      if (result === undefined) {
        return { kind: "continue", scaffold, state };
      }

      if (!result.ok) {
        io.write(`save failed at stage ${result.stage}: ${result.code}: ${result.detail}\n`);

        if (result.committed.length > 0) {
          io.write(`already committed: ${result.committed.join(", ")}\n`);
        }

        if (result.accountId !== undefined) {
          io.write(`account id: ${result.accountId}\n`);
        }

        return { kind: "continue", scaffold, state };
      }

      io.write(`saved connection ${result.id}${result.accountId !== undefined ? ` (account ${result.accountId})` : ""}\n`);

      if (result.useNow === true) {
        const next = await switchRunConnection(ctx, scaffold, { providerId: result.id }, { stdout: io.write, stderr: io.write }, "interactive");
        if (isRunFailure(next)) {
          io.write("连接已保存为默认，但新会话打开失败；当前会话继续可用。\n");
          return { kind: "retry", scaffold, state, failure: next };
        }

        io.write(`已使用 ${next.providerId}/${next.model}；原会话 ${scaffold.sessionId} 可恢复。\n`);

        return { kind: "continue", scaffold: next, state: emptyTuiState(factsOf(next)) };
      }

      io.write("this session still runs on the current connection; /model switches it\n");

      return { kind: "continue", scaffold, state };
    }
    case "mode":
      if (scaffold.permissions === undefined) {
        io.write("permission mode is not available in this session\n");
        return { kind: "continue", scaffold, state };
      }
      {
        const mode = arg.length > 0 ? arg : await choose(io, { title: "操作权限", initialId: scaffold.permissions.snapshot().mode,
          items: [{ id: "confirm", label: "逐项确认", detail: "需要权限的操作先询问" },
            { id: "read-only", label: "只读" }, { id: "auto-edit", label: "自动编辑", detail: "沿用现有权限策略" }] });
        if (mode !== undefined) runPermissionMode(io, scaffold.permissions, mode);
        return { kind: "continue", scaffold, state: { ...state, facts: factsOf(scaffold) } };
      }
    case "allow":
      if (scaffold.permissions === undefined) {
        io.write("permission controls are not available in this session\n");
        return { kind: "continue", scaffold, state };
      }
      runPermissionAllow(io, scaffold.permissions, arg);
      return { kind: "continue", scaffold, state };
    case "deny":
      if (scaffold.permissions === undefined) {
        io.write("permission controls are not available in this session\n");
        return { kind: "continue", scaffold, state };
      }
      runPermissionDeny(io, scaffold.permissions, arg);
      return { kind: "continue", scaffold, state };
    case "revoke":
      if (scaffold.permissions === undefined) {
        io.write("permission controls are not available in this session\n");
        return { kind: "continue", scaffold, state };
      }
      runPermissionRevoke(io, scaffold.permissions, arg);
      return { kind: "continue", scaffold, state };
    case "grants":
      if (scaffold.permissions === undefined) {
        io.write("permission controls are not available in this session\n");
        return { kind: "continue", scaffold, state };
      }
      runPermissionGrants(io, scaffold.permissions, arg);
      return { kind: "continue", scaffold, state };
    case "details": {
      const entry = findToolResult(state.toolResults, arg);
      if (entry === undefined) {
        io.write("no matching tool result; /details last shows the newest\n");
        return { kind: "continue", scaffold, state };
      }

      io.write(formatToolResultDetails(entry));

      return { kind: "continue", scaffold, state };
    }
    case "diff": {
      io.write(await slashDiffText({ cwd: scaffold.workspaceRoot, platform: ctx.platform === "win32" ? "win32" : "posix", env: ctx.env }));
      return { kind: "continue", scaffold, state };
    }
    case "review": {
      const records = await journalRecordsOf(scaffold);
      io.write(slashReviewText(records, arg));
      return { kind: "continue", scaffold, state };
    }
    case "rollback": {
      const records = await journalRecordsOf(scaffold);
      io.write(slashRollbackText(records, scaffold.sessionId, arg));
      return { kind: "continue", scaffold, state };
    }
    case "exit":
      return { kind: "stop", exitCode: EXIT_CODES.OK };
    case "new": {
      await scaffold.close();
      const next = await openTuiSession(
        ctx,
        io,
        newTuiSessionOptions(ctx.newId("repl"), scaffold.learning, scaffold),
      );
      if (next.kind === "failure") {
        return { kind: "stop", exitCode: reportFailure(ctx, next.failure) };
      }

      io.write(`new session ${next.scaffold.sessionId}\n`);

      return {
        kind: "continue",
        scaffold: next.scaffold,
        state: emptyTuiState(factsOf(next.scaffold)),
      };
    }
    case "resume": {
      const sessionId = arg.length === 0 ? await selectSession(ctx, io, scaffold.sessionId) : arg;
      if (sessionId === undefined) return { kind: "continue", scaffold, state };

      // Keep the current session open until its replacement has been prepared successfully.
      const next = await openTuiSession(ctx, io, { message: [], readStdin: false, resume: sessionId, ...sessionLearningOptions(scaffold) });
      if (next.kind === "failure") {
        return { kind: "retry", scaffold, state, failure: next.failure };
      }

      await scaffold.close();
      io.write(`resumed session ${sessionId}\n${restoredConversation(next.scaffold, io.size().columns)}`);

      return {
        kind: "continue",
        scaffold: next.scaffold,
        state: emptyTuiState(factsOf(next.scaffold)),
      };
    }
    default: {
      const _never: never = command.kind;
      void _never;
      return { kind: "continue", scaffold, state };
    }
  }
}

function findToolResult(results: ReadonlyArray<ToolResultEntry>, arg: string): ToolResultEntry | undefined {
  const trimmed = arg.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "last") {
    return results.at(-1);
  }

  const index = Number(trimmed);
  if (!Number.isNaN(index) && index >= 1) {
    return results.at(-index);
  }

  return results.find((entry) => entry.toolCallId === trimmed);
}

function formatToolResultDetails(entry: ToolResultEntry): string {
  const lines = [
    `tool: ${entry.name}`,
    `call id: ${entry.toolCallId}`,
    `status: ${entry.status}`,
  ];

  if (entry.message !== undefined && entry.message.trim().length > 0) {
    lines.push(...labelled("message", entry.message));
  }

  if (entry.output.length === 0) {
    lines.push("output: (empty)");
  } else {
    const count = entry.output.split("\n").length;
    lines.push(`output (${count} lines${entry.truncated ? " (truncated)" : ""}):`);
    lines.push(entry.output);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * A labelled block whose continuation rows align under the label: a tool
 * failure's message is often a command's whole stderr, and a second row
 * starting at column zero would read as another field.
 */
function labelled(label: string, text: string): ReadonlyArray<string> {
  const rows = text.replaceAll("\r\n", "\n").replace(/\s+$/, "").split("\n");
  const pad = " ".repeat(label.length + 2);
  return rows.map((row, index) => (index === 0 ? `${label}: ${row}` : `${pad}${row}`));
}
