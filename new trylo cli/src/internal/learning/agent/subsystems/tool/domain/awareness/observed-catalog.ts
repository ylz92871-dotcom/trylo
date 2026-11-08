import { isDigest } from "../evolution/artifact.js";
import { keysAre, recordOf, textOf } from "../evolution/parse.js";

/** Historical visibility is evidence, not a current runtime reference or permission. */
export type ToolObservedCapability = { readonly tool: string; readonly description: string; readonly bindingHash: string; readonly versionId?: string };

export function decodeToolObservedCapability(raw: unknown): ToolObservedCapability | undefined {
  return recordOf(raw) && keysAre(raw, ["tool", "description", "bindingHash"], ["versionId"])
    && textOf(raw.tool, 256) && textOf(raw.description, 1024) && isDigest(raw.bindingHash)
    && (raw.versionId === undefined || textOf(raw.versionId, 160))
    ? { tool: raw.tool, description: raw.description, bindingHash: raw.bindingHash,
      ...(raw.versionId === undefined ? {} : { versionId: raw.versionId }) } : undefined;
}
