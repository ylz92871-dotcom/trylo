import type { ReduceInput } from "../domain/input.js";
import type { TranscriptItem } from "../protocol/transcript.js";
import { appendFailedResult } from "./transcript-append.js";
import { isAcceptedStream } from "./stream-verdict.js";

/** These calls belong only to this rejected response, before tool dispatch.
 * Earlier completed actions remain untouched. Persist explicit failed results
 * so a resume neither leaves orphan calls nor invents uncertain side effects.
 */
export function rejectedStreamToolResults(inputs: ReadonlyArray<ReduceInput>, items: ReadonlyArray<TranscriptItem>): ReadonlyArray<TranscriptItem> {
  if (isAcceptedStream(inputs) || inputs.some(input => input.type === "cancel")) return [];
  let paired = items;
  for (const item of items) {
    if (item.kind !== "tool_call") continue;
    paired = appendFailedResult(paired, item.toolCallId, item.name,
      "stream_not_accepted: This tool was not executed because its provider response was interrupted or rejected before dispatch. " +
      "Continue from the recorded results of earlier commands; do not repeat completed actions.");
  }
  return paired.slice(items.length);
}
