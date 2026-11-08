import path from "node:path";
import { isRuntimeWake, type CentralRuntimeWake } from "../../adapters/central-learning-runtime/contracts.js";
import { readRuntimeIntent, readRuntimeLocator, runtimeScopePaths } from "../../adapters/central-learning-runtime/files.js";
import { requestCentralRuntime } from "../../adapters/central-learning-runtime/transport.js";
import type { CliContext } from "./context.js";
import { tryloHome } from "./session-paths.js";

export type CentralRuntimeSourceNotification = CentralRuntimeWake & { readonly workspaceRoot: string };

export type CentralRuntimeSourceNotificationResult = { readonly ok: true; readonly notified: boolean }
  | { readonly ok: false; readonly reason: string };

/** An original source commit may wake an enabled existing owner. It never starts or attaches one. */
export async function notifyCentralRuntimeForSource(ctx: CliContext,
  input: CentralRuntimeSourceNotification, signal?: AbortSignal): Promise<CentralRuntimeSourceNotificationResult> {
  if (!isRuntimeWake({ reason: input.reason, sourceRefs: input.sourceRefs })) return { ok: false, reason: "runtime_wake_invalid" };
  try {
    const paths = runtimeScopePaths(path.resolve(ctx.cwd, tryloHome(ctx.homeDir, ctx.env)), input.workspaceRoot);
    const intent = readRuntimeIntent(paths);
    if (!intent.ok) return intent;

    if (intent.value?.enabled !== true) return { ok: true, notified: false };

    const locator = readRuntimeLocator(paths);
    if (!locator.ok) return locator;

    if (locator.value === undefined) return { ok: true, notified: false };

    const reply = await requestCentralRuntime(locator.value, { operation: "wake", wake: { reason: input.reason, sourceRefs: input.sourceRefs } }, signal);

    return reply.ok ? { ok: true, notified: true } : reply;
  } catch { return { ok: false, reason: "runtime_source_notify_unavailable" }; }
}

/** The source transaction has already committed. A missed hint is reported
 * without undoing that fact or repeating its original native operation. */
export async function notifyCommittedCentralRuntimeForSource(ctx: CliContext,
  input: CentralRuntimeSourceNotification): Promise<void> {
  let reason: string | undefined;

  try {
    const result = await notifyCentralRuntimeForSource(ctx, input);
    if (!result.ok) reason = result.reason;
  } catch { reason = "runtime_source_notify_unavailable"; }

  if (reason !== undefined) {
    try { ctx.stderr(`warning: central_runtime_source_notify:${reason}\n`); }
    catch { /* Diagnostic delivery cannot undo an already committed source or authorize a repeat transaction. */ }
  }
}
