import { EXIT_CODES } from "../../protocol/cli-stream.js";
import type { TokenManagerLike } from "../../adapters/provider/openai-compatible.js";
import type { ProviderCapabilities } from "../../adapters/provider/capabilities.js";
import type { ProviderKind } from "../../adapters/provider/providers-file.js";
import { isKeyedProviderKind } from "../../adapters/provider/providers-file.js";
import { resolveProvider } from "../../adapters/provider/resolver.js";
import type { CliContext } from "./context.js";
import {
  createCliCredentialPortWithReport,
  credentialWarningTo,
  resolveNamedProviderCredential,
  resolveProviderCredential,
} from "./credentials-wiring.js";
import type { RunCommandOptions } from "./args.js";
import {
  documentFailureExit,
  documentFailureMessage,
  isDocumentFailure,
  readCliProviderRegistry,
} from "./providers-wiring.js";
import { fail, type RunFailure } from "./run-failure.js";

/**
 * Which provider a run will use, and whose credential it will use.
 *
 * This file exists because the answer used to be one string. It is now four
 * facts — an id, a family, an endpoint and a model — and they have to be
 * decided together: a run that read the id from one source and the endpoint
 * from another would be the half-old/half-new provider D3 forbids.
 *
 * Precedence, highest first:
 *
 * ```text
 * --provider  ->  providers.json `selected`  ->  config `provider`  ->  fixture
 * ```
 *
 * `--endpoint` and `--model` still win over everything, because an override a
 * person typed on this command is the most specific thing this process knows.
 *
 * The zero-difference gate is the middle of that list. With no declared
 * providers the second source is absent, the third is whatever it always was
 * and the fourth is what every run got before any of this existed — so the
 * resolved object is the one the old path built, field for field.
 */

export type RunProvider = {
  /** The selected id: a shipped one, or one the person declared. */
  readonly providerId: string;
  /** The family, i.e. which adapter is built. */
  readonly kind: ProviderKind;
  readonly model: string;
  readonly endpoint: string;
  readonly capabilities: ProviderCapabilities;
  /** Declared, carried — never applied as a compaction ceiling (see resolver). */
  readonly contextWindow?: number;
  /** The ledger account the selected declaration binds to, when it names one. */
  readonly accountId?: string;
  /**
   * Where the choice came from. Absent means nothing anywhere named a provider
   * and the built-in default was used — the one case where "you are talking to
   * the offline fixture" is a fact the person probably does not know.
   */
  readonly requestedBy?: "flag" | "selected" | "config";
};

export type RunProviderQuery = {
  readonly flagProvider?: string | undefined;
  /** The config value, only when the config actually carried one. */
  readonly configuredProvider?: string | undefined;
  readonly endpoint: string;
  readonly model: string;
  readonly flagEndpoint?: string | undefined;
  readonly flagModel?: string | undefined;
  /** Explicit paired project choice; it cannot select or rebind a provider. */
  readonly projectModel?: { readonly providerId: string; readonly model: string };
};

function isRunFailure(value: RunProvider | RunFailure): value is RunFailure {
  return !("providerId" in value);
}

/**
 * The config value for `provider`, only when a *layer* carried one.
 *
 * The packaged default always fills this key with `"fixture"`, and that is not a
 * choice anyone made: treating it as "the person configured a provider" would
 * suppress the one warning a first-run user needs (that they are about to read a
 * fixed sentence as a model's answer). Only `system`/`user`/`project` count.
 */
function configuredProviderOf(
  resolved: Readonly<Record<string, { readonly value: unknown; readonly layer?: unknown }>>,
): string | undefined {
  const entry = resolved["provider"];
  if (typeof entry?.value !== "string") {
    return undefined;
  }
  const layer = entry.layer;
  return layer === "packaged_default" ? undefined : entry.value;
}

export type RunProviderQueryInput = {
  /** The merged config, before defaults: it is what tells "configured" from absent. */
  readonly resolved: Readonly<Record<string, { readonly value: unknown; readonly layer?: unknown }>>;
  readonly options: RunCommandOptions;
  readonly endpoint: string;
  readonly model: string;
};

/** Both winning values must be project-owned; never combine layers into an opt-in. */
function projectModelOf(resolved: RunProviderQueryInput["resolved"]): RunProviderQuery["projectModel"] {
  const provider = resolved["provider"], model = resolved["model"];
  return provider?.layer === "project" && model?.layer === "project"
    && typeof provider.value === "string" && provider.value.trim().length > 0
    && typeof model.value === "string" && model.value.trim().length > 0
    ? { providerId: provider.value, model: model.value } : undefined;
}

/**
 * The provider for a run prepared from argv plus merged config.
 *
 * The query object exists because "was `provider` in the config?" and "what is
 * the provider?" are different questions, and only the first one decides whether
 * a stored selection is overridden. Collapsing them would make `providers
 * switch` silently useless on anyone who has ever written a config file.
 */
export function selectForRun(ctx: CliContext, input: RunProviderQueryInput): RunProvider | RunFailure {
  const configured = configuredProviderOf(input.resolved);
  const projectModel = projectModelOf(input.resolved);

  return selectRunProvider(ctx, {
    ...(input.options.provider === undefined ? {} : { flagProvider: input.options.provider }),
    ...(configured === undefined ? {} : { configuredProvider: configured }),
    endpoint: input.endpoint,
    model: input.model,
    ...(input.options.endpoint === undefined ? {} : { flagEndpoint: input.options.endpoint }),
    ...(input.options.model === undefined ? {} : { flagModel: input.options.model }),
    ...(projectModel === undefined ? {} : { projectModel }),
  });
}

