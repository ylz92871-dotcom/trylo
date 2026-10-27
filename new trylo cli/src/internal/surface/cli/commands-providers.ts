import { EXIT_CODES, type ExitCode } from "../../protocol/cli-stream.js";
import type { CapabilityKey } from "../../adapters/provider/capabilities.js";
import { declaredCapabilities, renderCapabilities } from "../../adapters/provider/capabilities.js";
import type { ProviderEntry, ProviderRegistry } from "../../adapters/provider/registry.js";
import { findProvider, registryOfDocument, requireProvider } from "../../adapters/provider/registry.js";
import { resolverForBudget } from "../../adapters/provider/resolver.js";
import { PROVIDERS_DOCUMENT_VERSION, type ProvidersDocument } from "../../adapters/provider/providers-file.js";
import type {
  ProvidersAddOptions,
  ProvidersConfigOptions,
  ProvidersEditOptions,
  ProvidersListOptions,
  ProvidersModelsOptions,
  ProvidersRemoveOptions,
  ProvidersSwitchOptions,
} from "./args-providers.js";
import type { CliContext } from "./context.js";
import { aligned } from "./humanize.js";
import {
  addDeclaredProvider,
  addFailureExit,
  documentFailureExit,
  documentFailureMessage,
  editDeclaredProvider,
  isDocumentFailure,
  PROVIDERS_FILE_NAME,
  providersFilePath,
  readCliProviderRegistry,
  removeDeclaredProvider,
  removeEditFailureExit,
  switchFailureExit,
  switchSelected,
} from "./providers-wiring.js";
import { currentAccountIdOf, credentialStateOf, refuseUnknownAccount, renderCredential, type CredentialState } from "./provider-credential.js";
import { resolveConnectionSettings } from "./connection-settings.js";
import type { CliSink } from "./render.js";

/**
 * The `providers` command family.
 *
 * Two rules decide every shape in this file.
 *
 * First, **an undeclared model list is reported as undeclared.** `providers
 * models openai-compatible` says it does not know, because asking the endpoint
 * would need a credential this command does not have and a network call a
 * read-only command must not make. Printing `[]` would read as "this provider
 * has no models", which is a different and false sentence.
 *
 * Second, **nothing here prints a secret, ever.** The command reports auth
 * *types* and whether a credential resolved; the value is not in this process's
 * output in any form, including `--json`.
 *
 * Every handler writes through the injected sink and returns an exit code, so
 * the same functions are exercised by in-process tests and by the real binary.
 */

export type ProvidersListEntry = {
  readonly id: string;
  readonly kind: string;
  readonly model: string;
  readonly builtin: boolean;
  readonly selected: boolean;
  readonly capabilities: ReadonlyArray<CapabilityKey>;
  readonly auth: string;
  readonly summary: string;
};

function listEntryOf(entry: ProviderEntry, selected: string | undefined): ProvidersListEntry {
  return {
    id: entry.id,
    kind: entry.kind,
    model: entry.model,
    builtin: entry.builtin,
    selected: selected === undefined ? entry.id === "fixture" : selected === entry.id,
    capabilities: declaredCapabilities(entry.capabilities),
    auth: entry.capabilities.auth,
    summary: renderCapabilities(entry.capabilities),
  };
}

/**
 * `adapters/provider/capabilities.ts` renders an absent capability as
 * `context=not-declared`, which is a machine's word for "nobody said". On a
 * list it reads as though something were broken, when the truth is only that
 * the provider never declared one — so the surface says what it means.
 */
function humanizeSummary(summary: string): string {
  return summary.replaceAll("=not-declared", "=-");
}

function renderList(entries: ReadonlyArray<ProvidersListEntry>): string {
  // The kind is dropped when it repeats the id, which it does for every
  // builtin: `fixture  fixture` reads like a mistake.
  const cells = entries.map((entry) => [
    entry.id,
    entry.kind === entry.id ? "" : entry.kind,
    entry.builtin ? "builtin" : "declared",
    humanizeSummary(entry.summary),
  ]);
  // The marker is not a column: it belongs against the id it marks, not
  // padded out to the width of a column nobody else fills.
  const body = aligned(cells);
  const lines = entries.map((entry, at) => `${entry.selected ? "*" : " "} ${body[at] ?? ""}`);
  return `${lines.join("\n")}\n`;
}

export function handleProvidersList(ctx: CliContext, options: ProvidersListOptions): ExitCode {
  const registry = readCliProviderRegistry(ctx);
  if (isDocumentFailure(registry)) {
    ctx.stderr(`${documentFailureMessage(registry)}\n`);
    return documentFailureExit(registry);
  }
  const entries = registry.entries.map((entry) => listEntryOf(entry, registry.selected));
  ctx.stdout(
    options.json
      ? `${JSON.stringify({ selected: registry.selected ?? "fixture", providers: entries })}\n`
      : renderList(entries),
  );
  return EXIT_CODES.OK;
}

