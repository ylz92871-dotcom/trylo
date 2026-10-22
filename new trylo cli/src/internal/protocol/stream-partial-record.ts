import type { JsonObject } from "./envelope.js";
import { isStreamPartial, streamPartialPayload, type StreamPartial } from "./stream-partial.js";

/** V1 snapshots remain readable. V2 deltas omit `text`, so older readers
 * reject them instead of silently displaying a suffix as the whole block.
 * Offsets count UTF-16 code units, matching string.slice on both sides.
 */
export function partialRecordPayload(next: StreamPartial, previous?: StreamPartial): JsonObject | undefined {
  if (previous === undefined || next.name !== previous.name || next.redacted !== previous.redacted
    || !next.text.startsWith(previous.text)) return streamPartialPayload(next);
  if (next.text === previous.text) return undefined;
  return {
    version: "2", kind: next.kind, blockId: next.blockId,
    offset: previous.text.length, textDelta: next.text.slice(previous.text.length),
    ...(next.name === undefined ? {} : { name: next.name }),
    ...(next.redacted === undefined ? {} : { redacted: next.redacted }),
  };
}

/** Redact the complete snapshot before computing a suffix. Redaction can
 * replace an earlier prefix as a secret/path finishes arriving; that emits
 * a new V1 snapshot rather than leaking its unredacted trailing characters.
 */
export function sanitizedPartial(partial: StreamPartial): StreamPartial {
  const payload = streamPartialPayload(partial);
  if (!isStreamPartial(payload)) throw new Error("invalid stream partial snapshot");
  return payload;
}

export function readPartialRecord(payload: JsonObject, previous?: StreamPartial): StreamPartial | undefined {
  if (payload.version !== "2") {
    return (payload.version === undefined || payload.version === "1") && isStreamPartial(payload) ? payload : undefined;
  }
  if (Object.hasOwn(payload, "text") || !Number.isSafeInteger(payload.offset) || typeof payload.offset !== "number"
    || payload.offset < 0 || typeof payload.textDelta !== "string" || previous === undefined
    || payload.offset !== previous.text.length || payload.kind !== previous.kind || payload.blockId !== previous.blockId
    || payload.name !== previous.name || payload.redacted !== previous.redacted) return undefined;
  return { ...previous, text: previous.text + payload.textDelta };
}
