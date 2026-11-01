import type { JsonObject } from "../../protocol/envelope.js";

/** Provider-facing tool knowledge is separate from an executable source module. */
export type ToolRuntimeDescriptor = {
  readonly identity: string; readonly description: string; readonly inputSchema: JsonObject;
  readonly mastery: { readonly whenToUse: readonly string[]; readonly preconditions: readonly string[]; readonly pitfalls: readonly string[] };
};
