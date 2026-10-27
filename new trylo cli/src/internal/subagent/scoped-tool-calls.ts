import type { ToolPort } from "../ports/tools.js";

export function scopedToolCallId(owner: string, id: string): string { return JSON.stringify([owner, id]); }

/** Provider call ids are local to a conversation. Shared adapters require an
 * owner-qualified key; the loop, permissions and transcript keep the original id.
 * JSON framing prevents a caller id from escaping into another owner's key.
 */
export function scopeToolCalls(tools: ToolPort, owner: string, logicalOwner?: string): ToolPort {
  const key = (id: string): string => scopedToolCallId(owner, id);
  return {
    snapshot: () => tools.snapshot(),
    execute: (call, signal) => tools.execute({ name: call.name, arguments: call.arguments,
      toolCallId: key(call.toolCallId), ...(logicalOwner === undefined ? {} : { ownerId: logicalOwner }) }, signal),
    cancel: id => tools.cancel(key(id)),
  };
}
