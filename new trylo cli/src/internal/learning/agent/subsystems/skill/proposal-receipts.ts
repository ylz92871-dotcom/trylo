import type { Transcript } from "../../../../protocol/transcript.js";
import type { JsonObject } from "../../../../protocol/envelope.js";
import type { SkillProposalReceipt } from "./review-process.js";
import { toolCallIndexByResult } from "../../../../protocol/tool-pairing.js";

/** Attribute only successful native stage receipts, never the model's answer. */
export function skillProposalReceipts(transcript: Transcript): readonly SkillProposalReceipt[] {
  const calls = toolCallIndexByResult(transcript);
  return transcript.flatMap((item, index) => {
    if (item.kind !== "tool_result" || item.outcome !== "succeeded" || item.truncated || !/(?:^|__)skill_propose$/.test(item.name)) return [];
    const call = transcript[calls.get(index) ?? -1];
    if (call?.kind !== "tool_call" || call.name !== item.name) return [];
    const receipt = skillProposalReceipt(call, item.output);
    return receipt === undefined ? [] : [receipt];
  });
}

/** The mounted native client can retain this exact reply before a later model
 * failure prevents the loop from returning its complete transcript. */
export function skillProposalReceipt(call: { readonly name: string; readonly arguments: JsonObject }, output: string): SkillProposalReceipt | undefined {
  if (!/(?:^|__)skill_propose$/.test(call.name) || typeof call.arguments.name !== "string" || typeof call.arguments.action !== "string") return undefined;

  let native: unknown;

  try { native = JSON.parse(output); }
  catch { return undefined; }

  if (typeof native !== "object" || native === null || !("success" in native) || native.success !== true
    || !("staged" in native) || native.staged !== true || !("pending_id" in native) || typeof native.pending_id !== "string" || !native.pending_id) return undefined;

  return { pendingId: native.pending_id, name: call.arguments.name, action: call.arguments.action };
}

/** A completed model response cannot hide an unavailable native tool path. */
export function skillReviewToolFailures(transcript: Transcript): number {
  return transcript.filter(item => {
    if (item.kind !== "tool_result") return false;
    if (item.outcome !== "succeeded" || item.truncated) return true;
    try {
      const body: unknown = JSON.parse(item.output);
      return typeof body === "object" && body !== null && "success" in body && body.success === false;
    } catch { return true; /* Every mounted Hermes tool has an original JSON result contract. */ }
  }).length;
}