export function handleProvidersModels(ctx: CliContext, options: ProvidersModelsOptions): ExitCode {
  const registry = readCliProviderRegistry(ctx);
  if (isDocumentFailure(registry)) {
    ctx.stderr(`${documentFailureMessage(registry)}\n`);
    return documentFailureExit(registry);
  }
  const found = requireProvider(registry, options.id);
  if (!found.ok) {
    ctx.stderr(`unknown provider ${options.id}; known providers: ${found.denial.known.join(", ")}\n`);
    return EXIT_CODES.USAGE;
  }
  const models = found.entry.capabilities.models;
  const declared = models.length > 0;
  const note = declared
    ? `${models.length} declared`
    : "not declared: this build does not ask the endpoint for its catalogue";
  if (options.json) {
    ctx.stdout(
      `${JSON.stringify({ id: found.entry.id, kind: found.entry.kind, declared, models, note })}\n`,
    );
    return EXIT_CODES.OK;
  }
  if (!declared) {
    ctx.stdout(`${found.entry.id}: ${note}\n`);
    return EXIT_CODES.OK;
  }
  ctx.stdout(`${models.map((model) => `${found.entry.id}  ${model}`).join("\n")}\n`);
  ctx.stdout(`(${note})\n`);
  return EXIT_CODES.OK;
}

export function handleProvidersSwitch(ctx: CliContext, options: ProvidersSwitchOptions): ExitCode {
  const result = switchSelected(ctx, { id: options.id });
  if (!result.ok) {
    const known = result.known === undefined ? "" : ` known providers: ${result.known.join(", ")}`;
    ctx.stderr(`${result.detail}.${known}\n`);
    return switchFailureExit(result);
  }
  ctx.stdout(`selected provider ${result.id}\n`);
  return EXIT_CODES.OK;
}

/**
 * Declare a provider: id, kind, endpoint, model, and the ledger account it
 * binds to.
 *
 * The binding is what makes a second `openai-compatible` host safe: with it, a
 * run sends *this* endpoint the key of *this* account instead of whatever the
 * family's current pointer happens to name. It is echoed back so the person can
 * see it took, and the next step is printed, because a declaration that is not
 * selected is not yet a provider a run will use.
 */
export function handleProvidersAdd(ctx: CliContext, options: ProvidersAddOptions): ExitCode {
  // `--account` pins the account the person named. Without it, the declaration
  // binds to whatever that family's current account is *right now* — the same
  // credential a run would have used, but written down, so that later switching
  // the family for a second host cannot silently re-point this one.
  const refused = refuseUnknownAccount(ctx, options.kind, options.account);
  if (refused !== undefined) {
    return refused;
  }
  const bound = options.account ?? currentAccountIdOf(ctx);
  const result = addDeclaredProvider(ctx, {
    id: options.id,
    kind: options.kind,
    endpoint: options.endpoint,
    model: options.model,
    ...(bound === undefined ? {} : { accountId: bound }),
    ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
  });
  if (!result.ok) {
    const known = result.known === undefined ? "" : ` known providers: ${result.known.join(", ")}`;
    ctx.stderr(`${result.detail}.${known}\n`);
    return addFailureExit(result);
  }
  ctx.stdout(`declared provider ${result.id} (${options.kind})\n`);
  ctx.stdout(
    bound === undefined
      ? "no account bound yet; `trylo login --provider openai-compatible --account <id>` first, then re-run with `--account <id>`\n"
      : options.account === undefined
        ? `bound to account ${bound} (the family's current account; pass --account <id> to pin a different one)\n`
        : `bound to account ${bound}\n`,
  );
  ctx.stdout(`next: trylo run --provider ${result.id} (or trylo providers switch ${result.id})\n`);
  return EXIT_CODES.OK;
}

/**
 * Delete a declaration. Refusing (unknown id, built-in id, broken file) happens
 * before the disk is touched, and removing the selected id clears the
 * selection with the fact stated — a `selected` pointing at nothing would send
 * the next run at a ghost.
 */
export function handleProvidersRemove(ctx: CliContext, options: ProvidersRemoveOptions): ExitCode {
  const result = removeDeclaredProvider(ctx, { id: options.id });
  if (!result.ok) {
    const known = result.known === undefined ? "" : ` known providers: ${result.known.join(", ")}`;
    ctx.stderr(`${result.detail}.${known}\n`);
    return removeEditFailureExit(result);
  }
  ctx.stdout(`removed provider ${result.id}\n`);
  if (result.clearedSelected) {
    ctx.stdout("no provider is selected now; `trylo providers switch <id>` selects one\n");
  }
  return EXIT_CODES.OK;
}

/**
 * Patch a declaration's endpoint, model and/or account binding.
 *
 * Only named fields move; the account binding survives an endpoint change
 * unless `--account` rebinds it, and the new binding is echoed so a key moving
 * hosts is always a visible sentence, never a side effect.
 */
