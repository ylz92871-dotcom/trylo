import { isTranscriptItem, type TranscriptItem } from "../../protocol/transcript.js";
import { isStreamPartial, latestPartials, partialKey, type StreamPartial } from "../../protocol/stream-partial.js";
import { readPartialRecord } from "../../protocol/stream-partial-record.js";
import {
  isRuntimeFingerprint,
  type PendingEffect,
  type RecoveryOutcome,
  type RuntimeFingerprint,
  type SessionRecord,
} from "../../ports/session.js";

/**
 * Folds validated records into the resumable projection.
 *
 * Pure on purpose: the store has already proven the bytes, so this is a
 * projection with nothing left to doubt. A journal without `session_start` has
 * no fingerprint to resume against and is therefore incomplete, not empty.
 *
 * The byte-level checks (checksum, sequence, version) prove the journal was
 * written by a writer of this format; they cannot prove the *payload* of every
 * record still matches its type. Payloads are validated here, once, at the
 * boundary — a wrong-shaped payload is corruption and fails closed, never a
 * partially projected value: `isTranscriptItem` and `isRuntimeFingerprint`
 * replace what would otherwise be blind casts.
 *
 * `effect_issued` without a matching `effect_committed` is reported as
 * `reconcileRequired` rather than resolved here: deciding what an unfinished
 * effect means belongs to the caller that owns the effect, not to the reader of
 * the journal.
 */
export function recover(records: readonly SessionRecord[], tornTail: boolean): RecoveryOutcome {
  const transcript: TranscriptItem[] = [];
  const partials = new Map<string, StreamPartial>();
  let fingerprint: RuntimeFingerprint | undefined;
  let sessionId = "";
  // Keyed by identity, valued by the journal sequence of the *issue*: the only
  // locator a later settlement can name unambiguously.
  const issued = new Map<string, PendingEffect>();
  const settled = new Set<string>();

  for (const record of records) {
    sessionId = record.sessionId;
    switch (record.type) {
      case "session_start": {
        if (!isRuntimeFingerprint(record.payload.fingerprint)) {
          return {
            ok: false,
            code: "mid_file_corruption",
            detail: "session_start payload is not a runtime fingerprint",
          };
        }
        fingerprint = record.payload.fingerprint;
        break;
      }
      case "transcript_item": {
        if (!isTranscriptItem(record.payload)) {
          return {
            ok: false,
            code: "mid_file_corruption",
            detail: `transcript_item payload at sequence ${record.sequence} is not a transcript item`,
          };
        }
        transcript.push(record.payload);
        break;
      }
      case "stream_partial": {
        const identity = { ...record.payload, text: "" };
        if (!isStreamPartial(identity)) {
          return { ok: false, code: "mid_file_corruption", detail: `invalid stream_partial identity at sequence ${record.sequence}` };
        }
        const key = partialKey(identity, record.turnId);
        const partial = readPartialRecord(record.payload, partials.get(key));
        if (partial === undefined) {
          return {
            ok: false,
            code: "mid_file_corruption",
            detail: `stream_partial payload at sequence ${record.sequence} is not a stream partial`,
          };
        }
        partials.set(partialKey(partial, record.turnId), partial);
        break;
      }
      case "effect_issued":
      case "effect_committed":
      case "effect_failed":
      case "effect_unknown": {
        const key = record.payload.key;
        if (typeof key !== "string" || key.length === 0) {
          return { ok: false, code: "mid_file_corruption", detail: `invalid effect identity at sequence ${record.sequence}` };
        }
        // v1 already carries turnId. Scope the fold without rewriting old bytes
        // or changing the diagnostic key exposed by RecoveredSession.
        const identity = JSON.stringify([record.turnId ?? null, key]);
        if (record.type === "effect_issued") {
          issued.set(identity, {
            ...(record.turnId === undefined ? {} : { turnId: record.turnId }),
            key,
            issuedAtSequence: record.sequence,
            issuedAt: record.at,
          });
          settled.delete(identity);
        } else if (record.type === "effect_unknown") {
          settled.delete(identity);
        } else {
          settled.add(identity);
        }
        break;
      }
      default:
        break;
    }
  }

  if (fingerprint === undefined) {
    return { ok: false, code: "mid_file_corruption", detail: "missing session_start" };
  }
  const last = records[records.length - 1];
  const pendingEffects = [...issued].filter(([identity]) => !settled.has(identity)).map(([, effect]) => effect);
  return {
    ok: true,
    session: {
      sessionId,
      fingerprint,
      transcript,
      lastSequence: last?.sequence ?? 0,
      reconcileRequired: pendingEffects.map(effect => effect.key),
      pendingEffects,
      partials: latestPartials([...partials.values()]),
      repairedTornTail: tornTail,
    },
  };
}
