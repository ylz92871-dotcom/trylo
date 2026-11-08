import type { ProviderRequest } from "../../ports/provider.js";
import { chatContinuationBinding } from "./chat-continuation-profile.js";

/** Present only the argument representation this wire will send. Canonical
 * history retains both values; a prepared view never rewrites that history. */
export function normalizedToolArgumentRequest(request: ProviderRequest): ProviderRequest {
  let changed = false;
  const messages = request.messages.map(message => {
    if (!message.toolCalls?.some(call => call.originalArguments !== undefined)) return message;
    changed = true;
    return { ...message, toolCalls: message.toolCalls.map(call => {
      const { originalArguments: _original, ...normalized } = call;
      return normalized;
    }) };
  });
  return changed ? { ...request, messages } : request;
}

/** Match createChatToolContinuation.begin's existing effective-model and
 * defined-scope selector, including an empty opaque scope. No cache is read. */
export function chatToolArgumentRequest(endpoint: string, configuredModel: string, request: ProviderRequest): ProviderRequest {
  const model = request.model || configuredModel;
  return request.continuationScope !== undefined && chatContinuationBinding(endpoint, model) !== undefined
    ? request : normalizedToolArgumentRequest(request);
}