export function selectRunProvider(ctx: CliContext, query: RunProviderQuery): RunProvider | RunFailure {
  const registry = readCliProviderRegistry(ctx);
  if (isDocumentFailure(registry)) {
    return fail(
      documentFailureExit(registry),
      documentFailureMessage(registry),
      "fix or remove that file; a run never selects a provider from a file that cannot be trusted",
    );
  }

  const requested = query.flagProvider ?? registry.selected ?? query.configuredProvider;
  const requestedBy =
    query.flagProvider !== undefined
      ? ("flag" as const)
      : registry.selected !== undefined
        ? ("selected" as const)
        : query.configuredProvider !== undefined
          ? ("config" as const)
          : undefined;
  const modelOverride = query.flagModel ?? (query.projectModel?.providerId === requested ? query.projectModel?.model : undefined);
  const resolved = resolveProvider({
    registry,
    ...(requested === undefined ? {} : { requested }),
    endpoint: query.endpoint,
    model: query.model,
    ...(query.flagEndpoint === undefined ? {} : { endpointOverride: query.flagEndpoint }),
    ...(modelOverride === undefined ? {} : { modelOverride }),
  });
  if (!resolved.ok) {
    const failure = resolved.failure;
    if (failure.kind === "endpoint") {
      return fail(EXIT_CODES.CONFIG, failure.detail, "set `endpoint` in config, in the declaration, or pass --endpoint");
    }

    if (failure.kind === "provider") {
      return fail(
        EXIT_CODES.USAGE,
        `unknown provider ${failure.denial.id}; known providers: ${failure.denial.known.join(", ")}`,
        "`trylo run --provider <id>` uses one directly; `trylo providers list` shows them, `trylo providers switch <id>` selects one",
      );
    }

    return fail(
      EXIT_CODES.CONFIG,
      `${failure.denial.providerId} does not declare ${failure.denial.capability}`,
      "pick a provider that declares it, or declare the capability for your own endpoint",
    );
  }

  return {
    providerId: resolved.value.providerId,
    kind: resolved.value.kind,
    model: resolved.value.model,
    endpoint: resolved.value.endpoint,
    capabilities: resolved.value.capabilities,
    ...(resolved.value.contextWindow === undefined ? {} : { contextWindow: resolved.value.contextWindow }),
    ...(resolved.value.accountId === undefined ? {} : { accountId: resolved.value.accountId }),
    ...(requestedBy === undefined ? {} : { requestedBy }),
  };
}

export type RunCredential = {
  readonly apiKey?: string;
  readonly tokenManager?: TokenManagerLike;
  readonly accountId?: string;
};

/**
 * The credential a run uses, asked for by *family*.
 *
 * The ledger holds credentials per provider family (`openai-compatible`), not
 * per declared endpoint: a person who declares three OpenAI-compatible hosts has
 * one key per account, and the account is the thing `auth switch` points at.
 * Asking by the declared id would resolve nothing for every id they invented,
 * and "nothing resolved" reads exactly like "not logged in", which is why the
 * family is what travels. The Responses wire shares the keyed family
 * (WP18.2): one account, one key, whichever wire the declaration names.
 *
 * Only a keyed family consults the ledger at all, so a fixture run stays
 * hermetic even when the ledger file is damaged — the doctor is where a damaged
 * ledger is reported.
 */
export function runCredentialFor(
  ctx: CliContext,
  kind: ProviderKind,
  accountId?: string,
): RunCredential | RunFailure {
  if (!isKeyedProviderKind(kind)) {
    return {};
  }

  const port = createCliCredentialPortWithReport(ctx, credentialWarningTo(ctx));
  const resolved =
    accountId === undefined
      ? resolveProviderCredential(port, "openai-compatible")
      : resolveNamedProviderCredential(port, { providerId: "openai-compatible", accountId });
  if (!resolved.ok) {
    // A binding to an account the ledger never held is a broken declaration,
    // not a broken credential: the fix lives in providers.json, so this is
    // CONFIG (52) pointing there, never AUTH (41) pointing at the ledger.
    if (accountId !== undefined && resolved.code === "unknown_account") {
      return fail(
        EXIT_CODES.CONFIG,
        `provider declaration binds unknown account ${accountId}; fix it in providers.json`,
        "`trylo providers edit <id> --account <id>` rebinds it; `trylo auth list` shows the stored accounts",
      );
    }
    return fail(
      EXIT_CODES.AUTH,
      `cannot read the credential ledger: ${resolved.code}: ${resolved.detail}`,
      "inspect the credentials ledger; a run never authenticates from a ledger that cannot be proven intact",
    );
  }

  return {
    ...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
    ...(resolved.tokenManager !== undefined ? { tokenManager: resolved.tokenManager } : {}),
    ...(resolved.accountId !== undefined ? { accountId: resolved.accountId } : {}),
  };
}

export function hasRunFailure(value: RunProvider | RunFailure): value is RunFailure {
  return isRunFailure(value);
}

/**
 * What a first-run user sees when a run is about to be answered by the offline
 * fixture because nothing anywhere named a provider — the fallback this file
 * decides, announced in the user's own words.
 *
 * One copy-pasteable path, in the order it has to be run, and deliberately on
 * stderr: the turn still happens, so stdout stays the turn's own output and a
 * `stream-json` consumer keeps parsing it. Without this, the fixture's fixed
 * sentence is the first thing a new user ever sees from `trylo run`, and it
 * reads exactly like a model's answer.
 */
export const FIXTURE_FIRST_RUN_GUIDANCE: ReadonlyArray<string> = [
  "warning fixture_provider: no provider is configured, so this run answers from the offline fixture, not a model",
  "  next: trylo login --provider openai-compatible --account <account id>",
  "        trylo providers add <id> --kind openai-compatible --endpoint <url> --model <model id>",
  "        trylo providers switch <id>",
  "        trylo doctor",
];
