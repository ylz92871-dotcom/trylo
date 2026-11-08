import type { ToolPort } from "../ports/tools.js";

/** Library binding checks precede the original runtime boundary; effects never bypass inherited permission or sandbox. */
export function dispatchToolPort(original: ToolPort, selected: ToolPort): ToolPort {
  const available = (name: string) => selected.snapshot().some(tool => tool.name === name)
    && original.snapshot().some(tool => tool.name === name);
  return {
    snapshot: () => original.snapshot().filter(tool => available(tool.name)),
    execute: (call, signal) => signal.aborted ? Promise.resolve({ outcome: "cancelled" })
      : !available(call.name) ? Promise.resolve({ outcome: "error", code: "tool_reference_unavailable", message: "The frozen dispatch selection or binding is no longer available" })
        : original.execute(call, signal),
    cancel: toolCallId => original.cancel(toolCallId),
  };
}
