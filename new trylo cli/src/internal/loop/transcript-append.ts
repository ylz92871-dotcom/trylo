import type { ToolResultRecord } from "./tool-execution.js";
import { nextTranscriptSequence } from "./transcript-messages.js";
import type { Transcript } from "../protocol/transcript.js";
import { toolPairingOf } from "../protocol/tool-pairing.js";

/**
 * Appending a tool result to the model-visible transcript.
 *
 * Split out of `runner.ts` (ADR `2026-09-16-ADR-循环迭代间隙开冻` §4.2) so the
 * iteration-gap work could land without growing the frozen file. Pure: the
 * transcript is a value, and the loop stays the only thing that assigns it.
 */

export function appendToolResult(
  transcript: Transcript,
  item: ToolResultRecord,
): Transcript {
  return [
    ...transcript,
    {
      kind: "tool_result",
      sequence: nextTranscriptSequence(transcript),
      toolCallId: item.toolCallId,
      name: item.name,
      output: item.output,
      truncated: item.truncated,
      outcome: item.outcome,
      ...(item.images === undefined ? {} : { images: item.images }),
    },
  ];
}

/** Records a failed tool result so the next provider request can see it. */
export function appendFailedResult(
  transcript: Transcript,
  toolCallId: string,
  name: string,
  text: string,
): Transcript {
  return appendToolResult(transcript, {
    toolCallId,
    name,
    output: text,
    truncated: false,
    outcome: "failed",
  });
}

/**
 * The text a cancelled call carries, so the model is told why it has no output.
 *
 * It states what is known and nothing more. An earlier version ended "Nothing it
 * was going to do was applied." That was false for every long-running tool:
 * `run_shell` is stopped by actually killing the process tree
 * (`adapters/tools/call-cancellation.ts` + `process-session/process-tree.ts`), so
 * a build or a script may have written files before the kill landed. Telling the
 * model "nothing was applied" invites it to re-run as if the world were untouched,
 * which is the one conclusion a cancellation must not encourage.
 */
export const CANCELLED_TOOL_RESULT_TEXT =
  "Cancelled by the user before this tool finished. It may have had partial effects; " +
  "check the working tree before re-running it.";

/**
 * What is missing: the ids asked for, and the ids already answered.
 *
 * Re-exported from `protocol/tool-pairing.ts`, which is the single owner of the
 * rule. This file used to answer "by id" — one call per id — while
 * `adapters/session-store/transcript-purge.ts` answered "by position"; on
 * `tool_call(x) / tool_result(x) / tool_call(x)` the first hid an orphan that the
 * second found, which is the one case L04 exists to catch. That file's rule won,
 * because `durable-ordinals.test.ts:16` already pins it. The re-export keeps
 * every existing caller of this module working unchanged.
 */
export type { ToolPairing } from "../protocol/tool-pairing.js";
export { toolPairingOf } from "../protocol/tool-pairing.js";

/**
 * Pair every unanswered `tool_use` with a result saying it was cancelled.
 *
 * # Why this must exist
 *
 * A cancelled turn can leave the transcript holding `tool_use` blocks that no
 * `tool_result` ever answers. The legacy runtime had a dedicated function for
 * exactly this — `yieldMissingToolResultBlocks` in `trylo cli/src/query.ts:124`,
 * called on the abort path — because a `tool_use` without a matching
 * `tool_result` is an invalid request for most providers, and the next turn
 * after an interrupt would be rejected outright.
 *
 * It was missing here. Measured in
 * `evidence/2026-10-05-WP07/probe-l04-orphan-tool-use.mjs`: cancelling a turn
 * whose stream had already emitted two `tool_call` blocks produced a transcript
 * of `[user, tool_call, tool_call]` — two orphans, zero results.
 *
 * # What it does *not* claim
 *
 * The synthetic result says the call was cancelled. It does not say the tool
 * succeeded, and it does not invent output: `outcome: "cancelled"` with empty
 * output is the honest shape, and a caller reading it back can tell the
 * difference between "this produced nothing" and "this was stopped".
 */
export function pairCancelledToolCalls(transcript: Transcript): Transcript {
  const orphans = toolPairingOf(transcript).orphans;
  if (orphans.length === 0) {
    return transcript;
  }

  const names = new Map<string, string>();

  for (const item of transcript) {
    if (item.kind === "tool_call") {
      names.set(item.toolCallId, item.name);
    }
  }

  let next = transcript;

  for (const toolCallId of orphans) {
    next = appendToolResult(next, {
      toolCallId,
      name: names.get(toolCallId) ?? "unknown_tool",
      output: CANCELLED_TOOL_RESULT_TEXT,
      truncated: false,
      outcome: "cancelled",
    });
  }

  return next;
}
