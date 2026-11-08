import type { PromptInputCheckpoint } from "../ports/prompt-input.js";
import type { SessionRecord } from "../ports/session.js";
import { isStoredPromptInputBasisV1 } from "./prompt-input-basis.js";

export type PromptInputCheckpointRecovery =
  | { readonly kind: "absent" }
  | { readonly kind: "available"; readonly checkpoint: PromptInputCheckpoint }
  | { readonly kind: "unavailable"; readonly reason: "invalid_checkpoint" | "checkpoint_binding_mismatch"
      | "checkpoint_stream_mismatch" | "checkpoint_completion_missing" };

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCheckpoint(value: unknown): value is PromptInputCheckpoint {
  if (!object(value) || Object.keys(value).sort().join(",") !== "attemptId,basis,sessionId,streamIndex,turnId,version") return false;
  return value.version === 1 && typeof value.sessionId === "string" && value.sessionId.length > 0
    && typeof value.turnId === "string" && value.turnId.length > 0 && typeof value.attemptId === "string" && value.attemptId.length > 0
    && typeof value.streamIndex === "number" && Number.isSafeInteger(value.streamIndex) && value.streamIndex > 0
    && isStoredPromptInputBasisV1(value.basis);
}

type CompletionIdentity = { readonly sessionId: string; readonly turnId: string; readonly attemptId: string | undefined;
  readonly streamIndex: number; readonly open: boolean };

type CompletionEnvelope = { readonly kind: string; readonly payload: Readonly<Record<string, unknown>>;
  readonly sessionId?: string; readonly turnId?: string; readonly attemptId?: string };

/** A synthetic logical close (no provider finish reason) is not an accepted
 * measured response. Truncation still measured the input it accepted. */
export function promptInputCheckpointForCompletion(value: unknown, envelope: CompletionEnvelope,
  identity: CompletionIdentity): PromptInputCheckpointRecovery {
  if (!isCheckpoint(value)) return { kind: "unavailable", reason: "invalid_checkpoint" };

  if (envelope.kind !== "stream_end" || !identity.open
    || !["stop", "tool_calls", "length"].includes(String(envelope.payload.reason))) {
    return { kind: "unavailable", reason: "checkpoint_completion_missing" };
  }

  if (value.sessionId !== identity.sessionId || value.turnId !== identity.turnId || value.attemptId !== identity.attemptId
    || envelope.sessionId !== identity.sessionId || envelope.turnId !== identity.turnId || envelope.attemptId !== value.attemptId) {
    return { kind: "unavailable", reason: "checkpoint_binding_mismatch" };
  }

  if (value.streamIndex !== identity.streamIndex) return { kind: "unavailable", reason: "checkpoint_stream_mismatch" };

  return { kind: "available", checkpoint: structuredClone(value) };
}

type StreamCursor = { count: number; attemptId: string | undefined; open: boolean };

/** Optional metadata never repairs or rejects canonical history. A latest bad
 * extension stays unavailable instead of silently reviving an older report. */
export function recoverPromptInputCheckpoint(records: readonly SessionRecord[], sessionId: string): PromptInputCheckpointRecovery {
  let recovered: PromptInputCheckpointRecovery = { kind: "absent" };
  const turns = new Map<string, StreamCursor>();

  for (const record of records) {
    // The journal codec proves checksums/order, not optional payload shapes.
    const payload: unknown = record.payload;
    if (!object(payload)) {
      recovered = { kind: "unavailable", reason: "invalid_checkpoint" };
      continue;
    }

    if (record.type === "turn_start" && record.sessionId === sessionId && record.turnId !== undefined) {
      turns.set(record.turnId, { count: 0, attemptId: undefined, open: false });
    }

    const rawEnvelope = payload.envelope;
    const envelope = object(rawEnvelope) ? rawEnvelope : undefined;
    const turn = record.turnId === undefined ? undefined : turns.get(record.turnId);
    const bound = record.type === "envelope" && envelope !== undefined && record.sessionId === sessionId
      && envelope.sessionId === sessionId && envelope.turnId === record.turnId;
    if (bound && envelope.kind === "api_call" && turn !== undefined) {
      turn.count += 1;
      turn.attemptId = typeof envelope.attemptId === "string" ? envelope.attemptId : undefined;
      turn.open = true;
    }

    if ("promptInputCheckpoint" in payload) {
      if (!bound || envelope === undefined || turn === undefined || record.turnId === undefined || !object(envelope.payload)) {
        recovered = { kind: "unavailable", reason: "checkpoint_binding_mismatch" };
      } else {
        recovered = promptInputCheckpointForCompletion(payload.promptInputCheckpoint, {
          kind: typeof envelope.kind === "string" ? envelope.kind : "", payload: envelope.payload,
          ...(typeof envelope.sessionId === "string" ? { sessionId: envelope.sessionId } : {}),
          ...(typeof envelope.turnId === "string" ? { turnId: envelope.turnId } : {}),
          ...(typeof envelope.attemptId === "string" ? { attemptId: envelope.attemptId } : {}),
        }, { sessionId, turnId: record.turnId, attemptId: turn.attemptId, streamIndex: turn.count, open: turn.open });
      }
    }

    if (bound && envelope.kind === "stream_end" && turn !== undefined) turn.open = false;
  }

  return recovered;
}
