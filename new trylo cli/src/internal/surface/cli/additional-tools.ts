import { cancelToolPorts } from "../../ports/tool-cancellation.js";
import type { ToolPort } from "../../ports/tools.js";

/** Unlike the MCP router, this router owns only exact names, never a prefix. */
export function composeAdditionalTools(existing: ToolPort, additional: ToolPort): ToolPort {
  const names = new Set(additional.snapshot().map(binding => binding.name));
  return {
    snapshot: () => [...existing.snapshot(), ...additional.snapshot()],
    execute: (call, signal) => names.has(call.name) ? additional.execute(call, signal) : existing.execute(call, signal),
    cancel: async id => { await cancelToolPorts([existing, additional], id); },
  };
}
