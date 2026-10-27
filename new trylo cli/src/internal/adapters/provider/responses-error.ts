import type { ProviderEvent } from "../../ports/provider.js";
import { isResponseRecord } from "./responses-fields.js";
import { quotaFailureMessage } from "./quota-failure.js";

/** Responses can report the same allowance error in several terminal frames. */
export function responsesProviderError(payload: unknown, fallbackMessage: string): ProviderEvent {
  const detail = isResponseRecord(payload) && isResponseRecord(payload["response"]) ? payload["response"] : payload;
  const quota = quotaFailureMessage(detail);
  return { type: "error", class: quota === undefined ? "server" : "quota", retryable: false,
    phase: "after_stream_started", message: quota ?? fallbackMessage };
}

/** A malformed Responses stream cannot authorize tools or claim completion. */
export function responsesProtocolError(message: string): ProviderEvent {
  return { type: "error", class: "protocol", retryable: false, phase: "after_stream_started", message };
}
