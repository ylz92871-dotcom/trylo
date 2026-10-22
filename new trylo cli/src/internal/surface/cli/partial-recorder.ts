import type { JsonObject } from "../../protocol/envelope.js";
import { partialKey, type StreamPartial, type StreamPartials } from "../../protocol/stream-partial.js";
import { partialRecordPayload, sanitizedPartial } from "../../protocol/stream-partial-record.js";
import type { ProgressWriteOutcome } from "../../ports/execution-progress.js";

/** One turn's acknowledged partials. Failed writes never advance the prefix;
 * unchanged parallel blocks produce no redundant records. No second store.
 */
export function createPartialRecorder(append: (payload: JsonObject) => Promise<ProgressWriteOutcome>) {
  const durable = new Map<string, StreamPartial>();
  return async (partials: StreamPartials): Promise<ProgressWriteOutcome> => {
    const live = new Set<string>();
    for (const partial of partials) {
      const key = partialKey(partial);
      live.add(key);
      const next = sanitizedPartial(partial);
      const payload = partialRecordPayload(next, durable.get(key));
      if (payload === undefined) continue;
      const result = await append(payload);
      if (!result.ok) return result;
      durable.set(key, next);
    }
    for (const key of durable.keys()) if (!live.has(key)) durable.delete(key);
    return { ok: true };
  };
}
