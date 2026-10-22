import type { ProviderEvent } from "../../ports/provider.js";
import { parseToolInput } from "./invalid-tool-input.js";
import { isResponseRecord as record, responseString as str } from "./responses-fields.js";
import { stableJson } from "../../ports/permission.js";
import { responsesProtocolError } from "./responses-error.js";

type Assembly = { readonly kind: "pending"; text: string }
  | { readonly kind: "identified"; readonly callId: string; readonly name: string; text: string };
type Settled = { readonly callId: string; readonly name: string; readonly argumentsKey: string; readonly text: string };

/** Item ids assemble fragments; only a confirmed call id may open a public block.
 * A sparse gateway can omit added frames: its fragments stay private until done
 * supplies the identity. Final snapshots are authoritative and settle once.
 */
export function createResponsesTools() {
  const pending = new Map<string, Assembly>();
  const settledItems = new Map<string, Settled>(), settledCalls = new Map<string, Settled>();
  let count = 0;
  function protocolFailure(): ProviderEvent[] {
    return [responsesProtocolError("responses_tool_identity_invalid")];
  }
  function settle(itemId: string, callId: string, name: string, text: string): ProviderEvent[] {
    if (!callId || !name) return protocolFailure();
    const parsed = parseToolInput(text);
    const current = { callId, name, text, argumentsKey: parsed.ok ? stableJson(parsed.arguments) : text };
    const previous = settledItems.get(itemId) ?? settledCalls.get(callId);
    if (previous !== undefined) {
      if (previous.callId !== callId || previous.name !== name || previous.argumentsKey !== current.argumentsKey) return protocolFailure();
      pending.delete(itemId);
      settledItems.set(itemId, previous);
      return [];
    }
    pending.delete(itemId);
    settledItems.set(itemId, current); settledCalls.set(callId, current); count++;
    return parsed.ok ? [{ type: "tool_call", toolCallId: callId, name, arguments: parsed.arguments }]
      : [{ type: "tool_call_invalid", toolCallId: callId, name, rawArguments: "", message: parsed.message }];
  }
  return {
    count: () => count,
    added(payload: Record<string, unknown>): ProviderEvent[] {
      const item = payload["item"];
      if (!record(item) || item["type"] !== "function_call") return [];
      const itemId = str(item, "id"), callId = str(item, "call_id"), name = str(item, "name");
      if (!itemId || !callId || !name) return [];
      const settled = settledItems.get(itemId);
      if (settled !== undefined) return settled.callId === callId && settled.name === name ? [] : protocolFailure();
      const old = pending.get(itemId);
      if (old?.kind === "identified") return old.callId === callId && old.name === name ? [] : protocolFailure();
      const text = old?.text ?? "";
      pending.set(itemId, { kind: "identified", callId, name, text });
      return [{ type: "tool_input_start", toolCallId: callId, name },
        ...(text ? [{ type: "tool_input_delta" as const, toolCallId: callId, argumentsText: text }] : [])];
    },
    delta(payload: Record<string, unknown>): ProviderEvent[] {
      const itemId = str(payload, "item_id"), text = str(payload, "delta");
      if (!itemId || settledItems.has(itemId)) return [];
      const open = pending.get(itemId) ?? { kind: "pending", text: "" };
      open.text += text; pending.set(itemId, open);
      return open.kind === "identified" && text
        ? [{ type: "tool_input_delta", toolCallId: open.callId, argumentsText: text }] : [];
    },
    done(payload: Record<string, unknown>): ProviderEvent[] {
      const item = payload["item"];
      if (!record(item) || item["type"] !== "function_call") return [];
      const itemId = str(item, "id") || str(payload, "item_id") || str(item, "call_id");
      const open = pending.get(itemId);
      const previous = settledItems.get(itemId);
      const callId = str(item, "call_id") || (open?.kind === "identified" ? open.callId : previous?.callId ?? itemId);
      const name = str(item, "name") || (open?.kind === "identified" ? open.name : previous?.name ?? "");
      if (open?.kind === "identified" && (open.callId !== callId || open.name !== name)) return protocolFailure();
      return settle(itemId, callId, name, str(item, "arguments") || open?.text || previous?.text || "");
    },
    complete(): ProviderEvent[] {
      const events: ProviderEvent[] = [];
      for (const [id, open] of pending) {
        if (open.kind === "pending") return [...events, ...protocolFailure()];
        events.push(...settle(id, open.callId, open.name, open.text));
      }
      return events;
    },
  };
}
