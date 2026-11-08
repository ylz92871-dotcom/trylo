import type { RunCommandOptions } from "./args.js";
import type { CliContext } from "./context.js";
import { resolveConnectionSettings } from "./connection-settings.js";
import { credentialStateOf } from "./provider-credential.js";
import { isKeyedProviderKind } from "../../adapters/provider/providers-file.js";
import { readCliProviderRegistry, isDocumentFailure, providersFilePath } from "./providers-wiring.js";
import { createCliCredentialPortWithReport, credentialWarningTo } from "./credentials-wiring.js";

export type ConnectionState = "needs_connection" | "needs_credential" | "ready";

/** Safe before prepareRun: missing configuration or login must not lock the UI out. */
export function connectionStatus(ctx: CliContext, options: RunCommandOptions = { message: [], readStdin: false }) {
  const resolved = resolveConnectionSettings(ctx, options);
  if ("exitCode" in resolved) return { kind: "failed" as const, failure: resolved };

  const { provider } = resolved;
  const credential = credentialStateOf(ctx, provider.kind, provider.accountId);
  const kind: ConnectionState = provider.requestedBy === undefined && provider.kind.startsWith("fixture")
    ? "needs_connection"
    : credential.required && (!("loggedIn" in credential) || !credential.loggedIn) ? "needs_credential" : "ready";

  return { kind, ...resolved, credential, declarationPath: providersFilePath(ctx) };
}

/** Declared defaults are choices, not a remotely discovered model catalogue. */
export function listConnections(ctx: CliContext) {
  const registry = readCliProviderRegistry(ctx);
  if (isDocumentFailure(registry)) return { ok: false as const, failure: registry };

  const accounts = createCliCredentialPortWithReport(ctx, credentialWarningTo(ctx)).list();
  if (!accounts.ok) return { ok: false as const, failure: accounts };

  return {
    ok: true as const,
    selected: registry.selected,
    accounts: accounts.value,
    providers: registry.entries.map(entry => ({
      id: entry.id, kind: entry.kind, endpoint: entry.capabilities.endpoint, model: entry.model,
      models: entry.capabilities.models, manualModel: isKeyedProviderKind(entry.kind),
      ...(entry.capabilities.contextWindow === undefined ? {} : { contextWindow: entry.capabilities.contextWindow }),
      builtin: entry.builtin, ...(entry.accountId === undefined ? {} : { accountId: entry.accountId }),
    })),
  };
}
