import {
  TERMINAL_KIND,
  type Envelope,
  type TerminalReason,
} from "./envelope.js";
import type { ValidateResult } from "./result.js";
import type { AttemptSequencer, UnsequencedEvent } from "./sequencer.js";

export function readTerminalReason(envelope: Envelope): TerminalReason | undefined {
  if (envelope.kind !== TERMINAL_KIND) {
    return undefined;
  }

  const reason = envelope.payload.reason;
  if (
    reason === "completed" ||
    reason === "failed" ||
    reason === "cancelled" ||
    reason === "unknown"
  ) {
    return reason;
  }

  return undefined;
}

export function appendLateObservation(
  terminal: Envelope,
  event: UnsequencedEvent,
  sequencer: AttemptSequencer,
): ValidateResult {
  if (terminal.kind !== TERMINAL_KIND) {
    return { ok: false, code: "not_terminal" };
  }
  return {
    ok: true,
    envelope: sequencer.bind({
      ...event,
      correlationId: terminal.eventId,
    }),
  };
}
