import type { CliContext } from "./context.js";
import type { CentralRuntimeConfiguration } from "./central-runtime-configuration.js";
import { resolveConnectionSettings } from "./connection-settings.js";
import { runCredentialFor } from "./provider-selection.js";
import { buildProvider, reasoningSummaryOptions } from "./provider-build.js";
import { contentHashOf } from "../../learning/control/hash.js";
import type { SkillDailyConnection } from "./skill-daily-provider.js";

/** Independent transport, empty inference context, original provider/credential ownership and no execution tools. */
export function centralRuntimeProvider(ctx: CliContext, configuration: CentralRuntimeConfiguration) {
  const connection = resolveConnectionSettings(ctx, { message: [], readStdin: false,
    provider: configuration.providerId, model: configuration.model,
    ...(configuration.endpoint === undefined ? {} : { endpoint: configuration.endpoint }) });
  if ("exitCode" in connection) return { ok: false as const, reason: "runtime_provider_configuration_unavailable" };

  const selected = connection.provider;
  if (contentHashOf(selected.endpoint) !== configuration.endpointHash) {
    return { ok: false as const, reason: "runtime_provider_reference_changed" };
  }

  const credential = runCredentialFor(ctx, selected.kind, selected.accountId);
  if ("exitCode" in credential) return { ok: false as const, reason: "runtime_provider_credential_unavailable" };

  // The declaration may omit an account while the original resolver selects an environment account.
  // Compare the same resolved identity that prepareRun actually persisted, never the optional declaration field.
  if (credential.accountId !== configuration.accountId) return { ok: false as const, reason: "runtime_provider_reference_changed" };

  const provider = buildProvider({ providerId: selected.providerId, providerKind: selected.kind, model: configuration.model,
    endpoint: selected.endpoint, apiKey: credential.apiKey, workspaceRoot: ctx.cwd, requestAttemptPolicy: "single_request",
    ...reasoningSummaryOptions(selected), ...(configuration.reasoningEffort === undefined ? {} : { reasoningEffort: configuration.reasoningEffort }),
    ...(credential.tokenManager === undefined ? {} : { tokenManager: credential.tokenManager }),
    ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }) });
  if ("code" in provider) return { ok: false as const, reason: "runtime_provider_unavailable" };

  const facts: SkillDailyConnection = { provider, providerId: selected.providerId, providerKind: selected.kind,
    model: configuration.model, endpoint: selected.endpoint, apiKey: credential.apiKey, permissionChoice: {},
    ...(configuration.reasoningEffort === undefined ? {} : { reasoningEffort: configuration.reasoningEffort }),
    ...(credential.tokenManager === undefined ? {} : { tokenManager: credential.tokenManager }),
    ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }) };

  return { ok: true as const, provider, model: configuration.model, providerId: selected.providerId, connection: facts,
    capabilities: selected.capabilities,
    secrets: credential.apiKey === undefined ? [] : [credential.apiKey] };
}
