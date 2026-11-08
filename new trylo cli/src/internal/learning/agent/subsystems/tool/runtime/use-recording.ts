import { withBoardWriter } from "../../../../../adapters/learning-store/file-event-store.js";
import type { ToolUseRecord } from "../domain/evolution/use.js";

/** An executed tool is never replayed to resolve Board contention. Retry only
 * its exact immutable observation command; the canonical writer admits and
 * deduplicates it, including an append whose acknowledgement was lost. */
export async function recordFrozenToolUse(options: { readonly boardRoot: string; readonly warn: (message: string) => void },
  record: ToolUseRecord, signal: AbortSignal) {
  const command = { type: "record_tool_use" as const, commandId: `tool-use:${record.useId}`, issuedAt: record.occurredAt, record };
  const write = () => withBoardWriter(options.boardRoot, store => store.apply(command), { admission: { signal } });
  let saved = await write();
  if (!saved.ok && saved.reason === "multi_writer" && !signal.aborted) {
    options.warn(`tool_use_recording_waiting:multi_writer:${record.useId}`);
    // Admission already waits with backpressure. There is no private retry
    // count or deadline which can discard a completed invocation's evidence.
    while (!saved.ok && saved.reason === "multi_writer" && !signal.aborted) saved = await write();
  }

  return saved;
}
