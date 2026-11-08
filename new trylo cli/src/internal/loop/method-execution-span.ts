import type { Transcript } from "../protocol/transcript.js";
import { toolCallIndexByResult } from "../protocol/tool-pairing.js";
import type { MethodExecutionSpan } from "./method-port.js";

const MAX_SPAN_TOOL_NAMES = 64;

/** Local canonical high-water, not a session-global clock. */
export function methodRequestBoundary(transcript: Transcript | undefined): number | undefined {
  if (transcript === undefined || transcript.length === 0) return undefined;

  let maximum = -1;

  for (const item of transcript) {
    if (!ordinal(item.sequence)) return undefined;
    maximum = Math.max(maximum, item.sequence);
  }

  return maximum;
}

/** The complete trailing result batch and its canonical positional pairs.
 * Missing pairs or oversized metadata remain unassociated.
 * Outcomes do not filter names: even a cancelled context switch is ambiguous. */
export function methodExecutionSpan(transcript: Transcript): MethodExecutionSpan | undefined {
  let start = transcript.length;

  while (start > 0 && transcript[start - 1]?.kind === "tool_result") start--;

  if (start === transcript.length) return undefined;

  const paired = toolCallIndexByResult(transcript), names = new Set<string>();
  let firstSequence = Number.POSITIVE_INFINITY, lastSequence = -1;

  for (let index = start; index < transcript.length; index++) {
    const result = transcript[index], callIndex = paired.get(index);
    if (result?.kind !== "tool_result" || !ordinal(result.sequence) || callIndex === undefined) return undefined;

    const call = transcript[callIndex];
    if (call?.kind !== "tool_call" || call.name !== result.name || !ordinal(call.sequence) || call.sequence >= result.sequence) return undefined;

    names.add(result.name);

    if (names.size > MAX_SPAN_TOOL_NAMES) return undefined;

    firstSequence = Math.min(firstSequence, call.sequence, result.sequence);
    lastSequence = Math.max(lastSequence, call.sequence, result.sequence);
  }

  return { firstSequence, lastSequence, toolNames: [...names] };
}

/** Recovery can append a user turn or control-only batch after the last real
 * business result. Find that complete batch without interpreting its output. */
export function previousMethodExecutionSpan(transcript: Transcript): MethodExecutionSpan | undefined {
  let end = transcript.length;

  while (end > 0) {
    while (end > 0 && transcript[end - 1]?.kind !== "tool_result") end--;

    if (end === 0) return undefined;

    let start = end;

    while (start > 0 && transcript[start - 1]?.kind === "tool_result") start--;

    if (transcript.slice(start, end).some(item => item.kind === "tool_result" && item.name !== "method_context")) {
      return methodExecutionSpan(transcript.slice(0, end));
    }

    end = start;
  }

  return undefined;
}

function ordinal(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
