import { contentHashOf } from "../../learning/control/hash.js";
import type { RunScaffold } from "./run-command.js";
import { CENTRAL_DEFAULT_OUTPUT_TOKENS, CENTRAL_MAX_OUTPUT_TOKENS } from "../../learning/central/runtime/generation.js";

/** Identity of the actual frozen host configuration. Endpoint/credential text
 * is never copied into a family label or result payload. */
export function centralLearningModelRef(input: Pick<RunScaffold, "providerId" | "providerKind" | "model" | "endpoint"
  | "reasoningEffort" | "reasoningSummary">): string {
  return `central-learning-model:${contentHashOf({ providerId: input.providerId, providerKind: input.providerKind,
    model: input.model, endpointHash: contentHashOf(input.endpoint), reasoningEffort: input.reasoningEffort ?? null,
    reasoningSummary: input.reasoningSummary ?? null })}`;
}

/** Actual generation parameters only. Prompt/total-fund ceilings and reasoning
 * display settings can change without changing the exhausted computation. */
export function centralLearningGenerationRef(input: Pick<RunScaffold,
  "providerId" | "providerKind" | "model" | "endpoint" | "reasoningEffort">, envelope: {
  readonly maxOutputTokens: number;
  readonly maxSelectableOutputTokens?: number;
}): string {
  const generation = { providerId: input.providerId, providerKind: input.providerKind, model: input.model, endpoint: input.endpoint,
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }) };
  // Preserve the exact legacy identity for its unchanged 8192/16384 policy.
  // Explicit policies also identify their actual selectable execution ceiling.
  const ceiling = envelope.maxSelectableOutputTokens === undefined
    || envelope.maxOutputTokens === CENTRAL_DEFAULT_OUTPUT_TOKENS && envelope.maxSelectableOutputTokens === CENTRAL_MAX_OUTPUT_TOKENS
    ? {} : { maxSelectableOutputTokens: envelope.maxSelectableOutputTokens };

  return `central-learning-generation:${contentHashOf({ modelRef: centralLearningModelRef(generation), maxOutputTokens: envelope.maxOutputTokens, ...ceiling })}`;
}

/** Remote resource identity follows the resolved connection, independently of
 * local operation limits, User policy and reasoning settings. */
export function centralLearningProviderConnectionRef(input: Pick<RunScaffold,
  "providerId" | "providerKind" | "model" | "endpoint" | "accountId">): string {
  return `central-learning-provider-connection:${contentHashOf({ providerId: input.providerId, providerKind: input.providerKind,
    model: input.model, endpointHash: contentHashOf(input.endpoint), accountId: input.accountId ?? null })}`;
}
