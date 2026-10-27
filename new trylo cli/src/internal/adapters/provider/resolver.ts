import type { ProviderCapabilities } from "./capabilities.js";
import { resolveContextWindow } from "../../compaction/context-window.js";
import { requireCapability, type CapabilityDenial } from "./capabilities.js";
import type { ProviderEntry, ProviderRegistry } from "./registry.js";
import { DEFAULT_PROVIDER_ID, requireProvider, type ProviderDenial } from "./registry.js";
import type { ProviderKind, ProvidersDocument } from "./providers-file.js";

/**
 * Turning a registry plus this run's overrides into *one* provider (D3).
 *
 * The whole point of this file is that there is no such thing as a partially
 * resolved provider. A caller gets one object whose endpoint, model, family and
 * capabilities were all read from the same entry and the same override set, or
 * it gets a refusal naming what is missing. The failure mode being designed
 * against is the obvious one: an id from one source, an endpoint from another
 * and capabilities from a third, which is how a run ends up talking to the
 * wrong host while reporting it is using the right provider.
 *
 * Precedence for `endpoint` and `model`, highest first:
 *
 * ```text
 * run override (--endpoint / --model) -> the declared entry -> the run's own settings
 * ```
 *
 * The last step is why the resolver takes the settings values rather than
 * reading them: with no declared provider in play, `endpoint` and `model` are
 * exactly what `run-settings.ts` resolved, and the object handed back is the
 * one the old path would have built. That is the zero-difference gate, and it
 * is a promise about the default path, not about the declared one.
 */

export type ResolvedProvider = {
  /** The id the run selected: a built-in one, or a declared one. */
  readonly providerId: string;
  /** The implementation family, i.e. which adapter builds it. */
  readonly kind: ProviderKind;
  readonly model: string;
  readonly endpoint: string;
  readonly capabilities: ProviderCapabilities;
  readonly builtin: boolean;
  /**
   * The declared context ceiling, when the entry declares one. Carried, not
   * applied: see the note in `resolverForBudget`. It is *not* a request to
   * start compacting.
   */
  readonly contextWindow?: number;
  /** The ledger account the entry binds to, when it names one. */
  readonly accountId?: string;
};

export type ResolutionFailure =
  | { readonly kind: "provider"; readonly denial: ProviderDenial }
  | { readonly kind: "capability"; readonly denial: CapabilityDenial }
  | { readonly kind: "endpoint"; readonly detail: string };

export type Resolution =
  | { readonly ok: true; readonly value: ResolvedProvider }
  | { readonly ok: false; readonly failure: ResolutionFailure };

export type ResolveInput = {
  readonly registry: ProviderRegistry;
  /** `--provider`, when the command carried one. */
  readonly requested?: string | undefined;
  /** The endpoint the run resolved from config/flags. */
  readonly endpoint: string;
  /** The model the run resolved from config/flags. */
  readonly model: string;
  /** `--endpoint`, when the command carried one; wins over everything. */
  readonly endpointOverride?: string | undefined;
  /** `--model`, when the command carried one; wins over everything. */
  readonly modelOverride?: string | undefined;
};

/** True when the family cannot be built without an endpoint. */
export function kindNeedsEndpoint(kind: ProviderKind): boolean {
  return kind === "openai-compatible" || kind === "openai-responses";
}

function resolvedOf(entry: ProviderEntry, input: ResolveInput): ResolvedProvider {
  const endpoint = input.endpointOverride ?? (entry.capabilities.endpoint.length > 0
    ? entry.capabilities.endpoint
    : input.endpoint);
  const model = input.modelOverride ?? (entry.model.length > 0 ? entry.model : input.model);
  return {
    providerId: entry.id,
    kind: entry.kind,
    model,
    endpoint,
    capabilities: entry.capabilities,
    builtin: entry.builtin,
    ...(entry.capabilities.contextWindow === undefined
      ? {}
      : { contextWindow: entry.capabilities.contextWindow }),
    ...(entry.accountId === undefined ? {} : { accountId: entry.accountId }),
  };
}

/**
 * Resolve, refusing rather than approximating.
 *
 * The endpoint check is the one place a missing value is a hard failure: an
 * OpenAI-compatible provider with nowhere to send a request cannot be built
 * into anything useful, and the existing wiring already treats "no endpoint" as
 * a configuration error rather than an empty string to be discovered later.
 */
export function resolveProvider(input: ResolveInput): Resolution {
  const id = input.requested ?? input.registry.selected ?? DEFAULT_PROVIDER_ID;
  const found = requireProvider(input.registry, id);
  if (!found.ok) {
    return { ok: false, failure: { kind: "provider", denial: found.denial } };
  }
  const value = resolvedOf(found.entry, input);
  if (kindNeedsEndpoint(value.kind) && value.endpoint.length === 0) {
    return {
      ok: false,
      failure: {
        kind: "endpoint",
        detail: `provider ${value.providerId} (${value.kind}) needs an endpoint; set \`endpoint\` in the declaration, in config, or pass --endpoint`,
      },
    };
  }
  return { ok: true, value };
}

/**
 * Resolve *and* demand a capability, in that order.
 *
 * The order matters: telling someone their provider cannot stream before
 * telling them it does not exist would be a strange sentence, and would hide
 * the typo behind a capability discussion.
 */
export function resolveRequiring(
  input: ResolveInput,
  capability: Parameters<typeof requireCapability>[2],
): Resolution {
  const resolved = resolveProvider(input);
  if (!resolved.ok) {
    return resolved;
  }
  const gate = requireCapability(resolved.value.providerId, resolved.value.capabilities, capability);
  if (!gate.ok) {
    return { ok: false, failure: { kind: "capability", denial: gate.denial } };
  }
  return resolved;
}

/**
 * The budget half of a resolved provider (PW-4).
 *
 * Diagnostics use the execution policy: the requested working window defaults
 * to 200K, and every declared capacity is a hard upper bound.
 */
export function resolverForBudget(
  resolved: ResolvedProvider,
  configuredCeiling: number | undefined,
  modelContextWindow?: number,
): { readonly declared?: number; readonly effective?: number; readonly overridden: boolean } {
  const declared = resolved.contextWindow;
  const effective = resolveContextWindow(configuredCeiling, declared, modelContextWindow);
  return {
    ...(declared === undefined ? {} : { declared }),
    effective,
    overridden: declared !== undefined && configuredCeiling !== undefined && declared !== configuredCeiling,
  };
}

/**
 * A new document with a different selection — the whole document, rewritten.
 *
 * `providers switch` is atomic in the only sense that matters for a file: it
 * produces the complete next state in one value, so the write either lands as
 * one document or not at all. Patching a single key inside a file that is also
 * being read by something else is how a half-old/half-new selection happens.
 */
export function withSelected(doc: ProvidersDocument, id: string): ProvidersDocument {
  return { version: doc.version, selected: id, providers: [...doc.providers] };
}