export function handleProvidersEdit(ctx: CliContext, options: ProvidersEditOptions): ExitCode {
  // A missing entry falls through to the wiring's unknown_provider; only a
  // present entry gets its binding checked (the kind gate needs the entry).
  const entry = providerEntryFor(ctx, options.id);
  if (entry !== undefined) {
    const refused = refuseUnknownAccount(ctx, entry.kind, options.account);
    if (refused !== undefined) {
      return refused;
    }
  }
  const result = editDeclaredProvider(ctx, {
    id: options.id,
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.account === undefined ? {} : { account: options.account }),
    ...(options.contextWindow === undefined ? {} : { contextWindow: options.contextWindow }),
  });
  if (!result.ok) {
    const known = result.known === undefined ? "" : ` known providers: ${result.known.join(", ")}`;
    ctx.stderr(`${result.detail}.${known}\n`);
    return removeEditFailureExit(result);
  }
  ctx.stdout(`updated provider ${result.id} (${result.changed.join(", ")})\n`);
  if (result.accountId !== undefined) {
    ctx.stdout(`bound to account ${result.accountId}\n`);
  }
  return EXIT_CODES.OK;
}

/**
 * What a run would use, resolved the way a run resolves it.
 *
 * The config layer is read so the endpoint and model shown are the ones a run
 * would actually send: a declaration that supplies an endpoint and a config
 * file that supplies a different one is exactly the disagreement this command
 * exists to make visible.
 */
export function handleProvidersConfig(ctx: CliContext, options: ProvidersConfigOptions): ExitCode {
  const registry = readCliProviderRegistry(ctx);
  if (isDocumentFailure(registry)) {
    ctx.stderr(`${documentFailureMessage(registry)}\n`);
    return documentFailureExit(registry);
  }
  const resolved = resolveConnectionSettings(ctx, { message: [], readStdin: false, ...(options.id === undefined ? {} : { provider: options.id }) });
  if ("exitCode" in resolved) {
    ctx.stderr(`${resolved.message}\n`);
    return resolved.exitCode;
  }
  const { provider: value, settings } = resolved;
  const payload = {
    id: value.providerId,
    kind: value.kind,
    endpoint: value.endpoint,
    model: value.model,
    auth: value.capabilities.auth,
    capabilities: declaredCapabilities(value.capabilities),
    ...(value.contextWindow === undefined ? {} : { contextWindow: value.contextWindow }),
    origin: registry.entries.find(entry => entry.id === value.providerId)?.builtin === true ? "builtin" : PROVIDERS_FILE_NAME,
    credential: credentialStateOf(ctx, value.kind, value.accountId),
    budget: resolverForBudget({ ...value, builtin: registry.entries.find(entry => entry.id === value.providerId)?.builtin === true }, settings.contextTokenLimit, settings.modelContextWindow),
  };
  ctx.stdout(options.json ? `${JSON.stringify(payload)}\n` : renderConfig(payload));
  return EXIT_CODES.OK;
}

function renderBudget(budget: ReturnType<typeof resolverForBudget>): string {
  const declared = budget.declared === undefined ? "not-declared" : `${budget.declared}`;
  const effective = budget.effective === undefined ? "none (compaction off)" : `${budget.effective}`;
  return `budget   declared=${declared} effective=${effective}${budget.overridden ? " (ceiling wins)" : ""}`;
}

type ConfigPayload = {
  readonly id: string;
  readonly kind: string;
  readonly endpoint: string;
  readonly model: string;
  readonly auth: string;
  readonly capabilities: ReadonlyArray<CapabilityKey>;
  readonly contextWindow?: number;
  readonly origin: string;
};

function renderConfig(
  payload: ConfigPayload & {
    readonly credential: CredentialState;
    readonly budget: ReturnType<typeof resolverForBudget>;
  },
): string {
  const lines = [
    `id       ${payload.id}`,
    `kind     ${payload.kind}`,
    `endpoint ${payload.endpoint.length === 0 ? "(none)" : payload.endpoint}`,
    `model    ${payload.model}`,
    `auth     ${payload.auth}`,
    `caps     ${payload.capabilities.join("|") || "none"}`,
    `context  ${payload.contextWindow ?? "not-declared"}`,
    `from     ${payload.origin}`,
    renderCredential(payload.credential),
    renderBudget(payload.budget),
  ];
  return `${lines.join("\n")}\n`;
}

/** Registry for tests and for the doctor's provider row. */
export function declaredRegistryOf(doc: ProvidersDocument): ProviderRegistry {
  return registryOfDocument(doc);
}

export function providerEntryFor(ctx: CliContext, id: string): ProviderEntry | undefined {
  const registry = readCliProviderRegistry(ctx);
  if (isDocumentFailure(registry)) {
    return undefined;
  }
  return findProvider(registry, id);
}

export function providersFileHint(ctx: CliContext): string {
  return providersFilePath(ctx);
}

export const PROVIDERS_DOC_VERSION = PROVIDERS_DOCUMENT_VERSION;

export type { CliSink };
