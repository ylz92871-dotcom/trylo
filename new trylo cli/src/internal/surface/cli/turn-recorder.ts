import { ExecutionProgressError, type ExecutionProgress, type ExecutionProgressPort, type ProgressWriteOutcome } from "../../ports/execution-progress.js";
import type { SessionPort } from "../../ports/session.js";
import type { BootstrapContext } from "./bootstrap-context.js";
import type { CliRunStatus, CliUsage, CliUsageAccounting } from "../../protocol/cli-stream.js";
import { createPartialRecorder } from "./partial-recorder.js";
import type { Transcript } from "../../protocol/transcript.js";
import type { ProjectInstructionSource } from "./session-record.js";
import { sessionPayload } from "./session-payload.js";
import { serializeSessionWrites } from "./session-write-queue.js";
import { providerContinuationScope, type ProviderContinuationPort } from "../../ports/provider.js";
import type { Envelope } from "../../protocol/envelope.js";
import { promptInputCheckpointForCompletion } from "../../loop/prompt-input-records.js";
import { isNormalProviderReturnObservation, isProviderWaitObservation, providerReturnMatchesCapture,
  type NormalProviderReturnObservation, type ProviderWaitObservation } from "../../learning/central/runtime/provider-positive.js";

type RecordInput = Parameters<SessionPort["append"]>[0];

type AppendFact = (type: RecordInput["type"], payload: RecordInput["payload"], at?: string) => Promise<ProgressWriteOutcome>;

type EnvelopeAttemptCursor = { readonly values: Map<number, string>; high: number };

type RecorderCursor = {
  /** Ordinal -> digest of everything known durable, resumed items included. */
  readonly items: Map<number, string>;
  /** Same for envelopes, which are per-turn and start empty. */
  readonly envelopeAttempts: Map<string, EnvelopeAttemptCursor>;
  /** Highest ordinal written or resumed; nothing durable appears below it. */
  highItem: number;
  readonly scope: string;
  continuation: ProviderContinuationPort | undefined;
  readonly sessionId: string;
  readonly turnId: string;
  streamIndex: number;
  streamAttemptId: string | undefined;
  streamOpen: boolean;
};

export type TurnRecorder = {
  readonly session: SessionPort;
  readonly progress: ExecutionProgressPort;
  start(input: { readonly startedAt: number; readonly toolCatalogHash: string; readonly sources?: ReadonlyArray<ProjectInstructionSource>; readonly continuation?: ProviderContinuationPort; readonly bootstrapContext?: BootstrapContext; readonly userSourceAvailable?: false }): Promise<void>;
  finish(input: { readonly status: CliRunStatus; readonly finishReason: string; readonly usage: CliUsage; readonly accounting?: CliUsageAccounting }): Promise<void>;
};

export type TurnRecorderInput = {
  readonly providerWaitObservation?: ProviderWaitObservation;
  readonly readProviderReturnObservation?: () => NormalProviderReturnObservation | undefined;
  readonly onCommittedEnvelope?: (envelope: Envelope) => void;
  readonly onCommittedEffect?: (key: string, outcome: "succeeded" | "failed" | "unknown" | "cancelled") => void;
  readonly session?: SessionPort;
  readonly sessionId: string;
  readonly turnId: string;
  readonly resumeTranscript?: Transcript;
  readonly now: () => number;
};

/**
 * Incremental write adapter over the existing v1 journal, not a second store.
 * Cursors belong to this one turn. They advance only after a durable ack, so
 * finish can never duplicate history and a failed write can never skip a fact.
 */
