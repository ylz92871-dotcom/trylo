import type { ToolBinding, ToolPort } from "../../ports/tools.js";
import { stableJson } from "../../ports/permission.js";
import { createHash } from "node:crypto";
import type { ToolLibraryAccess, ToolLibraryEntry, ToolResolution, ToolRuntimeReference } from "./contracts.js";

export const runtimeToolId = (name: string): string => `runtime:${name}`;

// Freeze execution-relevant fields so a changed binding invalidates old references.
export function bindingHash(binding: ToolBinding): string {
  return createHash("sha256").update(stableJson({ name: binding.name, description: binding.description, sideEffect: binding.sideEffect,
    parallelSafe: binding.parallelSafe ?? false, parameters: binding.parameters, needsApproval: binding.needsApproval,
    ...(binding.timeoutMs === undefined ? {} : { timeoutMs: binding.timeoutMs }), outputLimits: { ...binding.outputLimits } })).digest("hex");
}

export function configurationBlock(entry: ToolLibraryEntry, access: ToolLibraryAccess): string | undefined {
  if (entry.availability.state !== "available") return entry.availability.reason;
  const name = entry.runtimeName;
  if (name === undefined || !access.tools.snapshot().some(binding => binding.name === name)) return "runtime_not_mounted";
  if (access.allowedNames !== undefined && !access.allowedNames.includes(name)) return "outside_task_scope";
  if (access.permission.isDenied?.(name)) return "permission_denied";
  return undefined;
}

/** Dispatch and advertisement share a ceiling; recheck current policy and binding before every call. */
export function resolveEntries(entries: readonly ToolLibraryEntry[], access: ToolLibraryAccess, ids: readonly string[]): ToolResolution {
  const rejected: { toolId: string; code: string }[] = [], references: ToolRuntimeReference[] = [];

  for (const toolId of new Set(ids)) {
    const entry = entries.find(item => item.id === toolId);
    const code = entry === undefined ? "tool_not_found" : configurationBlock(entry, access);
    if (entry === undefined || code !== undefined) {
      rejected.push({ toolId, code: code ?? "tool_not_found" });
      continue;
    }
    const binding = access.tools.snapshot().find(item => item.name === entry.runtimeName);
    if (binding === undefined) {
      rejected.push({ toolId, code: "runtime_not_mounted" });
      continue;
    }
    references.push({ toolId, runtimeName: binding.name, bindingHash: bindingHash(binding) });
  }

  // Recheck live policy and binding identity for both advertisement and dispatch.
  const current = (name: string) => {
    if (access.permission.isDenied?.(name) || (access.allowedNames !== undefined && !access.allowedNames.includes(name))) return undefined;
    const ref = references.find(item => item.runtimeName === name), binding = access.tools.snapshot().find(item => item.name === name);
    return ref !== undefined && binding !== undefined && ref.bindingHash === bindingHash(binding) ? binding : undefined;
  };
  const tools: ToolPort = {
    snapshot: () => references.flatMap(ref => {
      const binding = current(ref.runtimeName);
      return binding === undefined ? [] : [binding];
    }),
    execute: (call, signal) => signal.aborted ? Promise.resolve({ outcome: "cancelled" })
      : current(call.name) === undefined ? Promise.resolve({ outcome: "error", code: "tool_reference_unavailable", message: "tool selection, binding or permission changed; resolve again" })
        : access.tools.execute(call, signal),
    cancel: id => access.tools.cancel(id),
  };

  return { references, rejected, tools };
}
