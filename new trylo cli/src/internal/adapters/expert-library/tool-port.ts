import type { ToolLibrary, ToolLibraryContext } from "../../tooling/library/index.js";
import { ExpertLibraryError, type ExpertToolPort } from "../../subagent/experts/index.js";

/** Resolve only through the real tool library's public API, under trusted member/task context. */
export function createToolLibraryExpertPort(library: ToolLibrary, context: ToolLibraryContext): ExpertToolPort {
  return { async resolve(refs, signal) {
    if (signal.aborted) throw new ExpertLibraryError("cancelled", "Expert tool resolution was cancelled");

    const result = await library.resolve(context, refs);

    if (signal.aborted) throw new ExpertLibraryError("cancelled", "Expert tool resolution was cancelled");

    if (!result.ok) return refs.map(ref => ({ ref, state: "pending" as const, reason: `${result.code}: ${result.message}` }));

    return refs.map(ref => {
      const reference = result.value.references.find(item => item.toolId === ref);
      if (reference !== undefined) return { ref, state: "resolved" as const, toolNames: [reference.runtimeName] };
      return { ref, state: "unavailable" as const,
        reason: result.value.rejected.find(item => item.toolId === ref)?.code ?? "tool_reference_not_resolved" };
    });
  } };
}