export function createTurnRecorder(input: TurnRecorderInput): TurnRecorder | undefined {
  if (input.session === undefined) return undefined;

  const session = serializeSessionWrites(input.session);
  const resumed = input.resumeTranscript ?? [];
  const cursor = seedCursor(resumed, providerContinuationScope(input.sessionId, input.turnId), input.sessionId, input.turnId);
  const stamp = (): string => new Date(input.now()).toISOString();
  const capture = providerObservationMetadata(() => input.providerWaitObservation, value =>
    isProviderWaitObservation(value) && value.sessionId === input.sessionId && value.turnId === input.turnId);
  const append = async (type: RecordInput["type"], payload: RecordInput["payload"], at = stamp()): Promise<ProgressWriteOutcome> => {
    const result = await session.append({ type, sessionId: input.sessionId, turnId: input.turnId, at, payload });
    return result.ok ? { ok: true } : result;
  };

  return {
    session,
    progress: progressPort(append, cursor, input),

    async start(metadata) {
      cursor.continuation = metadata.continuation;
      await requireWrite("turn_start", append("turn_start", {
        toolCatalogHash: metadata.toolCatalogHash,
        ...(capture === undefined ? {} : { providerWaitObservation: capture }),
        ...(metadata.bootstrapContext === undefined ? {} : { bootstrapContext: sessionPayload(metadata.bootstrapContext) }),
        ...(metadata.userSourceAvailable === undefined ? {} : { userSourceAvailable: metadata.userSourceAvailable }),
        ...(metadata.sources === undefined ? {} : { projectInstructions: sessionPayload(metadata.sources) }),
      }, new Date(metadata.startedAt).toISOString()));
    },

    finish: terminal => {
      const returned = terminal.status !== "completed" || capture === undefined ? undefined
        : providerObservationMetadata(input.readProviderReturnObservation, value =>
          isNormalProviderReturnObservation(value) && isProviderWaitObservation(capture)
          && providerReturnMatchesCapture(capture, value));
      return requireWrite("terminal", append("terminal", {
        reason: terminal.status,
        finishReason: terminal.finishReason,
        usage: sessionPayload(terminal.usage),
        ...(terminal.accounting === undefined ? {} : { accounting: sessionPayload(terminal.accounting) }),
        ...(returned === undefined ? {} : { providerReturnObservation: returned }),
      }));
    },
  };
}

/** Optional observation failure must never change a normal PA's recording outcome. */
function providerObservationMetadata(read: (() => unknown) | undefined, valid: (value: unknown) => boolean): RecordInput["payload"] | undefined {
  try {
    const value = read?.();
    return valid(value) ? sessionPayload(value) : undefined;
  } catch { return undefined; }
}

async function requireWrite(stage: string, operation: Promise<ProgressWriteOutcome>): Promise<void> {
  const result = await operation;
  if (!result.ok) throw new ExecutionProgressError(stage, result.code);
}

function progressPort(append: AppendFact, cursor: RecorderCursor, observers: Pick<TurnRecorderInput, "onCommittedEnvelope" | "onCommittedEffect">): ExecutionProgressPort {
  return {
    flush: facts => appendNewFacts(append, cursor, facts, observers.onCommittedEnvelope),
    /**
     * Open blocks, appended as they grow.
     *
     * Snapshots and validated suffixes share the existing journal owner.
     * They are never folded into `transcript` — a half-received answer is not
     * an answer — so the record carries the block identity a resume needs to
     * show it without ever replaying it.
     */
    preserve: createPartialRecorder(payload => append("stream_partial", payload)),
    issue: key => append("effect_issued", { key }),

    async settle(key, outcome) {
      const type = outcome === "succeeded" ? "effect_committed" : outcome === "unknown" ? "effect_unknown" : "effect_failed";
      const result = await append(type, { key, outcome });
      if (result.ok) notifyCommitted(() => observers.onCommittedEffect?.(key, outcome));

      return result;
    },
  };
}

/**
 * One durable value's identity, for telling a re-delivery from a rewrite.
 *
 * `sessionPayload` first, so the digest is taken of what would actually reach
 * disk rather than of an in-memory object that may carry children JSON drops.
 */
function digestOf(value: unknown): string {
  return JSON.stringify(sessionPayload(value));
}

/**
 * The resumed transcript is already durable, so every item in it is a known
 * ordinal with a known digest.
 *
 * Seeding the whole thing — not just its tail — is what lets the first flush
 * re-submit the entire history without being read as a conflict: `flush` is
 * always handed the full transcript, so a resume replays items this process
 * never wrote. Without them in the map, "an ordinal below the watermark I have
 * no digest for" would look exactly like a rewrite of durable history.
 */
function seedCursor(resumed: Transcript, scope: string, sessionId: string, turnId: string): RecorderCursor {
  const items = new Map<number, string>();
  let highItem = -1;

  for (const item of resumed) {
    items.set(item.sequence, digestOf(item));
    if (item.sequence > highItem) highItem = item.sequence;
  }

  return { items, envelopeAttempts: new Map(), highItem, scope, continuation: undefined,
    sessionId, turnId, streamIndex: 0, streamAttemptId: undefined, streamOpen: false };
}

