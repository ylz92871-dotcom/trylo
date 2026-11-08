import { contentHashOf } from "../../learning/control/hash.js";
import { isCentralLearningSourceContext, type CentralLearningContextReader, type CentralLearningSourceContext } from "../../learning/control/source-context.js";

/** The producer's full packet cap is independent of a domain's smaller executable prompt envelope. */
export async function readCentralStageContext(reader: CentralLearningContextReader | undefined, issueId: string): Promise<
  { readonly status: "ready"; readonly context: CentralLearningSourceContext | undefined }
  | { readonly status: "rejected"; readonly reason: string }> {
  const value = await reader?.(issueId);
  if (value === undefined) return { status: "ready", context: undefined };
  return isCentralLearningSourceContext(value)
    ? { status: "ready", context: { ref: value.ref, text: value.text } }
    : { status: "rejected", reason: "central_stage_source_context_invalid" };
}

export function centralStageContextIdentity(context: CentralLearningSourceContext | undefined) {
  return context === undefined ? null : { ref: context.ref, textHash: contentHashOf(context.text) };
}
