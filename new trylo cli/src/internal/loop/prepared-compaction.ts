import type { ProviderRequest, ProviderRequestPreparation } from "../ports/provider.js";
import type { CompactionWiring } from "./compact-boundary.js";
import { toolSpecs } from "./request.js";

/** Candidate cuts are priced through the same frozen presentation as the
 * actual send. An expanded canonical MCP catalog must not force a larger cut
 * than its compact wire table, and host context must reserve its real space. */
export function preparedCompaction(wiring: CompactionWiring, snapshot: ProviderRequestPreparation,
  base: ProviderRequest): CompactionWiring {
  return { ...wiring,
    estimatePromptTokens: messages => wiring.estimatePromptTokens(snapshot.apply({ ...base, messages }).messages),
    estimateOverheadTokens: tools => {
      const request = snapshot.apply({ ...base, tools: toolSpecs(tools) });
      return wiring.estimateRequestOverheadTokens?.(request) ?? wiring.estimateOverheadTokens?.(tools) ?? 0;
    },
  };
}
