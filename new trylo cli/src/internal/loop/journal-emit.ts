import type { ExecutionState } from "../domain/state.js";
import { PROTOCOL_VERSION, type Envelope, type JsonObject } from "../protocol/envelope.js";
import { envelopeChecksum } from "./checksum.js";
import type { ExecutionJournal } from "./journal.js";
import { publicToolResultFrames } from "../protocol/public-tool-result.js";

/**
 * Journal emission, extracted from `runner.ts` so the runner does not grow.
 *
 * There is nothing behavioural here: the same two functions, moved to their own
 * file with the host shape they actually need. The runner is a frozen core that
 * has to stay the same length while new seams are added, and this is the piece
 * of it that was pure mechanics — seq numbering and envelope stamping — with no
 * decision in it at all. `Engine` satisfies `EmitHost` structurally, so the call
 * sites did not change.
 *
 * `checksums` is mutated in place because the runner hands the same array out on
 * the turn result; a copy here would silently stop the turn result from matching
 * the journal.
 */
/**
 * An observer of the journal, not a participant in it (WP D1).
 *
 * It is called once per envelope, after that envelope is appended, so what it
 * sees is exactly what the turn recorded and in the order the turn recorded it.
 * It cannot influence the turn: the return value is ignored, a throw is
 * swallowed, and cancellation still travels only through `cancelSignal`. The
 * reason it exists here rather than in a caller is that `emitRaw` is the single
 * append point — hooking anything narrower would miss the envelopes emitted
 * from `host-views.ts` and the observer would stop matching the journal.
 */
export type EnvelopeSink = (envelope: Envelope) => void;

export type EmitHost = {
  readonly journal: ExecutionJournal;
  readonly state: ExecutionState;
  /** Next event number. Mutated in place: the host owns the counter. */
  seq: number;
  readonly checksums: string[];
  /** Absent on every path that does not observe the turn. */
  readonly onEnvelope?: EnvelopeSink;
  /** Lent by the host through the engine; the emit path never reads a clock itself. */
  readonly now: () => number;
};

export function emitRaw(engine: EmitHost, kind: string, payload: JsonObject): void {
  const frames = kind !== "tool_result" ? undefined : publicToolResultFrames(payload, {
    protocolVersion: PROTOCOL_VERSION, producerId: "loop",
    ...(engine.state.sessionId === undefined ? {} : { sessionId: engine.state.sessionId }),
    ...(engine.state.turnId === undefined ? {} : { turnId: engine.state.turnId }),
    ...(engine.state.currentAttemptId === undefined ? {} : { attemptId: engine.state.currentAttemptId }),
    ...(engine.state.correlationId === undefined ? {} : { correlationId: engine.state.correlationId }),
  }, engine.seq + 1);
  if (frames === undefined) {
    emitFrame(engine, kind, payload);
    return;
  }

  for (const frame of frames) emitFrame(engine, frame.kind, frame.payload);
}

function emitFrame(engine: EmitHost, kind: string, payload: JsonObject): void {
  // Parsed tool arguments already belong to execution state. Record that fact
  // once here for every single/batch call; projections never reconstruct it.
  const call = kind === "tool_use" && typeof payload.toolCallId === "string"
    ? engine.state.toolCalls[payload.toolCallId] : undefined;
  const envelope = engine.journal.append({
    protocolVersion: PROTOCOL_VERSION,
    eventId: nextId(engine),
    timestamp: new Date(engine.now()).toISOString(),
    kind,
    payload: call === undefined ? payload : { ...payload, arguments: call.arguments },
    producerId: "loop",
    producerSequence: engine.seq,
    ...(engine.state.sessionId !== undefined ? { sessionId: engine.state.sessionId } : {}),
    ...(engine.state.turnId !== undefined ? { turnId: engine.state.turnId } : {}),
    ...(engine.state.correlationId !== undefined
      ? { correlationId: engine.state.correlationId }
      : {}),
  });

  engine.checksums.push(envelopeChecksum(envelope));

  if (engine.onEnvelope !== undefined) {
    try {
      engine.onEnvelope(envelope);
    } catch {
      // Degradation, not failure: an observer that throws has made a mistake
      // about its own job, and the turn is not its to end. A surface that wants
      // to say so says it where the user can see it (see `host.ts`).
    }
  }
}

export function nextId(engine: EmitHost): string {
  engine.seq += 1;
  return `evt-${engine.seq}`;
}
