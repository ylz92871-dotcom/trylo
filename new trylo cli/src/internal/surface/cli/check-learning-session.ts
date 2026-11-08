import { createExecutableCheckLearning, createCheckerProviderGenerator, createCheckerProcessOwner,
  type CheckerGenerator } from "../../learning/agent/subsystems/check/index.js";
import type { CandidateExecutor } from "../../learning/domains/tool/evolution/execution.js";
import { checkAssessmentCompatibility, createApprovedCheckerExecutor } from "./check-learning-runtime.js";
import { methodBoardRoot } from "./learning-sink.js";
import { resolveConnectionSettings } from "./connection-settings.js";
import { runCredentialFor } from "./provider-selection.js";
import { buildProvider, reasoningSummaryOptions } from "./provider-build.js";
import { permissionFor } from "./permission-for-run.js";
import type { CliContext } from "./context.js";
import type { RunCommandOptions } from "./args.js";
import type { RunFailure } from "./run-failure.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";

/** Explicit allocation uses ordinary connection/credential precedence. Management constructs no provider or executor. */
export function createStandaloneCheckRuntime(ctx: CliContext, run: RunCommandOptions, mode: "learn" | "manage") {
  let generator: CheckerGenerator = { generate: async () => ({ status: "failed", code: "management_generation_forbidden",
    usage: { inputTokens: 0, outputTokens: 0 }, model: "disabled" }) };
  let executor: CandidateExecutor = { execute: async () => ({ kind: "unavailable", detail: "management_execution_forbidden" }) };

  if (mode === "learn") {
    const connection = resolveConnectionSettings(ctx, run);
    if ("exitCode" in connection) return connection;

    const selected = connection.provider;
    const credential = runCredentialFor(ctx, selected.kind, selected.accountId);
    if ("exitCode" in credential) return credential;

    const permission = permissionFor(ctx.stdinIsTty ? "interactive" : "non_interactive", ctx, run);
    const provider = buildProvider({ providerId: selected.providerId, providerKind: selected.kind, model: selected.model,
      endpoint: selected.endpoint, apiKey: credential.apiKey, ...credential, ...reasoningSummaryOptions(selected), workspaceRoot: ctx.cwd, permission });
    if ("code" in provider) return { exitCode: EXIT_CODES.CONFIG, message: `${provider.code}: ${provider.detail}`,
      hint: "Review the selected check-learning provider configuration." } satisfies RunFailure;

    generator = createCheckerProviderGenerator({ provider, model: selected.model });
    executor = createApprovedCheckerExecutor({ permission, homeDir: ctx.homeDir, env: ctx.env });
  }

  return createExecutableCheckLearning({ boardRoot: methodBoardRoot(ctx.homeDir, ctx.env), generator, executor,
    collection: () => "enabled", now: ctx.now, owner: createCheckerProcessOwner(), assessCompatibility: checkAssessmentCompatibility });
}
