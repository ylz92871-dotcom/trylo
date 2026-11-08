import type { CliContext } from "./context.js";
import { resolveConnectionSettings } from "./connection-settings.js";
import { runCredentialFor } from "./provider-selection.js";
import { buildProvider, reasoningSummaryOptions } from "./provider-build.js";

/** Same provider/credential owners as ordinary work, with no task, tool or permission composition. */
export function learningProviderFor(ctx: CliContext) {
  const connection = resolveConnectionSettings(ctx, { message: [], readStdin: false });
  if ("exitCode" in connection) return { ok: false as const, reason: "learning_provider_configuration_unavailable" };

  const selected = connection.provider;
  const credential = runCredentialFor(ctx, selected.kind, selected.accountId);
  if ("exitCode" in credential) return { ok: false as const, reason: "learning_provider_credential_unavailable" };

  const provider = buildProvider({ providerId: selected.providerId, providerKind: selected.kind, model: selected.model,
    endpoint: selected.endpoint, apiKey: credential.apiKey, workspaceRoot: ctx.cwd, ...reasoningSummaryOptions(selected),
    ...(credential.tokenManager === undefined ? {} : { tokenManager: credential.tokenManager }),
    ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }) });

  return "code" in provider ? { ok: false as const, reason: "learning_provider_configuration_unavailable" }
    : { ok: true as const, provider, model: selected.model, providerId: selected.providerId };
}
