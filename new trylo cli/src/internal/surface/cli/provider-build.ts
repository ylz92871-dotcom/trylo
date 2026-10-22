import type { ProviderPort } from "../../ports/provider.js";
import { createFixtureProvider, createMemoryFixtureProvider, DEFAULT_FIXTURE_SCRIPT, SUBAGENT_FIXTURE_SCRIPT, WRITE_FIXTURE_SCRIPT } from "../../adapters/provider/fixture.js";
import { createOpenAiCompatibleProvider } from "../../adapters/provider/openai-compatible.js";
import { createResponsesProvider } from "../../adapters/provider/responses.js";
import { isKeyedProviderKind, isProviderKind, type ProviderKind } from "../../adapters/provider/providers-file.js";
import type { WarmRegistry } from "../../adapters/provider/warm.js";
import type { ProviderCapabilities } from "../../adapters/provider/capabilities.js";
import type { WiringFailure, WiringInput } from "./wiring.js";
import { withImageReferences } from "../../adapters/media/image-reference-provider.js";
import { workspaceIdentity } from "./wiring-catalog.js";
import type { ImageReferenceAccess } from "../../ports/image-reference-access.js";

/**
 * Which adapter a run builds, and whether it may reuse one.
 *
 * Split out of `wiring.ts` because that file composes ports and this one
 * constructs one object; the split is also what keeps both under the file-size
 * discipline without moving a rule anywhere else.
 *
 * The family, not the id, decides the adapter. A declared provider may be called
 * anything, and what builds it is the family its declaration names. With no
 * kind supplied — every caller that predates declared providers — the id *is*
 * the kind, because the shipped ids are a subset of the families; that is what
 * makes the default path identical rather than merely similar. A kind with no
 * built-in entry (such as `openai-responses`) only ever arrives via a
 * declaration, so an undeclared `--provider openai-responses` is refused at
 * resolution, never half-built here.
 */

export function kindOf(input: WiringInput): ProviderKind | undefined {
  if (input.providerKind !== undefined) {
    return input.providerKind;
  }
  return isProviderKind(input.providerId) ? input.providerId : undefined;
}

/** A declared Responses reasoning channel opts in to the provider's public summary. */
export function reasoningSummaryOptions(provider: {
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities;
}): { readonly reasoningSummary?: "auto" } {
  return provider.kind === "openai-responses" && provider.capabilities.reasoning
    ? { reasoningSummary: "auto" }
    : {};
}

/**
 * Whether the family can be built at all, asked *before* anything is cached.
 *
 * The check is separate from construction because a warm entry is the wrong
 * thing to create around a failure: caching "this provider has no endpoint"
 * would hand the next turn an object that is not a provider, and the refusal has
 * to reach the person on the turn that asked.
 */
function preflight(input: WiringInput, kind: ProviderKind): WiringFailure | undefined {
  if (input.reasoningEffort !== undefined && kind !== "openai-compatible" && kind !== "openai-responses") return {
    code: "unsupported_reasoning_effort", detail: "--reasoning-effort requires a Chat-compatible or Responses provider; this provider cannot apply it",
  };
  if (isKeyedProviderKind(kind) && input.endpoint.length === 0) {
    return {
      code: "missing_endpoint",
      detail:
        `provider ${kind} needs an endpoint; set \`endpoint\` in config or --endpoint`,
    };
  }
  return undefined;
}

function constructTransport(input: WiringInput, kind: ProviderKind): ProviderPort {
  if (input.providerId === "fixture-memory" && kind === "fixture") {
    return createMemoryFixtureProvider();
  }
  if (kind === "fixture") {
    return createFixtureProvider(DEFAULT_FIXTURE_SCRIPT);
  }
  if (kind === "fixture-write") {
    return createFixtureProvider(WRITE_FIXTURE_SCRIPT);
  }
  if (kind === "fixture-subagent") {
    return createFixtureProvider(SUBAGENT_FIXTURE_SCRIPT);
  }
  if (kind === "openai-responses") {
    return createResponsesProvider({
      endpoint: input.endpoint,
      model: input.model,
      ...(input.reasoningSummary === undefined ? {} : { reasoningSummary: input.reasoningSummary }),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
      ...(input.tokenManager === undefined ? {} : { tokenManager: input.tokenManager }),
    });
  }
  return createOpenAiCompatibleProvider({
    endpoint: input.endpoint,
    model: input.model,
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    ...(input.tokenManager === undefined ? {} : { tokenManager: input.tokenManager }),
  });
}

function construct(input: WiringInput, kind: ProviderKind): ProviderPort {
  return withImageReferences(constructTransport(input, kind), input.workspaceRoot);
}

/**
 * The provider for this turn, through the warm layer when the surface has one.
 *
 * `trylo run` builds once and has nothing to reuse, so it passes no registry and
 * gets exactly the object it always got. A REPL or a TUI lends one across turns,
 * and the second turn is served the provider the first one built — which is the
 * point of the layer, and is measured rather than asserted (`WarmStats.builds`).
 *
 * The cache key carries the account id, so a session built for one credential is
 * never handed to another; an endpoint or model change is a different key by
 * construction, so what gets reused is the provider *this run resolved*, not
 * whatever happened to be lying around.
 */
export function buildProvider(input: WiringInput, images?: ImageReferenceAccess): ProviderPort | WiringFailure {
  const kind = kindOf(input);
  if (kind === undefined) {
    return {
      code: "unknown_provider",
      detail: `no adapter for provider ${input.providerId}; \`trylo providers list\` shows the known ones`,
    };
  }
  const refused = preflight(input, kind);
  if (refused !== undefined) {
    return refused;
  }
  const registry: WarmRegistry | undefined = input.warm;
  const create = () => images === undefined ? construct(input, kind) : constructTransport(input, kind);
  if (registry === undefined) {
    const provider = create();
    return images === undefined ? provider : withImageReferences(provider, input.workspaceRoot, images);
  }
  const acquired = registry.acquire(
    {
      providerId: input.providerId,
      kind,
      model: input.model,
      endpoint: input.endpoint,
      accountId: input.accountId ?? "",
      workspaceId: workspaceIdentity(input.workspaceRoot),
      ...(images === undefined ? {} : { imageReferenceScope: "transport" as const }),
      ...(input.reasoningSummary === undefined ? {} : { reasoningSummary: input.reasoningSummary }),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    },
    create,
  );
  return images === undefined ? acquired.provider : withImageReferences(acquired.provider, input.workspaceRoot, images);
}
