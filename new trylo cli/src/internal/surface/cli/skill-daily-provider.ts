import type { ProviderPort } from "../../ports/provider.js";
import type { CliContext } from "./context.js";
import type { RunScaffold } from "./run-command.js";
import type { RunCommandOptions } from "./args.js";
import type { PermissionChoice } from "./permission-plan.js";
import { buildProvider } from "./provider-build.js";
import { resolveConnectionSettings } from "./connection-settings.js";
import { runCredentialFor } from "./provider-selection.js";
import { permissionFor } from "./permission-for-run.js";

export type SkillDailyConnection = Pick<RunScaffold, "providerId" | "providerKind" | "model" | "endpoint" | "apiKey" | "tokenManager" | "accountId" | "reasoningEffort"> & {
  readonly provider: ProviderPort;
  readonly permissionChoice: PermissionChoice;
  readonly shellIsolation?: RunCommandOptions["shellIsolation"];
};

export type SkillDailyExecutionOptions = Pick<RunCommandOptions, "shellIsolation">;

/** Reuse the selected runtime provider and credential owner; never print configuration secrets. */
export function skillDailyConnection(ctx: CliContext, scaffold?: RunScaffold, choice: PermissionChoice = {}, providerGuard?: (provider: ProviderPort) => ProviderPort,
  runtime: SkillDailyExecutionOptions = {}): SkillDailyConnection {
  const run: RunCommandOptions = { message: [], readStdin: false };
  const facts = scaffold ?? (() => {
    const connection = resolveConnectionSettings(ctx, run);
    if ("exitCode" in connection) throw new Error("skill_provider_configuration_unavailable");

    const selected = connection.provider;
    const credentials = runCredentialFor(ctx, selected.kind, selected.accountId);
    if ("exitCode" in credentials) throw new Error("skill_provider_credential_unavailable");

    return { providerId: selected.providerId, providerKind: selected.kind, model: selected.model, endpoint: selected.endpoint,
      apiKey: credentials.apiKey, ...credentials };
  })();
  const provider = buildProvider({ providerId: facts.providerId, providerKind: facts.providerKind, model: facts.model, endpoint: facts.endpoint,
    apiKey: facts.apiKey, ...(facts.tokenManager === undefined ? {} : { tokenManager: facts.tokenManager }),
    ...(facts.accountId === undefined ? {} : { accountId: facts.accountId }),
    ...(providerGuard === undefined ? {} : { providerGuard }),
    workspaceRoot: ctx.cwd, permission: permissionFor("non_interactive", ctx, choice, ctx.cwd) });
  if ("code" in provider) throw new Error("skill_provider_configuration_unavailable");

  const shellIsolation = scaffold?.shellIsolation ?? runtime.shellIsolation;

  return { providerId: facts.providerId, providerKind: facts.providerKind, model: facts.model, endpoint: facts.endpoint, apiKey: facts.apiKey,
    ...(shellIsolation === undefined ? {} : { shellIsolation }),
    ...(facts.tokenManager === undefined ? {} : { tokenManager: facts.tokenManager }),
    ...(facts.accountId === undefined ? {} : { accountId: facts.accountId }),
    ...("reasoningEffort" in facts && facts.reasoningEffort !== undefined ? { reasoningEffort: facts.reasoningEffort } : {}),
    provider, permissionChoice: choice };
}
