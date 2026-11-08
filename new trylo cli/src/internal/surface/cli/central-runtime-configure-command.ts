import { fields, identity } from "../../validation/json-shape.js";
import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { CliContext } from "./context.js";
import { resolveWorkspaceRoot } from "./run-workspace.js";
import { isCentralRuntimeConfigurationPatch, reconfigureCentralRuntimeFor } from "./central-runtime-reconfigure.js";

/** An explicit public settings change, without a business task or new funds. */
export async function handleCentralRuntimeConfigureCommand(ctx: CliContext, input: unknown): Promise<ExitCode> {
  if (!fields(input, ["workspaceRoot", "action", "patch"]) || input.action !== "configure"
    || !identity(input.workspaceRoot) || !isCentralRuntimeConfigurationPatch(input.patch)) {
    ctx.stdout(`${JSON.stringify({ schemaVersion: 1, domain: "central_runtime", ok: false, reason: "runtime_configuration_patch_invalid" })}\n`);
    return EXIT_CODES.USAGE;
  }

  const scope = resolveWorkspaceRoot(ctx, input.workspaceRoot);
  if (typeof scope !== "string") {
    ctx.stdout(`${JSON.stringify({ schemaVersion: 1, domain: "central_runtime", ok: false, reason: "workspace_unavailable" })}\n`);
    return scope.exitCode;
  }

  const result = await reconfigureCentralRuntimeFor(ctx, scope, input.patch);

  ctx.stdout(`${JSON.stringify({ schemaVersion: 1, domain: "central_runtime", ...result })}\n`);

  return result.ok ? EXIT_CODES.OK : EXIT_CODES.CONFIG;
}
