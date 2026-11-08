import type { SystemPromptDirective, ReasoningEffort } from "../../ports/provider.js";
import type { JsonObject } from "../../protocol/envelope.js";

/** Resolved request facts are threaded unchanged through the normal host. An
 * absent field preserves the existing request and provider behavior. */
export type ResolvedRequestOptions = {
  readonly reasoningEffort?: ReasoningEffort;
  readonly systemPrompt?: SystemPromptDirective;
  readonly systemPromptAppend?: string;
  readonly responseSchema?: JsonObject;
  readonly fallbackModel?: string;
};
