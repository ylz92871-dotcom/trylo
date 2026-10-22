import { ExecutionProgressError, type ExecutionProgressPort, type ProgressWriteOutcome } from "../ports/execution-progress.js";
import type { StreamPartials } from "../protocol/stream-partial.js";
import type { Transcript } from "../protocol/transcript.js";
import type { Engine } from "./runner-engine.js";
import type { LoopPorts } from "./runner.js";

async function acknowledged(stage: string, operation: Promise<ProgressWriteOutcome>): Promise<void> {
  const outcome = await operation;
  if (!outcome.ok) throw new ExecutionProgressError(stage, outcome.code);
}

/** A snapshot is borrowed, never reconstructed from a UI event. */
export async function flushProgress(engine: Engine, ports: LoopPorts): Promise<void> {
  if (ports.progress === undefined) return;
  const envelopes = engine.journal.events(engine.progressEnvelopeCount);
  await acknowledged("flush", ports.progress.flush({
    transcript: engine.transcript,
    envelopes,
  }));
  engine.progressEnvelopeCount += envelopes.length;
}

/** The provider accumulator owns these closed items until the stream returns. */
export async function flushStreamItems(port: ExecutionProgressPort | undefined, items: Transcript): Promise<void> {
  if (port === undefined || items.length === 0) return;
  await acknowledged("transcript", port.flush({ transcript: items, envelopes: [] }));
}

/**
 * What is still open, made durable mid-stream.
 *
 * An empty set is not written at all: every block having closed is the common
 * end of a stream, and appending a "nothing is open" record would only add
 * bytes that say nothing.
 */
export async function preserveOpenBlocks(port: ExecutionProgressPort | undefined, partials: StreamPartials): Promise<void> {
  if (port?.preserve === undefined || partials.length === 0) return;
  await acknowledged("preserve", port.preserve(partials));
}

export async function issueEffect(engine: Engine, ports: LoopPorts, key: string): Promise<void> {
  if (ports.progress === undefined) return;
  await flushProgress(engine, ports);
  await acknowledged("issue", ports.progress.issue(key));
}

/** Tool settlement uses the canonical outcome, never the interpreter's ack set. */
export async function settleEffect(engine: Engine, ports: LoopPorts, key: string, callId: string): Promise<void> {
  if (ports.progress === undefined) return;
  await flushProgress(engine, ports);
  const result = [...engine.transcript].reverse().find(item => item.kind === "tool_result" && item.toolCallId === callId);
  const outcome = result?.kind === "tool_result" ? result.outcome : "unknown";
  await acknowledged("settle", ports.progress.settle(key, outcome));
}
