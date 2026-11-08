import type { ToolPort } from "../../ports/tools.js";

/** Catalog selection is a capability ceiling, never an approval grant. */
export function parseToolSelection(raw: string):
  | { readonly ok: true; readonly names: readonly string[] }
  | { readonly ok: false; readonly message: string } {
  if (raw === "none") return { ok: true, names: [] };

  const names = raw.split(",").map(name => name.trim());
  if (names.some(name => !/^[A-Za-z0-9_-]+$/.test(name))) {
    return { ok: false, message: "--tools needs whole tool names separated by commas, or none; empty entries and patterns are not allowed" };
  }

  if (new Set(names).size !== names.length) {
    return { ok: false, message: "--tools must not repeat a tool name" };
  }

  return { ok: true, names };
}

/** Preserve the original port on default paths. Both advertisement and actual
 * dispatch obey the same immutable selection; guessing a hidden name cannot
 * reach the original executor. Cancellation still reaches existing resources.
 */
export function selectToolPort(tools: ToolPort, names: readonly string[] | undefined): ToolPort {
  if (names === undefined) return tools;

  const selected = new Set(names);

  return {
    snapshot: () => tools.snapshot().filter(binding => selected.has(binding.name)),

    async execute(call, signal) {
      if (!selected.has(call.name) || !tools.snapshot().some(binding => binding.name === call.name)) {
        return { outcome: "unknown", code: "unknown_tool", message: `tool ${call.name} is not in the selected catalog` };
      }
      return tools.execute(call, signal);
    },

    cancel: id => tools.cancel(id),
  };
}

/** Runtime mounts decide existence; the argument parser cannot guess MCP/LSP
 * or optional tool availability. Call before any provider request is sent.
 */
export function missingSelectedTools(tools: ToolPort, names: readonly string[] | undefined): readonly string[] {
  if (names === undefined) return [];
  const mounted = new Set(tools.snapshot().map(binding => binding.name));
  return names.filter(name => !mounted.has(name));
}
