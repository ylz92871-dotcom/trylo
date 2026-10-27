import type { ProviderMessage } from "../ports/provider.js";

/** Only answered calls cross the fork boundary; an in-flight spawn is not history. */
export function completedParentContext(messages: ReadonlyArray<ProviderMessage>): ReadonlyArray<ProviderMessage> {
  const pending = new Map<string, { readonly messageIndex: number; readonly callIndex: number }>();
  const answered = new Map<number, Set<number>>(), results = new Set<number>();
  messages.forEach((message, messageIndex) => {
    if (message.role === "assistant") {
      message.toolCalls?.forEach((call, callIndex) => { pending.set(call.toolCallId, { messageIndex, callIndex }); });
    } else if (message.role === "tool" && message.toolCallId !== undefined) {
      const call = pending.get(message.toolCallId);
      if (call === undefined) return;
      const group = answered.get(call.messageIndex) ?? new Set<number>();
      group.add(call.callIndex); answered.set(call.messageIndex, group);
      results.add(messageIndex); pending.delete(message.toolCallId);
    }
  });
  return messages.flatMap((message, messageIndex) => {
    if (message.role === "tool") return results.has(messageIndex) ? [message] : [];
    if (message.toolCalls === undefined) return [message];
    const toolCalls = message.toolCalls.filter((_call, callIndex) => answered.get(messageIndex)?.has(callIndex));
    const { toolCalls: _calls, ...rest } = message;
    return toolCalls.length > 0 ? [{ ...rest, toolCalls }] : message.content.length > 0 ? [rest] : [];
  });
}

/**
 * Fork context enters the Loop before its context accounting, never as a late
 * provider decorator. The immutable background preserves completed pairs and
 * validated images. An oversized background is refused rather than truncated.
 */
export function forkBackgroundMessages(messages: ReadonlyArray<ProviderMessage>): ReadonlyArray<ProviderMessage> {
  if (messages.length === 0) return [];
  const prefix = completedParentContext(structuredClone(messages));
  const identity: ProviderMessage = { role: "system", content: [
    "You are a delegated subagent. The preceding conversation belongs to your parent and is background context.",
    "Carry out only the newest child instruction; do not repeat the parent's task or start new agents.",
    "Use only your currently advertised tool definitions, not tool lists quoted in the parent history.",
  ].join("\n") };
  return [...prefix, identity];
}
