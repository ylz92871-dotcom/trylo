import { openMcpRuntime, type McpRuntime } from "../../adapters/mcp-runtime/index.js";
import { createRunExecution, type RunExecution } from "./run-execution-wiring.js";
import { resolveConnectionSettings } from "./connection-settings.js";
import { runCredentialFor } from "./provider-selection.js";
import { reasoningSummaryOptions } from "./provider-build.js";
import { permissionFor } from "./permission-for-run.js";
import { skillsPortFor } from "./skills-wiring.js";
import { createCliMcpRegistry } from "./mcp-wiring.js";
import { shellModeFor } from "./shell-mode-wiring.js";
import { tryloHome } from "./session-paths.js";
import { wirePorts, type Wiring } from "./wiring.js";
import type { CliContext } from "./context.js";
import type { CliLibraryCommandHosts, CliLibraryHostFactory } from "./library-command-ports.js";
import { createBoardReader } from "../../adapters/learning-store/file-event-store.js";
import { methodBoardRoot } from "./learning-sink.js";
import { readFocusedCollaborationTeam } from "./collaboration-source-team.js";
import { webBackendsFor } from "./web-wiring.js";

/** Opens the same runtime table as a run, without a business turn, session or learner invocation. */
export async function openCliLibraryHosts(ctx: CliContext,
  input: Parameters<CliLibraryHostFactory>[0]): Promise<CliLibraryCommandHosts> {
  input.signal.throwIfAborted();
  const scoped: CliContext = { ...ctx, cwd: input.workspaceRoot,
    ...(input.approval === undefined ? {} : { approval: input.approval }) };
  const connection = resolveConnectionSettings(scoped, { message: [], readStdin: false, workspace: input.workspaceRoot });
  if ("exitCode" in connection) {
    ctx.stderr(`library configuration unavailable: ${connection.message}\n`);
    throw new Error("library_configuration_unavailable");
  }

  const selected = connection.provider;
  const credential = runCredentialFor(scoped, selected.kind, selected.accountId);
  if ("exitCode" in credential) {
    ctx.stderr(`library connection unavailable: ${credential.message}\n`);
    throw new Error("library_connection_unavailable");
  }

  const permission = permissionFor(scoped.approval !== undefined || ctx.stdinIsTty ? "interactive" : "non_interactive", scoped, {}, input.workspaceRoot);
  const turnId = ctx.newId("library");
  const skills = skillsPortFor(ctx.homeDir, ctx.env, input.workspaceRoot);

  for (const problem of skills.problems) ctx.stderr(`warning: ${problem}\n`);

  const source = input.purpose !== "collaboration" ? undefined : await readFocusedCollaborationTeam({
    board: createBoardReader(methodBoardRoot(ctx.homeDir, ctx.env)), scope: input.workspaceRoot,
    readFile: ctx.readFile, now: ctx.now, ...(skills.catalog === undefined ? {} : { skills: skills.catalog }) });

  input.signal.throwIfAborted();

  if (source?.ok === false) {
    ctx.stderr(`collaboration source unavailable: ${source.reason}\n`);
    throw new Error(source.reason);
  }

  const shellMode = connection.settings.shell === undefined || ctx.platform === undefined ? undefined
    : shellModeFor(connection.settings.shell, { platform: ctx.platform as NodeJS.Platform, env: ctx.env,
      fileExists: file => ctx.readFile(file) !== undefined });
  let execution: RunExecution | undefined, mcp: McpRuntime | undefined, wiring: Wiring | undefined, closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try { await wiring?.close(); }
    finally { try { await mcp?.close(); } finally { await execution?.close(); } }
  };

  try {
    execution = createRunExecution(input.workspaceRoot, { homeDir: ctx.homeDir, env: ctx.env });
    mcp = await openMcpRuntime({ registry: createCliMcpRegistry(scoped), cwd: input.workspaceRoot });

    for (const warning of mcp.warnings) ctx.stderr(`warning: ${warning}\n`);

    input.signal.throwIfAborted();
    const built = wirePorts({ providerId: selected.providerId, providerKind: selected.kind, model: selected.model,
      endpoint: selected.endpoint, ...credential, apiKey: credential.apiKey, ...reasoningSummaryOptions(selected),
      workspaceRoot: input.workspaceRoot, checkpointRoot: `${tryloHome(ctx.homeDir, ctx.env)}/checkpoints`,
      execution, permission, nowMs: ctx.now(), turnId, mcp: { tools: mcp.tools, toolNames: mcp.toolNames },
      // This independent library host assembles specialist resources. Mounting
      // declares availability only; original Permission/Sandbox still admit every call.
      allowWeb: true, web: webBackendsFor({ providerKind: selected.kind, endpoint: selected.endpoint, model: selected.model,
        apiKey: credential.apiKey, ...(credential.tokenManager === undefined ? {} : { tokenManager: credential.tokenManager }) }),
      ...(skills.catalog === undefined ? {} : { skills: skills.catalog }),
      ...(shellMode === undefined ? {} : { shellMode }),
      collaborationLearning: { homeDir: ctx.homeDir, env: ctx.env, scope: input.workspaceRoot, turnId, now: ctx.now,
        ...(source?.ok === true && source.team !== undefined ? { team: source.team } : {}),
        ...(source?.ok === true && source.taskId !== undefined ? { taskId: source.taskId } : {}),
        ...(source?.ok === true && source.sourceIssueId !== undefined ? { sourceIssueId: source.sourceIssueId } : {}),
        signal: input.signal, warn: reason => ctx.stderr(`warning: ${reason}\n`) } });
    if ("code" in built) {
      ctx.stderr(`library runtime unavailable: ${built.code}\n`);
      throw new Error("library_runtime_unavailable");
    }

    wiring = built;
    const capabilities = wiring.capabilities;
    if (capabilities === undefined) throw new Error("library_capabilities_unavailable");

    input.signal.throwIfAborted();

    return {
      tool: { async execute(context, command, signal) {
        signal.throwIfAborted();
        if (closed) throw new Error("library_host_closed");
        if (context.scope !== input.workspaceRoot) throw new Error("library_scope_mismatch");
        return capabilities.executeTool(context.memberId, command, signal);
      } },
      expert: { async execute(command, context) {
        const signal = context?.signal ?? input.signal;
        signal.throwIfAborted();
        if (closed) throw new Error("library_host_closed");
        return capabilities.expertHost.execute(command, { signal,
          useScope: { workspaceId: input.workspaceRoot, taskId: turnId } });
      } },
      collaboration: { async run(allowance, signal) {
        signal.throwIfAborted();
        if (closed) throw new Error("library_host_closed");
        const runtime = wiring?.collaboration;
        if (runtime === undefined) throw new Error("collaboration_runtime_unavailable");
        return runtime.learn(allowance, AbortSignal.any([input.signal, signal]));
      } },
      close,
    };
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "library_host_initialization_failed"); }
    throw error;
  }
}
