import type { Envelope } from "./envelope.js";
import { freezeEnvelope } from "./validate.js";

export type UnsequencedEvent = Omit<Envelope, "sequence" | "attemptId">;

export type AttemptSequencer = {
  readonly attemptId: string;
  bind(event: UnsequencedEvent): Envelope;
};

export function createAttemptSequencer(attemptId: string): AttemptSequencer {
  let next = 0;
  return {
    attemptId,
    bind(event) {
      const sequence = next;

      next += 1;

      return freezeEnvelope({
        ...event,
        attemptId,
        sequence,
      });
    },
  };
}
