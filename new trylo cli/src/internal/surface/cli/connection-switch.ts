import type { CliContext } from "./context.js";
import { sessionLearningOptions } from "./session-learning-options.js";
import type { CliSink } from "./render.js";
import { prepareRun, isRunFailure, type RunScaffold } from "./run-command.js";
import { fail, type RunFailure } from "./run-failure.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import { isKeyedProviderKind } from "../../adapters/provider/providers-file.js";
import { editDeclaredProvider, switchSelected } from "./providers-wiring.js";

export type ConnectionTarget = { readonly providerId?: string; readonly model?: string };

/** The old session stays usable until the new one has opened successfully. */
export async function switchRunConnection(
  ctx: CliContext,
  current: RunScaffold,
  target: ConnectionTarget,
  sink: CliSink,
  permissionMode: "interactive" | "non_interactive",
): Promise<RunScaffold | RunFailure> {
  const sameProvider = target.providerId === undefined || target.providerId === current.providerId;
  // WP18: the run's resolved prompt/schema/fallback travel across the switch
  // as resolved values, so a mid-session connection change neither re-reads
  // files nor drops what the run was promised. `prepareRun` re-validates the
  // carried fallback against the new model.
  const hasResolvedRequest =
    current.reasoningEffort !== undefined ||
    current.systemPrompt !== undefined ||
    current.systemPromptAppend !== undefined ||
    current.responseSchema !== undefined ||
    current.fallbackModel !== undefined;
  const next = await prepareRun(ctx, {
    permissionMode, sink,
    options: {
      message: [], readStdin: false, session: ctx.newId("repl"), workspace: current.workspaceRoot, format: current.format,
      provider: target.providerId ?? current.providerId,
      ...(target.model !== undefined ? { model: target.model } : sameProvider ? { model: current.model } : {}),
      ...(sameProvider ? { endpoint: current.endpoint } : {}),
      ...(current.toolSelection === undefined ? {} : { toolSelection: current.toolSelection }),
      ...(hasResolvedRequest
        ? {
            resolvedRequest: {
              ...(current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort }),
              ...(current.systemPrompt === undefined ? {} : { systemPrompt: current.systemPrompt }),
              ...(current.systemPromptAppend === undefined ? {} : { systemPromptAppend: current.systemPromptAppend }),
              ...(current.responseSchema === undefined ? {} : { responseSchema: current.responseSchema }),
              ...(current.fallbackModel === undefined ? {} : { fallbackModel: current.fallbackModel }),
            },
          }
        : {}),
      ...sessionLearningOptions(current),
      ...(current.maxIterations === undefined ? {} : { maxIterations: current.maxIterations }),
      ...(current.maxTokens === undefined ? {} : { maxTokens: current.maxTokens }),
      ...(sameProvider && current.contextTokenLimit !== undefined ? { contextTokenLimit: current.contextTokenLimit } : {}),
      ...(current.permissionLedger === undefined ? {} : { permissionLedger: true }),
      ...(current.subagentEnabled === undefined ? {} : { subagent: true }),
      ...(current.allowWeb === undefined ? {} : { allowWeb: true }),
      ...(current.compactSummary === undefined ? {} : { compactSummary: current.compactSummary }),
    },
  });
  if (isRunFailure(next)) return next;

  if (isKeyedProviderKind(next.providerKind) && next.apiKey === undefined && next.tokenManager === undefined) {
    await next.close();
    return fail(EXIT_CODES.AUTH, "The new connection has no credential; the current session is unchanged.", "connect a key or select an account first");
  }

  try {
    await current.close();
  } catch (error) {
    // Do not leak the newly opened session lock if the old session cannot close.
    await next.close();
    throw error;
  }

  return next;
}

/** Explicit default selection; model is written to the declared connection only. */
export function setDefaultConnection(ctx: CliContext, target: { readonly providerId: string; readonly model?: string }) {
  if (target.model !== undefined) {
    const edited = editDeclaredProvider(ctx, { id: target.providerId, model: target.model });
    if (!edited.ok) return { ...edited, stage: "model" as const };
  }
  const selected = switchSelected(ctx, { id: target.providerId });
  return { ...selected, stage: "selection" as const };
}
