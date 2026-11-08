import type { ProviderMessage } from "../ports/provider.js";

const REDACTED_CALL_NOTICE = "A tool attempt had invalid arguments. Its arguments were omitted; {} below is a redacted history placeholder only. No tool was executed for that attempt.";

/** Rejected JSON has no executable canonical call. The wire still needs a
 * matching assistant attempt before its failed tool result. This projection
 * never creates a tool_request, grants permission or changes the transcript.
 */
export function pairRejectedToolMessages(messages: readonly ProviderMessage[], rejected: ReadonlyMap<string, string>): readonly ProviderMessage[] {
  if (rejected.size === 0) return messages;

  const output: ProviderMessage[] = [];
  const pending = new Set<string>();
  let assistantIndex: number | undefined;

  for (const message of messages) {
    const id = message.toolCallId;
    const name = id === undefined ? undefined : rejected.get(id);
    if (message.role === "tool" && id !== undefined && name !== undefined && !pending.has(id)) {
      const call = { toolCallId: id, name, arguments: {} };
      const previous = assistantIndex === undefined ? undefined : output[assistantIndex];
      if (previous !== undefined && assistantIndex !== undefined) {
        // Attach to the open batch, even if another result already arrived.
        // All tool responses remain contiguous after the complete call list.
        output[assistantIndex] = { ...previous, content: `${previous.content}\n${REDACTED_CALL_NOTICE}`, toolCalls: [...(previous.toolCalls ?? []), call] };
      } else {
        assistantIndex = output.length;
        output.push({ role: "assistant", content: REDACTED_CALL_NOTICE, toolCalls: [call] });
      }

      pending.add(id);
    }

    output.push(message);

    if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
      assistantIndex = output.length - 1;
      for (const call of message.toolCalls) pending.add(call.toolCallId);
    }

    if (message.role === "tool" && id !== undefined) pending.delete(id);

    if (pending.size === 0) assistantIndex = undefined;
  }

  return output;
}
