import type { ProviderEvent } from "./provider.js";

/** Adapter-local stream setup is not a server response. Use the same exposure boundary for parent and member requests. */
export function acknowledgesProviderResponse(event: ProviderEvent): boolean {
  return event.type === "text_start" || event.type === "text_delta" || event.type === "reasoning_start" || event.type === "reasoning_delta"
    || event.type === "tool_input_start" || event.type === "tool_input_delta" || event.type === "tool_call" || event.type === "tool_call_invalid"
    || event.type === "usage" && event.usage.totalTokens > 0 || event.type === "finish" && event.reason !== "error";
}
