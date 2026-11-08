import type { Envelope } from "../../protocol/envelope.js";
import type { TranscriptItem } from "../../protocol/transcript.js";
import { isPlainRecord } from "../../integration/shared/validate.js";

/** Canonical adapter termination proof, never a statement in checker stdout. */
export function actualSkillCheckExit(result: Extract<TranscriptItem, { readonly kind: "tool_result" }>, event: Envelope | undefined): number | undefined {
  if (!event || event.kind !== "tool_result" || event.payload.toolCallId !== result.toolCallId || result.name !== "run_shell"
    || result.truncated || event.payload.status !== result.outcome) return undefined;

  if (result.outcome === "succeeded") {
    const value = event.payload.value;
    return isPlainRecord(value) && value.exitCode === 0 && event.payload.output === result.output && event.payload.truncated === false ? 0 : undefined;
  }

  if (result.outcome !== "failed" || typeof event.payload.message !== "string" || event.payload.message !== result.output) return undefined;

  // The loop persists failureText(adapter.code, adapter.message) in this
  // canonical field. ShellSpawn's unknown/signal exit -1 is not a check result.
  const matched = /^shell_nonzero_exit:([1-9]\d*)\n/.exec(event.payload.message);
  if (!matched) return undefined;

  const exit = Number(matched[1]);

  return Number.isSafeInteger(exit) && exit > 0 ? exit : undefined;
}
