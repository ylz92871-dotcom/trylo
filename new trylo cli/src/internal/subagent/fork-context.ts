import type { ProviderMessage, ProviderPort } from "../ports/provider.js";

/** Only answered calls cross the fork boundary; an in-flight spawn is not history. */
export function completedParentContext(messages: ReadonlyArray<ProviderMessage>): ReadonlyArray<ProviderMessage> {
  const calls = new Set(messages.flatMap(message => message.toolCalls?.map(call => call.toolCallId) ?? []));
  const answered = new Set(messages.filter(message => message.role === "tool" && message.toolCallId !== undefined)
    .map(message => message.toolCallId));
  return messages.flatMap(message => {
    if (message.role === "tool") return message.toolCallId !== undefined && calls.has(message.toolCallId) ? [message] : [];
    if (message.toolCalls === undefined) return [message];
    const toolCalls = message.toolCalls.filter(call => answered.has(call.toolCallId));
    const { toolCalls: _calls, ...rest } = message;
    return toolCalls.length > 0 ? [{ ...rest, toolCalls }] : message.content.length > 0 ? [rest] : [];
  });
}

/**
 * Fork context is an immutable provider prefix, separate from the child's own
 * transcript. Keeping the original messages preserves tool pairs and validated
 * image payloads without inventing a second persisted transcript format.
 */
export function createForkContextProvider(provider: ProviderPort, messages: ReadonlyArray<ProviderMessage>): ProviderPort {
  if (messages.length === 0) return provider;
  const prefix = completedParentContext(messages);
  const identity: ProviderMessage = { role: "system", content: [
    "You are a delegated subagent. The preceding conversation belongs to your parent and is background context.",
    "Carry out only the newest child instruction; do not repeat the parent's task or start new agents.",
    "Use only your currently advertised tool definitions, not tool lists quoted in the parent history.",
  ].join("\n") };
  return { ...provider, async *stream(request, signal) {
    yield* provider.stream({ ...request, messages: [...prefix, identity, ...request.messages] }, signal);
  } };
}
