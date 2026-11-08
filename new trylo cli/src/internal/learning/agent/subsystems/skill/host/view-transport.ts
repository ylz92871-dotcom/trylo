import { MAX_TOOL_OUTPUT_BYTES } from "../../../../../loop/tool-execution.js";
import type { HermesToolProfile } from "./client.js";

export const HERMES_VIEW_MAX_BYTES_ENV = "TRYLO_HERMES_VIEW_MAX_BYTES";

/** The native view must fit the same output envelope the execution loop applies. */
export function withHermesViewTransportBudget(profile: HermesToolProfile): HermesToolProfile {
  return { ...profile, env: Object.freeze({ ...profile.env, [HERMES_VIEW_MAX_BYTES_ENV]: String(MAX_TOOL_OUTPUT_BYTES) }) };
}

/** A full native JSON reply can still be cut later by the loop's UTF-8 ceiling. */
export function isCompleteHermesViewOutput(reply: { readonly output: string; readonly truncated: boolean }): boolean {
  return !reply.truncated && Buffer.byteLength(reply.output, "utf8") <= MAX_TOOL_OUTPUT_BYTES;
}
