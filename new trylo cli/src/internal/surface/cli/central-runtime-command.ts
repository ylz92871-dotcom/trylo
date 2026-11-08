import { fields, identity } from "../../validation/json-shape.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { CliContext } from "./context.js";
import { controlCentralRuntimeFor } from "./central-runtime-control.js";
import { resolveWorkspaceRoot } from "./run-workspace.js";

/** Management stays outside business sessions. Reads never activate work; recovery continues saved authority. */
export async function handleCentralRuntimeCommand(ctx: CliContext, input: unknown): Promise<ExitCode> {
  if (typeof input === "object" && input !== null && "action" in input) {
    if (input.action === "recover" || input.action === "recover_enabled") {
      return (await import("./central-runtime-recovery.js")).handleCentralRuntimeRecoveryCommand(ctx, input);
    }

    if (input.action === "configure") return (await import("./central-runtime-configure-command.js")).handleCentralRuntimeConfigureCommand(ctx, input);

    if (input.action === "budget_inspect" || input.action === "budget_set_limits") {
      const { handleCentralRuntimeBudgetCommand } = await import("./central-runtime-budget.js");
      return handleCentralRuntimeBudgetCommand(ctx, input, { notifyExistingEnabled: async notice => {
        const { notifyCentralRuntimeForSource } = await import("./central-runtime-notify.js");
        return notifyCentralRuntimeForSource(notice.ctx, { workspaceRoot: notice.workspaceRoot,
          reason: notice.wake.reason, sourceRefs: notice.wake.sourceRefs });
      } });
    }
  }

  if (!fields(input, ["workspaceRoot", "action"]) || !identity(input.workspaceRoot)
    || input.action !== "inspect" && input.action !== "overview" && input.action !== "stop" && input.action !== "pause" && input.action !== "resume") {
    ctx.stdout(`${JSON.stringify({ ok: false, reason: "central_runtime_control_invalid" })}\n`);
    return EXIT_CODES.USAGE;
  }

  const scope = resolveWorkspaceRoot(ctx, input.workspaceRoot);
  if (typeof scope !== "string") {
    ctx.stdout(`${JSON.stringify({ ok: false, reason: "workspace_unavailable" })}\n`);
    return scope.exitCode;
  }

  if (input.action === "overview") {
    const { readCentralRuntimeOverviewFor } = await import("./central-runtime-overview.js");
    const learning = await readCentralRuntimeOverviewFor(ctx, scope), ok = learning.status !== "unavailable";
    ctx.stdout(`${JSON.stringify({ schemaVersion: 1, domain: "central_runtime", action: "overview", ok, learning })}\n`);
    return ok ? EXIT_CODES.OK : EXIT_CODES.CONFIG;
  }

  const result = await controlCentralRuntimeFor(ctx, scope, input.action);

  ctx.stdout(`${JSON.stringify({ schemaVersion: 1, domain: "central_runtime", ...result })}\n`);

  return result.ok ? EXIT_CODES.OK : EXIT_CODES.CONFIG;
}
