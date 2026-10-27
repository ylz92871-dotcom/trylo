import type { ReduceInput } from "../domain/input.js";
import type { ProviderEvent } from "../ports/provider.js";

export type AdapterClass =
  | "timeout"
  | "process_exit"
  | "sent_unacked"
  | "transport_fail"
  | "auth"
  | "rate_limit"
  | "invalid_request"
  | "cancelled";

/**
 * Provider error -> domain input.
 *
 * The phase is the whole point: an error before headers leaves no delivered
 * state (fail), an error after the stream started leaves unknown delivered
 * state (unknown). Collapsing the two would either hide delivered output or
 * invent a failure that never happened.
 */
export function classifyProviderEvent(
  event: ProviderEvent,
  eventId: string,
): ReduceInput | undefined {
  if (event.type !== "error") {
    return undefined;
  }
  if (event.class === "cancelled") {
    return { type: "cancel", eventId };
  }
  // The provider's message is the head of the diagnosis (`http_400`,
  // `token_refresh_failed: …`). The four classified branches below used to
  // replace it with the bare class name, so by the time the terminal
  // envelope reached the surface the status line was gone and the warning
  // read as an action with no cause ("check --model, the endpoint and the
  // request options" and nothing else). Keep the detail whenever it says
  // more than the class alone; the class still travels in `errorClass` so
  // nothing downstream has to parse this text.
  if (event.class === "timeout") {
    return { type: "transport_fail", eventId, message: detailFor(event, "timeout"), errorClass: event.class };
  }
  if (event.class === "auth") {
    return { type: "transport_fail", eventId, message: detailFor(event, "auth"), errorClass: event.class };
  }
  if (event.class === "rate_limit") {
    return { type: "transport_fail", eventId, message: detailFor(event, "rate_limit"), errorClass: event.class };
  }
  if (event.class === "invalid_request") {
    return { type: "transport_fail", eventId, message: detailFor(event, "invalid_request"), errorClass: event.class };
  }
  if (event.phase === "after_stream_started") {
    return {
      type: "transport_unknown",
      eventId,
      // Quota adapters already emit bounded fixed metadata. Keep the actionable
      // reset while preserving unknown delivery after headers were accepted.
      message: event.class === "quota" ? detailFor(event, "quota") : `mid_stream:${event.class}`,
      errorClass: event.class,
    };
  }
  // Non-specific classes keep the provider's own diagnostic string so operators
  // can still tell a dropped connection from a crashed child process. The class
  // travels separately so nothing downstream has to parse this text.
  return { type: "transport_fail", eventId, message: event.message, errorClass: event.class };
}

/**
 * The provider's own detail wins whenever it says more than the bare class.
 * An empty detail, or one that merely repeats the class, falls back to the
 * class so the terminal envelope always carries something printable.
 */
function detailFor(event: Extract<ProviderEvent, { type: "error" }>, fallback: string): string {
  const message = event.message.trim();
  if (message === "" || message === fallback) return fallback;
  return message;
}

export function adapterClassOf(input: ReduceInput): AdapterClass | undefined {
  if (input.type === "cancel") {
    return "cancelled";
  }
  if (input.type !== "transport_fail" && input.type !== "transport_unknown") {
    return undefined;
  }
  if (input.type === "transport_unknown") {
    return "sent_unacked";
  }
  // The stable class first: the message now carries the provider's own
  // detail (`http_400`), so parsing the text would misclassify every real
  // failure as generic `transport_fail`. The message-equality branches
  // stay as the fallback for inputs built before `errorClass` existed.
  const byClass = input.errorClass;
  if (byClass === "timeout") return "timeout";
  if (byClass === "auth") return "auth";
  if (byClass === "rate_limit") return "rate_limit";
  if (byClass === "invalid_request") return "invalid_request";
  const message = input.message;
  if (message === "timeout") {
    return "timeout";
  }
  if (message === "process_exit") {
    return "process_exit";
  }
  if (message === "auth") {
    return "auth";
  }
  if (message === "rate_limit") {
    return "rate_limit";
  }
  if (message === "invalid_request") {
    return "invalid_request";
  }
  return "transport_fail";
}
