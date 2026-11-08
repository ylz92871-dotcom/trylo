import type { ProviderPort } from "../../ports/provider.js";
import type { PermissionPort } from "../../ports/permission.js";
import { withToolLearningFunding } from "../../learning/agent/subsystems/tool/adapters/evolution/index.js";
import type { createToolLearningFunding } from "../../learning/agent/subsystems/tool/runtime/index.js";
import { EXIT_CODES } from "../../protocol/cli-stream.js";
import type { RunCommandOptions } from "./args.js";
import type { CliContext } from "./context.js";
import type { RunFailure } from "./run-failure.js";
import { resolveConnectionSettings } from "./connection-settings.js";
import { runCredentialFor } from "./provider-selection.js";
import { buildProvider, reasoningSummaryOptions } from "./provider-build.js";

/** Already isolated raw single-request transport from the frozen normal host.
 * This port carries no reservation guard: tool funding wraps it exactly once. */
export type FrozenToolEvolutionModel = { readonly provider: ProviderPort; readonly model: string;
  /** Explicit host/provider generation allocation, not a private worker default. */
  readonly maxOutputTokens?: number };

export function openToolEvolutionProvider(ctx: CliContext, run: RunCommandOptions, options: {
  readonly permission: PermissionPort;
  readonly funding?: ReturnType<typeof createToolLearningFunding>;
  readonly frozenModel?: FrozenToolEvolutionModel;
}): FrozenToolEvolutionModel | RunFailure {
  let selected: FrozenToolEvolutionModel;

  if (options.frozenModel !== undefined) {
    selected = { ...options.frozenModel };
  } else {
    const connection = resolveConnectionSettings(ctx, run);
    if ("exitCode" in connection) return connection;

    const selection = connection.provider, credential = runCredentialFor(ctx, selection.kind, selection.accountId);
    if ("exitCode" in credential) return credential;

    const provider = buildProvider({ providerId: selection.providerId, providerKind: selection.kind,
      endpoint: selection.endpoint, model: selection.model, apiKey: credential.apiKey, ...credential,
      workspaceRoot: ctx.cwd, permission: options.permission, ...reasoningSummaryOptions(selection),
      ...(run.reasoningEffort === undefined ? {} : { reasoningEffort: run.reasoningEffort }),
      ...(options.funding === undefined ? {} : { requestAttemptPolicy: "single_request" }) });
    if ("code" in provider) return { exitCode: EXIT_CODES.CONFIG, message: `${provider.code}: ${provider.detail}`,
      hint: "Review the selected tool-learning provider settings." };

    selected = { provider, model: selection.model };
  }

  return { ...selected, provider: options.funding === undefined ? selected.provider
    : withToolLearningFunding(selected.provider, { funding: options.funding, newId: () => ctx.newId("tool-learning-call") }) };
}
