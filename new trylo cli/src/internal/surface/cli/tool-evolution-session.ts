import type { CliContext } from "./context.js";
import type { RunCommandOptions } from "./args.js";
import { resolveConnectionSettings } from "./connection-settings.js";
import { runCredentialFor } from "./provider-selection.js";
import { buildProvider } from "./provider-build.js";
import { toolEvolutionExecution } from "./tool-evolution-execution.js";
import { SubagentRuntime } from "../../subagent/runtime.js";
import { SubagentToolRunner } from "../../subagent/tool-runner.js";
import { createToolEvolutionWorker } from "../../adapters/tool-evolution/provider-worker.js";
import { createToolEvolutionArchive } from "../../integration/tool-learning/evolution-archive.js";
import type { ToolJobAdmission } from "../../integration/tool-learning/evolution-archive.js";
import { createToolEvolutionRuntime } from "../../integration/tool-learning/evolution-runtime.js";
import type { ToolEvolutionRequest } from "../../learning/domains/tool/evolution/contracts.js";
import type { ToolEvolutionOutcome } from "../../integration/tool-learning/evolution-runtime.js";
import type { RunFailure } from "./run-failure.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";

export type ToolEvolutionSession = {
  evolve(request: ToolEvolutionRequest, signal: AbortSignal, initialFeedback?: string, admission?: ToolJobAdmission): Promise<ToolEvolutionOutcome>;
  close(): Promise<void>;
};

/** The lab and the post-turn worker use the same generator and real verifier. */
export function openToolEvolutionSession(ctx: CliContext, run: RunCommandOptions, options: {
  readonly boardRoot: string; readonly generationTimeoutMs?: number; readonly mode?: "manual" | "after_turn";
}): ToolEvolutionSession | RunFailure {
  const connection = resolveConnectionSettings(ctx, run);
  if ("exitCode" in connection) return connection;
  const selection = connection.provider;
  const credential = runCredentialFor(ctx, selection.kind, selection.accountId);
  if ("exitCode" in credential) return credential;
  const { permission, verifier } = toolEvolutionExecution(ctx, run, options.mode);
  const provider = buildProvider({ providerId: selection.providerId, providerKind: selection.kind,
    endpoint: selection.endpoint, model: selection.model, apiKey: credential.apiKey, ...credential,
    workspaceRoot: ctx.cwd, permission });
  if ("code" in provider) return { exitCode: EXIT_CODES.CONFIG, message: `${provider.code}: ${provider.detail}`, hint: "Review the selected tool-learning provider settings." };
  const runtime = new SubagentRuntime({ tools: {
    snapshot: () => [], execute: async () => ({ outcome: "error", code: "unknown_tool", message: "generation workers have no tool authority" }), cancel: async () => {},
  } });
  const runner = new SubagentToolRunner(runtime, createToolEvolutionWorker({ provider, model: selection.model }));
  return { evolve(request: ToolEvolutionRequest, signal: AbortSignal, initialFeedback?: string, admission?: ToolJobAdmission) {
    return createToolEvolutionRuntime({ runner, verifier, archive: createToolEvolutionArchive(options.boardRoot,
      admission === undefined ? {} : { jobAdmission: admission }), now: ctx.now,
      ...(options.generationTimeoutMs === undefined ? {} : { timeoutMs: options.generationTimeoutMs }),
      ...(initialFeedback === undefined ? {} : { initialFeedback }) }).evolve(request, signal);
  }, close: () => runtime.cancelAll() };
}
