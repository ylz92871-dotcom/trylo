import type { ProviderEvent } from "../../ports/provider.js";

/** A malformed Responses stream cannot authorize tools or claim completion. */
export function responsesProtocolError(message: string): ProviderEvent {
  return { type: "error", class: "protocol", retryable: false, phase: "after_stream_started", message };
}
