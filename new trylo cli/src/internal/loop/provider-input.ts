import type { ReduceInput } from "../domain/input.js";
import type { ProviderEvent } from "../ports/provider.js";
import { assertExhaustive } from "../contract/index.js";
import { classifyProviderEvent } from "./adapt.js";

/**
 * Provider event -> domain input.
 *
 * Returns `undefined` for events that only carry block-lifecycle information
 * (start/end markers, argument fragments). Those are consumed by the loop's
 * block assembler and transcript, not by the reducer — the reducer must not
 * see a fact it cannot act on.
 */
export function providerEventToInput(
  event: ProviderEvent,
  eventId: string,
): ReduceInput | undefined {
  const classified = classifyProviderEvent(event, eventId);
  if (classified !== undefined) {
    return classified;
  }

  switch (event.type) {
    case "text_delta":
      return { type: "text_delta", eventId, text: event.text };
    case "reasoning_delta":
      return { type: "reasoning_delta", eventId, text: event.text, redacted: event.redacted };
    case "tool_input_start":
      return { type: "tool_input_opened", eventId, toolCallId: event.toolCallId };
    case "usage":
      return {
        type: "usage",
        eventId,
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        cacheReadTokens: event.usage.cacheReadTokens,
        cacheWriteTokens: event.usage.cacheWriteTokens,
        reasoningTokens: event.usage.reasoningTokens,
        totalTokens: event.usage.totalTokens,
      };
    case "finish":
      return {
        type: "finish",
        eventId,
        reason: event.reason,
        requiresFollowUp: event.requiresFollowUp,
      };
    case "raw_unknown":
      return { type: "provider_raw_unknown", eventId, wire: event.wire };
    case "cancel_ack":
      return { type: "cancel", eventId };
    case "stream_start":
    case "warning":
    case "text_start":
    case "text_end":
    case "reasoning_start":
    case "reasoning_end":
    case "tool_input_delta":
    case "tool_input_end":
      return undefined;
    // Parsed calls and invalid arguments both belong to the block assembler,
    // which settles each id once. Mapping a rejected adapter event again would
    // duplicate the failure when fragments already rejected that id.
    // A `tool_call` is the adapter's own parsed result, and the block assembler
    // (`stream-blocks.ts`) already turned it into exactly one `tool_request` —
    // guarded by its per-id `emittedToolCalls` set, which is what makes "one
    // call, one request" true when an adapter closes a call via `tool_input_end`,
    // via `tool_call`, or via both. Mapping it a second time here produced a
    // duplicate `tool_request` for the same id, invisible until now because the
    // reducer de-duplicates by `eventId`. That duplicate is not harmless:
    // anything counting a response's requests in order to schedule them (the
    // batch decision in `runner-effects.ts`) would count one call twice.
    case "tool_call":
    case "tool_call_invalid":
      return undefined;
    case "error":
      // classifyProviderEvent handles every error; unreachable but exhaustive.
      return undefined;
    default: {
      assertExhaustive(event);
      return undefined;
    }
  }
}

export function lateProviderEventToInput(event: ProviderEvent, eventId: string): ReduceInput | undefined {
  if (event.type === "cancel_ack") {
    return { type: "cancel", eventId };
  }

  if (event.type === "finish") {
    return { type: "finish", eventId, reason: event.reason, requiresFollowUp: event.requiresFollowUp };
  }

  if (event.type === "error") {
    return classifyProviderEvent(event, eventId);
  }

  return undefined;
}
