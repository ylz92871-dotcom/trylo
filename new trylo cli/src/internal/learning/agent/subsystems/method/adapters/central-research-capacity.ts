import type { ProviderMessage, ProviderPort } from "../../../../../ports/provider.js";

/** One research segment shares a deadline across all its paid calls. The
 * existing Board permits a ten-minute lease; keep a minute for settlement and
 * checkpointing after the provider wait ends. This is not a spending grant. */
export const METHOD_RESEARCH_TIMING = Object.freeze({ timeoutMs: 540000, claimLeaseMs: 600000 });

/** The original operation and grant own capacity. Count the entire outgoing
 * prompt before offering its remaining generation space, including native
 * provider overhead when declared. No lightweight experience-review ceiling
 * applies to centrally commissioned research. */
export function prepareMethodResearchEnvelope(input: { readonly messages: readonly ProviderMessage[];
  readonly provider: ProviderPort; readonly tokens: number; readonly maxPromptChars: number; readonly contextWindow?: number }) {
  const prompt = input.messages.map(message => message.content).join("");
  const overhead = input.provider.continuation?.estimateOverheadTokens?.(input.messages) ?? 0;
  if (!Number.isSafeInteger(overhead) || overhead < 0) return undefined;

  const inputTokens = new TextEncoder().encode(prompt).length + 256 + overhead;

  if (input.contextWindow !== undefined && (!Number.isSafeInteger(input.contextWindow) || input.contextWindow < 1)) return undefined;

  const maxOutputTokens = Math.min(input.tokens, input.contextWindow ?? input.tokens) - inputTokens;
  if (prompt.length > input.maxPromptChars || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 256) return undefined;

  return { maxTokens: inputTokens + maxOutputTokens, maxOutputTokens };
}
