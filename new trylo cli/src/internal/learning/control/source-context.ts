import { fields, identity, text } from "../../validation/json-shape.js";

/** Public source-bound analysis handed to a learning stage. It is neither an
 * external verification verdict nor a permission or numeric value label.
 * Keep the immutable reference paired with the full supplied text; capacity
 * failures must remain explicit rather than silently removing conditions. */
export type CentralLearningSourceContext = { readonly ref: string; readonly text: string };

export type CentralLearningContextReader = (issueId: string) => Promise<CentralLearningSourceContext | undefined>;

/** Producer packet capacity is distinct from a domain's executable prompt envelope. */
export function isCentralLearningSourceContext(value: unknown): value is CentralLearningSourceContext {
  return fields(value, ["ref", "text"]) && identity(value.ref) && text(value.text, 65536);
}
