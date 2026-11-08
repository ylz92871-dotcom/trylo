import { createHash } from "node:crypto";
import type { Transcript } from "../protocol/transcript.js";
import type { JsonObject } from "../protocol/envelope.js";
import type { ToolExecutionFact } from "./tool-gap-port.js";
import type { ToolPort } from "../ports/tools.js";

/** Missing metadata stays unknown; a failed catalog read cannot invent an asset version. */
export function toolVersionsOf(tools: ToolPort): ReadonlyMap<string, string> {
  try { return new Map(tools.snapshot().flatMap(tool => tool.versionId === undefined ? [] : [[tool.name, tool.versionId] as const])); }
  catch { return new Map(); }
}

/** Project each settled call once per beat; never persist raw user arguments or output. */
export function projectToolExecutions(transcript: Transcript, fingerprint: (args: JsonObject) => string,
  failureCode: (text: string) => string | undefined, versions: ReadonlyMap<string, string> = new Map()): readonly ToolExecutionFact[] {
  const results: Extract<Transcript[number], { kind: "tool_result" }>[] = [];

  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (item?.kind !== "tool_result") break;
    results.unshift(item);
  }

  const calls = new Map(transcript.flatMap(item => item.kind === "tool_call" ? [[item.toolCallId, item] as const] : []));

  return results.flatMap(item => {
    const call = calls.get(item.toolCallId);
    if (call === undefined || call.name !== item.name) return [];

    const code = item.outcome === "failed" ? failureCode(item.output) : undefined;
    const execution = item.outcome === "succeeded" ? "returned" : item.outcome === "cancelled" ? "cancelled"
      : item.outcome === "unknown" ? "unavailable" : code?.includes("timeout") ? "timeout"
        : code?.includes("protocol") ? "protocol_error" : "tool_error";

    return [{ tool: item.name, toolCallId: item.toolCallId, inputHash: fingerprint(call.arguments),
      ...(versions.get(item.name) === undefined ? {} : { versionId: versions.get(item.name)! }),
      outputHash: createHash("sha256").update(item.output, "utf8").digest("hex"), execution }];
  });
}
