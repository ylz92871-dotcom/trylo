import type { ReduceInput } from "../domain/input.js";
import { freezeEnvelope } from "../protocol/validate.js";
import type { Envelope } from "../protocol/envelope.js";
import type { UnsequencedEvent } from "../protocol/sequencer.js";
import { createAttemptSequencer, type AttemptSequencer } from "../protocol/sequencer.js";

export type JournalSnapshot = {
  readonly envelopes: readonly Envelope[];
  readonly inputs: readonly ReduceInput[];
};

export type ExecutionJournal = {
  append(event: UnsequencedEvent): Envelope;
  recordInput(input: ReduceInput): ReduceInput;
  events(from?: number): readonly Envelope[];
  inputs(): readonly ReduceInput[];
  snapshot(): JournalSnapshot;
  bindAttempt(attemptId: string): void;
};

export function createExecutionJournal(): ExecutionJournal {
  const events: Envelope[] = [];
  const inputs: ReduceInput[] = [];
  // The journal already retains every input. This index gives repeated ids
  // their original position without a second, capped reducer history.
  const deliveries = new Map<string, number>();
  let sequencer: AttemptSequencer | undefined;
  return {
    bindAttempt(attemptId) {
      sequencer = createAttemptSequencer(attemptId);
    },
    recordInput(input) {
      let deliverySequence = deliveries.get(input.eventId);
      if (deliverySequence === undefined) {
        deliverySequence = deliveries.size + 1;
        deliveries.set(input.eventId, deliverySequence);
      }
      const delivered = { ...input, deliverySequence };
      inputs.push(delivered);
      return delivered;
    },
    append(event) {
      const envelope =
        sequencer === undefined
          ? freezeEnvelope({ ...event, sequence: events.length })
          : sequencer.bind(event);
      events.push(envelope);
      return envelope;
    },
    events(from = 0) {
      return events.slice(from);
    },
    inputs() {
      return [...inputs];
    },
    snapshot() {
      return { envelopes: [...events], inputs: [...inputs] };
    },
  };
}

export function serializeJournal(snapshot: JournalSnapshot): string {
  return `${JSON.stringify(snapshot)}\n`;
}

export function parseJournal(raw: string): JournalSnapshot {
  const parsed = JSON.parse(raw) as JournalSnapshot;
  return {
    envelopes: [...parsed.envelopes],
    inputs: [...parsed.inputs],
  };
}
