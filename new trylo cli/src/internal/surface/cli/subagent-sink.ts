import type { SessionPort } from "../../ports/session.js";
import { PROTOCOL_VERSION, type Envelope, type JsonObject } from "../../protocol/envelope.js";
import { isSubagentObservation } from "../../protocol/subagent-observation.js";
import type { SubagentEventSink } from "../../subagent/index.js";
import { ExecutionProgressError } from "../../ports/execution-progress.js";

export type SubagentJournalSink = {
  readonly onEvent: SubagentEventSink;
  readonly setRenderer: (renderer: { onEnvelope: (envelope: Envelope) => void }) => void;
  readonly flush: () => Promise<void>;
};

/** End child lifecycles and persist their events before the parent stream closes. */
export async function finishSubagentEvents(
  runtime: { cancelAll: () => Promise<void> } | undefined,
  sink: SubagentJournalSink,
): Promise<void> {
  await runtime?.cancelAll();
  await sink.flush();
}

export type SubagentJournalSinkOptions = {
  readonly sessionId: string;
  readonly turnId: string;
  readonly session?: SessionPort | undefined;
  readonly now: () => number;
};

const MAX_PENDING_SUBAGENT_APPENDS = 128;

type PendingSubagentEnvelope = {
  readonly envelope: Envelope;
  readonly snapshotKey: string | undefined;
};

function snapshotKey(envelope: Envelope): string | undefined {
  const observation = envelope.payload.observation;
  const subagentId = envelope.payload.subagentId;
  if (envelope.kind !== "subagent_update" || typeof subagentId !== "string"
    || !isSubagentObservation(observation) || (observation.kind !== "text" && observation.kind !== "thinking")) return undefined;
  return JSON.stringify([envelope.attemptId, subagentId, observation.round, observation.id, observation.kind]);
}

/** Only queued snapshots can be replaced; committed and in-flight facts stay immutable. */
function coalesceSnapshot(pending: PendingSubagentEnvelope[], next: PendingSubagentEnvelope): void {
  if (next.snapshotKey === undefined) return;
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const previous = pending[index];
    // A tool, report, lifecycle, or unknown event seals the preceding snapshots.
    if (previous?.snapshotKey === undefined) break;
    if (previous.snapshotKey !== next.snapshotKey) continue;
    // A1, B1, A2 becomes B1, A2: replacement keeps its actual producer sequence.
    pending.splice(index, 1);
    return;
  }
}

class SubagentJournalAppender {
  private readonly pending: PendingSubagentEnvelope[] = [];
  private writer: Promise<void> | undefined;
  private inFlight: Envelope | undefined;
  private failureCode: string | undefined;

  constructor(private readonly session: SessionPort, private readonly sessionId: string, private readonly turnId: string) {}

  enqueue(envelope: Envelope): void {
    if (this.failureCode !== undefined) return;
    const next = { envelope, snapshotKey: snapshotKey(envelope) };
    coalesceSnapshot(this.pending, next);
    if (this.pending.length + (this.inFlight === undefined ? 0 : 1) >= MAX_PENDING_SUBAGENT_APPENDS) {
      this.failureCode = "subagent_write_queue_full";
      return;
    }
    this.pending.push(next);
    this.startWriter();
  }

  private startWriter(): void {
    // Defer startup so synchronous event bursts share one bounded writer.
    this.writer ??= Promise.resolve().then(() => this.drain()).then(() => {
      this.writer = undefined;
      // An event can arrive after drain returns but before this continuation.
      if (this.pending.length > 0) this.startWriter();
    });
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const next = this.pending.shift();
      if (next === undefined) break;
      this.inFlight = next.envelope;
      try {
        const result = await this.session.append({ type: "envelope", sessionId: this.sessionId, turnId: this.turnId,
          at: next.envelope.timestamp, payload: { envelope: next.envelope as unknown as JsonObject } });
        if (!result.ok) this.failureCode ??= result.code;
      } catch {
        // Observer delivery cannot throw storage failures into the child runtime.
        this.failureCode ??= "session_append_threw";
      }
      this.inFlight = undefined;
      // Accepted facts still drain after failure; later observations are rejected.
    }
  }

  async flush(): Promise<void> {
    while (this.writer !== undefined) await this.writer;
    if (this.failureCode !== undefined) throw new ExecutionProgressError("subagent", this.failureCode);
  }
}

/**
 * Creates a SubagentJournalSink that bridges SubagentRuntime events to:
 * 1. The in-flight TurnRenderer for real-time CLI output.
 * 2. The durable SessionPort (.ndjson journal) so subagent_spawn/end persist to disk.
 */
export function createSubagentJournalSink(
  options: SubagentJournalSinkOptions,
): SubagentJournalSink {
  let currentRenderer: { onEnvelope: (envelope: Envelope) => void } | undefined;
  const appender = options.session === undefined ? undefined : new SubagentJournalAppender(options.session, options.sessionId, options.turnId);
  let subagentEventSeq = 0;

  const onEvent: SubagentEventSink = (kind, payload, rootAttemptId) => {
    subagentEventSeq += 1;
    const envelope: Envelope = {
      protocolVersion: PROTOCOL_VERSION,
      eventId: `evt-${kind}-${options.now()}-${subagentEventSeq}`,
      sequence: subagentEventSeq,
      producerId: "subagent",
      producerSequence: subagentEventSeq,
      timestamp: new Date(options.now()).toISOString(),
      kind,
      payload: payload as unknown as JsonObject,
      attemptId: rootAttemptId,
      sessionId: options.sessionId,
      turnId: options.turnId,
    };

    // Private recovery chunks are journal data, never an activity or UI message.
    if (payload.checkpointPart === undefined) currentRenderer?.onEnvelope(envelope);

    appender?.enqueue(envelope);
  };

  return {
    onEvent,
    setRenderer: (renderer) => {
      currentRenderer = renderer;
    },
    flush: async () => {
      await appender?.flush();
    },
  };
}
