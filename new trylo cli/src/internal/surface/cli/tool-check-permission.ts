import type { CliContext } from "./context.js";
import type { RunCommandOptions } from "./args.js";
import type { JsonObject } from "../../protocol/envelope.js";
import { permissionPattern } from "../../ports/permission.js";
import { permissionFor } from "./permission-for-run.js";

/** Checking or inspecting a quarantined executable always needs ordinary execution permission first. */
export async function authorizeToolCheck(ctx: CliContext, run: RunCommandOptions, subject: JsonObject, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  const permission = permissionFor(ctx.stdinIsTty ? "interactive" : "non_interactive", ctx, run);
  const ticket = await permission.request({ toolCallId: ctx.newId("tool-check"), name: "run_shell", arguments: subject, pattern: permissionPattern("run_shell", subject) }, { signal });
  const decision = await permission.awaitDecision(ticket.ticketId, { signal });
  return decision.resolution === "approved" && !signal.aborted;
}