/**
 * How one submitted fact stands against what is already durable.
 *
 * Three outcomes, and the distinction is the whole reason this exists:
 *
 *  - **skip** — this ordinal is already durable with byte-identical content.
 *    That is the ordinary case: `flush` receives the whole transcript and the
 *    whole journal every time, so re-delivery is the port working, not a bug.
 *  - **conflict** — the ordinal is claimed by something else (different
 *    content), or a fact surfaced *below* the high-water mark. The first is two
 *    facts fighting over one ordinal; the second is a fact that cannot exist
 *    there, because everything below the mark was already written. Either way
 *    one of them would be lost by a skip, so both are refused.
 *  - **write** — an ordinal above the mark, or one below it this recorder has
 *    never seen.
 *
 * A *gap* is deliberately not a conflict: transcript ordinals are sparse by
 * construction (a purged unanswered call keeps its ordinal occupied), so gaps
 * are how an honest journal looks and failing on them would refuse real
 * resumes.
 */
function classify(known: ReadonlyMap<number, string>, high: number, sequence: number, digest: string): "write" | "skip" | "conflict" {
  const seen = known.get(sequence);
  if (seen !== undefined) return seen === digest ? "skip" : "conflict";
  return sequence < high ? "conflict" : "write";
}

async function appendNewFacts(append: AppendFact, cursor: RecorderCursor, facts: ExecutionProgress,
  onCommittedEnvelope?: (envelope: Envelope) => void): Promise<ProgressWriteOutcome> {
  for (const item of facts.transcript) {
    const digest = digestOf(item);
    const verdict = classify(cursor.items, cursor.highItem, item.sequence, digest);
    if (verdict === "skip") continue;

    if (verdict === "conflict") return { ok: false, code: "progress_sequence_conflict:transcript_item" };

    const result = await append("transcript_item", sessionPayload(item));
    if (!result.ok) return result;

    cursor.items.set(item.sequence, digest);

    if (item.sequence > cursor.highItem) cursor.highItem = item.sequence;
  }

  for (const envelope of facts.envelopes) {
    // Canonical sequence restarts for each attempt; retrying the same turn is
    // not a rewrite of the previous attempt's sequence zero.
    const attemptKey = envelope.attemptId ?? "";
    const attempt = cursor.envelopeAttempts.get(attemptKey) ?? { values: new Map<number, string>(), high: -1 };
    const digest = digestOf(envelope);
    const verdict = classify(attempt.values, attempt.high, envelope.sequence, digest);
    if (verdict === "skip") continue;

    if (verdict === "conflict") return { ok: false, code: "progress_sequence_conflict:envelope" };

    // The private native checkpoint shares the completion fact's durable ack.
    // The public envelope itself is unchanged and cannot expose this payload.
    const checkpoint = envelope.kind === "stream_end" ? cursor.continuation?.capture(cursor.scope) : undefined;
    const measured = facts.promptInputCheckpoint === undefined ? undefined
      : promptInputCheckpointForCompletion(facts.promptInputCheckpoint, envelope, {
        sessionId: cursor.sessionId, turnId: cursor.turnId, attemptId: cursor.streamAttemptId,
        streamIndex: cursor.streamIndex, open: cursor.streamOpen,
      });
    const result = await append("envelope", { envelope: sessionPayload(envelope),
      ...(checkpoint === undefined ? {} : { providerContinuation: checkpoint }),
      ...(measured?.kind === "available" ? { promptInputCheckpoint: sessionPayload(measured.checkpoint) } : {}),
    }, envelope.timestamp);
    if (!result.ok) return result;

    if (envelope.kind === "api_call" && envelope.sessionId === cursor.sessionId && envelope.turnId === cursor.turnId) {
      cursor.streamIndex += 1;
      cursor.streamAttemptId = envelope.attemptId;
      cursor.streamOpen = true;
    }

    if (envelope.kind === "stream_end") cursor.streamOpen = false;

    if (envelope.kind === "observation" && envelope.payload["component"] === "provider") {
      const diagnostic = envelope.payload["diagnostic"];
      if (diagnostic !== null && typeof diagnostic === "object" && !Array.isArray(diagnostic)
        && "noticeId" in diagnostic && typeof diagnostic.noticeId === "string") cursor.continuation?.acknowledgeNotice?.(diagnostic.noticeId);
    }

    attempt.values.set(envelope.sequence, digest);
    attempt.high = Math.max(attempt.high, envelope.sequence);
    cursor.envelopeAttempts.set(attemptKey, attempt);

    notifyCommitted(() => onCommittedEnvelope?.(envelope));
  }

  return { ok: true };
}

function notifyCommitted(observe: () => void): void {
  try { observe(); }
  catch { /* A read-only observer cannot revoke a durable ack or own execution. */ }
}
