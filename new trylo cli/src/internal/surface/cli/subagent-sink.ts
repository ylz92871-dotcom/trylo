import type { SessionPort } from "../../ports/session.js";
import { PROTOCOL_VERSION, type Envelope, type JsonObject } from "../../protocol/envelope.js";
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

/**
 * Creates a SubagentJournalSink that bridges SubagentRuntime events to:
 * 1. The in-flight TurnRenderer for real-time CLI output.
 * 2. The durable SessionPort (.ndjson journal) so subagent_spawn/end persist to disk.
 */
export function createSubagentJournalSink(
  options: SubagentJournalSinkOptions,
): SubagentJournalSink {
  let currentRenderer: { onEnvelope: (envelope: Envelope) => void } | undefined;
  const pendingAppends = new Set<Promise<void>>();
  let failureCode: string | undefined;
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

    currentRenderer?.onEnvelope(envelope);

    if (options.session !== undefined) {
      if (pendingAppends.size >= MAX_PENDING_SUBAGENT_APPENDS) failureCode ??= "subagent_write_queue_full";
      if (failureCode !== undefined) return;
      const operation = options.session.append({
          type: "envelope",
          sessionId: options.sessionId,
          turnId: options.turnId,
          at: envelope.timestamp,
          payload: { envelope: envelope as unknown as JsonObject },
        }).then(result => {
          if (!result.ok) failureCode ??= result.code;
        }, () => { failureCode ??= "session_append_threw"; });
      pendingAppends.add(operation);
      void operation.then(() => { pendingAppends.delete(operation); });
    }
  };

  return {
    onEvent,
    setRenderer: (renderer) => {
      currentRenderer = renderer;
    },
    flush: async () => {
      await Promise.all(pendingAppends);
      if (failureCode !== undefined) throw new ExecutionProgressError("subagent", failureCode);
    },
  };
}
